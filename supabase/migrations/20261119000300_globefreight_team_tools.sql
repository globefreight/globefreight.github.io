begin;

create table primefreight_private.gf_exception_followup (
  shipment_id uuid primary key references public.pf_shipments(id) on delete cascade,
  event_id uuid not null references public.pf_events(id) on delete cascade,
  assigned_to uuid references auth.users(id) on delete set null,
  status text not null check (status in ('Open','In review','Handled')),
  note text not null check (length(note) <= 1000),
  updated_at timestamptz not null default clock_timestamp()
);
create table primefreight_private.gf_case_links (
  case_id uuid primary key references public.gf_complaints(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null
);
create table primefreight_private.gf_imports (
  actor uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  row_count int not null,
  primary key (actor,request_id)
);
alter table primefreight_private.gf_exception_followup enable row level security;
alter table primefreight_private.gf_case_links enable row level security;
alter table primefreight_private.gf_imports enable row level security;

alter table primefreight_private.gf_outbox add column case_token text;

create function primefreight_private.gf_create_case_link(target uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into primefreight_private.gf_case_links (case_id,token_hash,expires_at)
  values (target,sha256(convert_to(token,'UTF8')),now() + interval '60 days')
  on conflict (case_id) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at;
  return token;
end;
$$;

create or replace function primefreight_private.gf_queue_events() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'gf_complaints' then
    insert into primefreight_private.gf_outbox (recipient,subject,body,case_token)
    values (new.customer_email,'GlobeFreight Express received your complaint',
      'Our team received your complaint. Your reference is GF-' || upper(new.id::text) || '.',
      primefreight_private.gf_create_case_link(new.id));
  else
    insert into primefreight_private.gf_outbox (recipient,subject,body,tracking_code)
    select r.email,'GlobeFreight Express shipment update','Your shipment status is ' || new.status || '.',s.tracking_code
    from primefreight_private.gf_recipients r join public.pf_shipments s on s.id = r.shipment_id
    where r.shipment_id = new.shipment_id;
  end if;
  return null;
end;
$$;

create or replace function public.gf_finish_email(mail_id uuid, lease uuid, sent boolean, retry boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare reply uuid;
declare final_attempt boolean;
begin
  update primefreight_private.gf_outbox
  set finished = sent or not retry or attempts >= 5,
    ready_at = now() + interval '1 minute' * (attempts * attempts),
    claim = null,
    body = case when sent or not retry or attempts >= 5 then '' else body end,
    proof_token = case when sent or not retry or attempts >= 5 then null else proof_token end,
    case_token = case when sent or not retry or attempts >= 5 then null else case_token end
  where id = mail_id and claim = lease and not finished
  returning reply_id,finished into reply,final_attempt;
  if found and final_attempt and reply is not null then
    update public.gf_complaint_replies set delivery = case when sent then 'Accepted by email provider' else 'Failed' end
    where id = reply;
  end if;
end;
$$;

create function primefreight_private.gf_team_tools(op text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  admin boolean := primefreight_private.is_admin();
  target uuid;
  staff_id uuid;
  token text;
  latest_event uuid;
  stage text := payload->>'status';
  note_text text := coalesce(trim(payload->>'note'),'');
  staff_email text := nullif(lower(trim(payload->>'email')),'');
  customer_address text;
  row_data record;
  imported int;
  current_version timestamptz;
  requested_version timestamptz;
  batch_id uuid;
  start_at int := 0;
begin
  if op = 'case-status' then
    token := payload->>'token';
    if token is null or token !~ '^[0-9a-f]{64}$' then return null; end if;
    return (select jsonb_build_object('reference','GF-' || upper(c.id::text),'status',c.status,
        'received_at',c.received_at)
      from primefreight_private.gf_case_links l join public.gf_complaints c on c.id = l.case_id
      where l.token_hash = sha256(convert_to(token,'UTF8')) and l.expires_at > now());
  end if;

  if actor_id is null then raise exception 'Sign in to continue.' using errcode = '42501'; end if;
  if op = 'exception-list' then
    start_at := greatest(0,coalesce((payload->>'offset')::int,0));
    return coalesce((
      select jsonb_agg(to_jsonb(q) order by q.posted_at,q.id) from (
        select s.id,s.tracking_code,s.origin,s.destination,e.id as event_id,e.status as latest_status,e.posted_at,
          case when e.status = 'Exception' then 'Reported exception'
            when s.eta < (now() at time zone 'UTC')::date then 'Past estimated delivery'
            else 'No update in 48 hours' end as reason,
          case when f.event_id = e.id then f.status else 'Open' end as status,
          case when f.event_id = e.id then f.note else '' end as note,
          u.email as assigned_email,f.updated_at
        from public.pf_shipments s
        join lateral (select id,status,posted_at from public.pf_events where shipment_id = s.id
          order by posted_at desc,id desc limit 1) e on true
        left join primefreight_private.gf_exception_followup f on f.shipment_id = s.id
        left join auth.users u on u.id = f.assigned_to
        where (admin or (f.assigned_to = actor_id and primefreight_private.allowed(s.id,'view')))
          and e.status not in ('Delivered','Returned')
          and (e.status = 'Exception' or s.eta < (now() at time zone 'UTC')::date
            or e.posted_at <= now() - interval '48 hours')
        order by e.posted_at,s.id offset start_at limit 21
      ) q
    ),'[]'::jsonb);
  end if;

  if op = 'case-link' then
    target := (payload->>'id')::uuid;
    select customer_email into customer_address from public.gf_complaints
      where id = target and (admin or assigned_to = actor_id) for update;
    if not found then raise exception 'This complaint is unavailable.' using errcode = '42501'; end if;
    if exists (select 1 from primefreight_private.gf_case_links where case_id = target
        and expires_at > now() + interval '59 days 23 hours 55 minutes') then
      raise exception 'A status link was queued recently. Wait five minutes before sending another.' using errcode = '22023';
    end if;
    insert into primefreight_private.gf_outbox (recipient,subject,body,case_token)
    values (customer_address,'Check your GlobeFreight Express complaint',
      'Use your private link below to check your complaint status.',primefreight_private.gf_create_case_link(target));
    perform primefreight_private.gf_audit_action('Complaint status link queued',target);
    return null;
  end if;

  if op = 'exception-save' then
    target := (payload->>'id')::uuid;
    if stage is null or stage not in ('Open','In review','Handled') or length(note_text) > 1000 then
      raise exception 'Choose a follow-up status and a note up to 1,000 characters.' using errcode = '22023';
    end if;
    perform 1 from public.pf_shipments where id = target for update;
    if not found then raise exception 'Shipment unavailable.' using errcode = '42501'; end if;
    select f.assigned_to, f.updated_at into staff_id, current_version
      from primefreight_private.gf_exception_followup f where f.shipment_id = target;
    if not admin and (staff_id is distinct from actor_id or not primefreight_private.allowed(target,'view')) then
      raise exception 'You do not have access to follow up this exception.' using errcode = '42501';
    end if;
    requested_version := (payload->>'expected_update')::timestamptz;
    select e.id into latest_event from public.pf_events e where e.shipment_id = target order by e.posted_at desc,e.id desc limit 1;
    if latest_event is null or latest_event is distinct from (payload->>'event_id')::uuid
      or current_version is distinct from requested_version then
      raise exception 'This exception changed. Refresh before saving.' using errcode = '22023';
    end if;
    if admin then
      staff_id := null;
      if staff_email is not null then
        select id into staff_id from auth.users where lower(email) = staff_email and email_confirmed_at is not null;
        if staff_id is null or not exists (
          select 1 from primefreight_private.access a where a.shipment_id = target and a.user_id = staff_id
        ) or exists (select 1 from primefreight_private.admins a where a.user_id = staff_id) then
          raise exception 'Choose a confirmed staff account with access to this shipment.' using errcode = '22023';
        end if;
      end if;
    end if;
    insert into primefreight_private.gf_exception_followup (shipment_id,event_id,assigned_to,status,note)
    values (target,latest_event,staff_id,stage,note_text)
    on conflict (shipment_id) do update set event_id = excluded.event_id,assigned_to = excluded.assigned_to,
      status = excluded.status,note = excluded.note,updated_at = clock_timestamp();
    perform primefreight_private.gf_audit_action('Exception follow-up: ' || stage,target);
    return null;
  end if;

  if op = 'import' then
    if not admin then raise exception 'Administrator access required.' using errcode = '42501'; end if;
    batch_id := (payload->>'request_id')::uuid;
    if batch_id is null or jsonb_typeof(payload->'rows') is distinct from 'array' then
      raise exception 'Supply a valid import batch.' using errcode = '22023';
    end if;
    imported := jsonb_array_length(payload->'rows');
    if imported not between 1 and 100 then raise exception 'Import between 1 and 100 shipments.' using errcode = '22023'; end if;
    insert into primefreight_private.gf_imports (actor,request_id,row_count)
    values (actor_id,batch_id,imported) on conflict do nothing;
    if not found then return (select to_jsonb(row_count) from primefreight_private.gf_imports
      where actor = actor_id and request_id = batch_id); end if;
    for row_data in select * from jsonb_to_recordset(payload->'rows')
      as r(origin text,destination text,service text,eta text,internal_reference text)
    loop
      insert into public.pf_shipments (origin,destination,service,eta,internal_reference)
      values (trim(row_data.origin),trim(row_data.destination),row_data.service,
        nullif(trim(row_data.eta),'')::date,coalesce(trim(row_data.internal_reference),''));
    end loop;
    perform primefreight_private.gf_audit_action('CSV import: ' || imported || ' shipments',batch_id);
    return to_jsonb(imported);
  end if;
  raise exception 'Unknown operation.' using errcode = '22023';
end;
$$;

create function public.gf_team_tools(op text,payload jsonb) returns jsonb
language sql set search_path = '' as $$ select primefreight_private.gf_team_tools($1,$2); $$;
revoke all on function primefreight_private.gf_create_case_link(uuid),primefreight_private.gf_team_tools(text,jsonb),
  public.gf_team_tools(text,jsonb) from public,anon,authenticated;
grant execute on function primefreight_private.gf_team_tools(text,jsonb),public.gf_team_tools(text,jsonb) to anon,authenticated;

commit;
