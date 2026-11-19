begin;

create table public.gf_quotes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  origin text not null,
  destination text not null,
  weight_kg numeric not null check (weight_kg > 0 and weight_kg <= 100000),
  length_cm numeric not null check (length_cm > 0 and length_cm <= 20000),
  width_cm numeric not null check (width_cm > 0 and width_cm <= 20000),
  height_cm numeric not null check (height_cm > 0 and height_cm <= 20000),
  service text not null check (service in ('Express', 'Air Freight', 'Ocean Freight', 'Road Freight')),
  status text not null default 'New' check (status in ('New', 'In review', 'Quoted', 'Closed')),
  note text not null default '' check (length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index gf_quote_email_date on public.gf_quotes (email, created_at desc);
create index gf_quote_date on public.gf_quotes (created_at desc, id desc);

create table public.gf_audit (
  id uuid primary key default gen_random_uuid(),
  actor_email text,
  action text not null,
  record_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create index gf_audit_date on public.gf_audit (created_at desc, id desc);

create table public.gf_complaint_replies (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.gf_complaints(id) on delete cascade,
  body text not null check (length(body) between 1 and 2000),
  delivery text not null default 'Queued' check (delivery in ('Queued', 'Accepted by email provider', 'Failed')),
  created_at timestamptz not null default clock_timestamp()
);
create index gf_replies_case on public.gf_complaint_replies (case_id, created_at desc);

create table primefreight_private.gf_recipients (
  shipment_id uuid primary key references public.pf_shipments(id) on delete cascade,
  email text not null
);
create table primefreight_private.gf_proofs (
  shipment_id uuid primary key references public.pf_shipments(id) on delete cascade,
  mime text not null check (mime in ('application/pdf','image/png','image/jpeg')),
  contents bytea not null check (octet_length(contents) between 8 and 2097152),
  token_hash bytea unique not null,
  expires_at timestamptz not null
);
create table primefreight_private.gf_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient text not null,
  subject text not null,
  body text not null,
  tracking_code text,
  proof_token text,
  reply_id uuid references public.gf_complaint_replies(id) on delete set null,
  ready_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  claim uuid,
  attempts int not null default 0,
  finished boolean not null default false
);
create index gf_pending_email on primefreight_private.gf_outbox (ready_at) where not finished;

alter table public.gf_quotes enable row level security;
alter table public.gf_audit enable row level security;
alter table public.gf_complaint_replies enable row level security;
alter table primefreight_private.gf_recipients enable row level security;
alter table primefreight_private.gf_proofs enable row level security;
alter table primefreight_private.gf_outbox enable row level security;
revoke all on public.gf_quotes, public.gf_audit, public.gf_complaint_replies from public, anon, authenticated;
grant select on public.gf_quotes, public.gf_audit, public.gf_complaint_replies to authenticated;
grant update (status, note) on public.gf_quotes to authenticated;

create policy gf_quote_read on public.gf_quotes for select to authenticated using ((select primefreight_private.is_admin()));
create policy gf_quote_update on public.gf_quotes for update to authenticated
  using ((select primefreight_private.is_admin())) with check ((select primefreight_private.is_admin()));
create policy gf_audit_read on public.gf_audit for select to authenticated using ((select primefreight_private.is_admin()));
create policy gf_reply_read on public.gf_complaint_replies for select to authenticated using (
  exists (select 1 from public.gf_complaints c where c.id = case_id)
);

create function primefreight_private.gf_audit_action(event_name text, target uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.gf_audit (actor_email, action, record_id)
  values ((select email from auth.users where id = auth.uid()), event_name, target);
$$;

create function primefreight_private.gf_audit_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'pf_events' then
    perform primefreight_private.gf_audit_action('Tracking update: ' || new.status, new.shipment_id);
  elsif tg_table_name = 'pf_shipments' then
    perform primefreight_private.gf_audit_action(case when tg_op = 'INSERT' then 'Shipment created' else 'Shipment updated' end, new.id);
  elsif tg_table_name = 'access' then
    if tg_op = 'DELETE' then
      perform primefreight_private.gf_audit_action('Shipment access revoked', old.shipment_id);
    else
      perform primefreight_private.gf_audit_action('Shipment access saved', new.shipment_id);
    end if;
  elsif tg_table_name = 'gf_complaints' then
    if old.assigned_to is distinct from new.assigned_to then
      perform primefreight_private.gf_audit_action('Complaint assignment changed', new.id);
    end if;
    if old.status is distinct from new.status then
      perform primefreight_private.gf_audit_action('Complaint status: ' || new.status, new.id);
    end if;
    if old.internal_note is distinct from new.internal_note then
      perform primefreight_private.gf_audit_action('Complaint note updated', new.id);
    end if;
  elsif tg_table_name = 'gf_quotes' then
    if old.status is distinct from new.status or old.note is distinct from new.note then
      perform primefreight_private.gf_audit_action('Quote updated: ' || new.status, new.id);
    end if;
  end if;
  return null;
end;
$$;
create trigger gf_audit_shipments after insert or update on public.pf_shipments
  for each row execute function primefreight_private.gf_audit_trigger();
create trigger gf_audit_events after insert on public.pf_events
  for each row execute function primefreight_private.gf_audit_trigger();
create trigger gf_audit_access after insert or update or delete on primefreight_private.access
  for each row execute function primefreight_private.gf_audit_trigger();
create trigger gf_audit_cases after update on public.gf_complaints
  for each row execute function primefreight_private.gf_audit_trigger();
create function primefreight_private.gf_touch_quote() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger gf_touch_quote before update on public.gf_quotes
  for each row execute function primefreight_private.gf_touch_quote();
create trigger gf_audit_quotes after update on public.gf_quotes
  for each row execute function primefreight_private.gf_audit_trigger();

create function primefreight_private.gf_queue_events() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'gf_complaints' then
    insert into primefreight_private.gf_outbox (recipient, subject, body)
    values (new.customer_email, 'GlobeFreight Express received your complaint',
      'Our team received your complaint. Your reference is GF-' || upper(new.id::text) || '.');
  else
    insert into primefreight_private.gf_outbox (recipient, subject, body, tracking_code)
    select r.email, 'GlobeFreight Express shipment update', 'Your shipment status is ' || new.status || '.', s.tracking_code
    from primefreight_private.gf_recipients r join public.pf_shipments s on s.id = r.shipment_id
    where r.shipment_id = new.shipment_id;
  end if;
  return null;
end;
$$;
create trigger gf_email_received after insert on public.gf_complaints
  for each row execute function primefreight_private.gf_queue_events();
create trigger gf_email_tracking after insert on public.pf_events
  for each row execute function primefreight_private.gf_queue_events();

create function primefreight_private.gf_operations(op text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
  result_id uuid;
  address text := nullif(lower(trim(payload->>'email')), '');
  message_text text := trim(payload->>'message');
  shipment_code text;
  case_row public.gf_complaints%rowtype;
  token text;
  bytes bytea;
  file_mime text := payload->>'mime';
begin
  if op = 'quote' then
    if address is null or length(address) > 254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
       or coalesce(length(trim(payload->>'origin')), 0) not between 1 and 120
       or coalesce(length(trim(payload->>'destination')), 0) not between 1 and 120 then
      raise exception 'Check the route and email address.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('gf-quotes:' || address, 0));
    select id into result_id from public.gf_quotes
    where email = address and created_at >= now() - interval '5 minutes'
      and origin = trim(payload->>'origin') and destination = trim(payload->>'destination')
      and weight_kg = (payload->>'weight_kg')::numeric and length_cm = (payload->>'length_cm')::numeric
      and width_cm = (payload->>'width_cm')::numeric and height_cm = (payload->>'height_cm')::numeric
      and service = payload->>'service'
    order by created_at desc limit 1;
    if result_id is not null then return to_jsonb(result_id); end if;
    if (select count(*) from public.gf_quotes where email = address and created_at >= now() - interval '1 hour') >= 5 then
      raise exception 'Too many recent requests. Try again later.' using errcode = '22023';
    end if;
    insert into public.gf_quotes (email,origin,destination,weight_kg,length_cm,width_cm,height_cm,service)
    values (address, trim(payload->>'origin'), trim(payload->>'destination'), (payload->>'weight_kg')::numeric,
      (payload->>'length_cm')::numeric, (payload->>'width_cm')::numeric, (payload->>'height_cm')::numeric, payload->>'service')
    returning id into result_id;
    return to_jsonb(result_id);
  end if;

  if op = 'download' then
    token := payload->>'token';
    if token is null or token !~ '^[0-9a-f]{64}$' then return null; end if;
    return (select jsonb_build_object('mime',mime, 'data',encode(contents,'base64')) from primefreight_private.gf_proofs
      where token_hash = sha256(convert_to(token,'UTF8')) and expires_at > now());
  end if;

  if auth.uid() is null then raise exception 'Sign in to continue.' using errcode = '42501'; end if;
  target := (payload->>'id')::uuid;
  if op = 'reply' then
    select * into case_row from public.gf_complaints
    where id = target and (assigned_to = auth.uid() or primefreight_private.is_admin()) for update;
    if not found then raise exception 'This complaint is unavailable.' using errcode = '42501'; end if;
    if coalesce(length(message_text), 0) not between 1 and 2000 then
      raise exception 'Enter a reply of 1 to 2000 characters.' using errcode = '22023';
    end if;
    select id into result_id from public.gf_complaint_replies
    where case_id = target and body = message_text and created_at >= now() - interval '5 minutes'
    order by created_at desc limit 1;
    if result_id is not null then return to_jsonb(result_id); end if;
    insert into public.gf_complaint_replies (case_id,body) values (target,message_text) returning id into result_id;
    insert into primefreight_private.gf_outbox (recipient,subject,body,reply_id)
    values (case_row.customer_email, 'GlobeFreight Express complaint update',
      'Case GF-' || upper(target::text) || E'\n\n' || message_text, result_id);
    perform primefreight_private.gf_audit_action('Complaint reply queued',target);
    return to_jsonb(result_id);
  end if;

  if op = 'recipient' or op = 'set-recipient' then
    if not primefreight_private.is_admin() then raise exception 'Administrator access required.' using errcode = '42501'; end if;
    if op = 'recipient' then
      return (select to_jsonb(email) from primefreight_private.gf_recipients where shipment_id = target);
    end if;
    select tracking_code into shipment_code from public.pf_shipments where id = target for update;
    if not found then raise exception 'Shipment unavailable.' using errcode = '22023'; end if;
    if address is not distinct from (select email from primefreight_private.gf_recipients where shipment_id = target) then return null; end if;
    if address is null then
      delete from primefreight_private.gf_recipients where shipment_id = target;
    else
      if length(address) > 254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
        raise exception 'Enter a valid recipient email.' using errcode = '22023';
      end if;
      insert into primefreight_private.gf_recipients (shipment_id,email) values (target,address)
      on conflict (shipment_id) do update set email = excluded.email;
      insert into primefreight_private.gf_outbox (recipient,subject,body,tracking_code)
      values (address,'Track your GlobeFreight Express shipment','Use the link below to follow your shipment.',shipment_code);
    end if;
    -- A previous recipient's queued shipment mail and delivery link must not survive reassignment.
    delete from primefreight_private.gf_outbox
      where tracking_code = shipment_code and not finished and recipient is distinct from address;
    delete from primefreight_private.gf_proofs where shipment_id = target;
    perform primefreight_private.gf_audit_action('Shipment email recipient changed',target);
    return null;
  end if;

  if op = 'proof' then
    select tracking_code into shipment_code from public.pf_shipments where id = target for update;
    if not found or not primefreight_private.allowed(target,'post') then
      raise exception 'Permission to post tracking updates is required.' using errcode = '42501';
    end if;
    if (select status from public.pf_events where shipment_id = target order by posted_at desc,id desc limit 1)
      is distinct from 'Delivered' then
      raise exception 'Record the shipment as delivered before attaching proof.' using errcode = '22023';
    end if;
    select email into address from primefreight_private.gf_recipients where shipment_id = target;
    if address is null then raise exception 'An administrator must set a recipient email first.' using errcode = '22023'; end if;
    if coalesce(length(payload->>'data'),0) not between 12 and 2796204 then
      raise exception 'Choose a PDF, PNG or JPEG under 2 MB.' using errcode = '22023';
    end if;
    bytes := decode(payload->>'data','base64');
    if not coalesce((file_mime = 'application/pdf' and substring(bytes from 1 for 5) = decode('255044462d','hex'))
      or (file_mime = 'image/png' and substring(bytes from 1 for 8) = decode('89504e470d0a1a0a','hex'))
      or (file_mime = 'image/jpeg' and substring(bytes from 1 for 3) = decode('ffd8ff','hex')),false) then
      raise exception 'The file must match its PDF, PNG or JPEG format.' using errcode = '22023';
    end if;

    token := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
    insert into primefreight_private.gf_proofs (shipment_id,mime,contents,token_hash,expires_at)
    values (target,file_mime,bytes,sha256(convert_to(token,'UTF8')),now() + interval '7 days')
    on conflict (shipment_id) do update set mime = excluded.mime, contents = excluded.contents,
      token_hash = excluded.token_hash, expires_at = excluded.expires_at;
    delete from primefreight_private.gf_outbox where tracking_code = shipment_code and proof_token is not null and not finished;
    insert into primefreight_private.gf_outbox (recipient,subject,body,tracking_code,proof_token)
    values (address,'GlobeFreight Express proof of delivery','Your delivery document link expires seven days after upload.',shipment_code,token);
    perform primefreight_private.gf_audit_action('Proof of delivery uploaded',target);
    return null;
  end if;
  raise exception 'Unknown operation.' using errcode = '22023';
end;
$$;

create function public.gf_operations(op text,payload jsonb) returns jsonb
language sql set search_path = '' as $$ select primefreight_private.gf_operations($1,$2); $$;

create function public.gf_claim_email() returns setof primefreight_private.gf_outbox
language sql security definer set search_path = '' as $$
  update primefreight_private.gf_outbox set claim = gen_random_uuid(), attempts = attempts + 1,
    ready_at = now() + interval '3 minutes'
  where id in (select id from primefreight_private.gf_outbox
    where not finished and ready_at <= now()
    order by ready_at,id limit 5 for update skip locked)
  returning *;
$$;
create function public.gf_finish_email(mail_id uuid, lease uuid, sent boolean, retry boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare reply uuid;
declare final_attempt boolean;
begin
  update primefreight_private.gf_outbox
  set finished = sent or not retry or attempts >= 5,
    ready_at = now() + interval '1 minute' * (attempts * attempts),
    claim = null,
    body = case when sent or not retry or attempts >= 5 then '' else body end,
    proof_token = case when sent or not retry or attempts >= 5 then null else proof_token end
  where id = mail_id and claim = lease and not finished
  returning reply_id,finished into reply,final_attempt;
  if found and final_attempt and reply is not null then
    update public.gf_complaint_replies set delivery = case when sent then 'Accepted by email provider' else 'Failed' end
    where id = reply;
  end if;
end;
$$;

revoke all on function primefreight_private.gf_audit_action(text,uuid), primefreight_private.gf_audit_trigger(),
  primefreight_private.gf_queue_events(), primefreight_private.gf_touch_quote(), primefreight_private.gf_operations(text,jsonb),
  public.gf_operations(text,jsonb), public.gf_claim_email(), public.gf_finish_email(uuid,uuid,boolean,boolean)
  from public, anon, authenticated;
grant execute on function primefreight_private.gf_operations(text,jsonb), public.gf_operations(text,jsonb) to anon, authenticated;
grant execute on function public.gf_claim_email(), public.gf_finish_email(uuid,uuid,boolean,boolean) to service_role;

commit;
