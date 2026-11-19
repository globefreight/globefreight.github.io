begin;

alter table public.pf_shipments drop constraint pf_shipments_origin_check,
  drop constraint pf_shipments_destination_check,
  add constraint pf_shipments_origin_check check (length(trim(origin)) between 1 and 120),
  add constraint pf_shipments_destination_check check (length(trim(destination)) between 1 and 120);
alter table public.pf_events drop constraint pf_events_location_check,
  add constraint pf_events_location_check check (length(location) <= 120);

create table primefreight_private.gf_quote_offers (
  quote_id uuid primary key references public.gf_quotes(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency in ('USD','NGN','GBP','EUR','CAD')),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  shipment_id uuid unique references public.pf_shipments(id) on delete set null
);
create table primefreight_private.gf_shipment_links (
  shipment_id uuid primary key references primefreight_private.gf_recipients(shipment_id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null
);
create table primefreight_private.gf_pickups (
  shipment_id uuid primary key references public.pf_shipments(id) on delete cascade,
  starts_at timestamptz,
  ends_at timestamptz,
  state text check (state in ('Requested','Confirmed','Change requested','Cancelled')),
  check ((starts_at is null and ends_at is null and state is null)
    or (starts_at is not null and ends_at is not null and state is not null and ends_at > starts_at)),
  directions text not null default '' check (length(directions) <= 1000),
  alternate_contact text not null default '' check (length(alternate_contact) <= 150),
  updated_at timestamptz not null default clock_timestamp()
);
create table primefreight_private.gf_digest_days (business_date date primary key);
alter table primefreight_private.gf_quote_offers enable row level security;
alter table primefreight_private.gf_shipment_links enable row level security;
alter table primefreight_private.gf_pickups enable row level security;
alter table primefreight_private.gf_digest_days enable row level security;

alter table primefreight_private.gf_outbox add column action_kind text
  check (action_kind in ('quote','shipment'));
alter table primefreight_private.gf_outbox add column action_token text;
alter table primefreight_private.gf_outbox add column action_record uuid;

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
    case_token = case when sent or not retry or attempts >= 5 then null else case_token end,
    action_token = case when sent or not retry or attempts >= 5 then null else action_token end
  where id = mail_id and claim = lease and not finished
  returning reply_id,finished into reply,final_attempt;
  if found and final_attempt and reply is not null then
    update public.gf_complaint_replies set delivery = case when sent then 'Accepted by email provider' else 'Failed' end
    where id = reply;
  end if;
end;
$$;

create function primefreight_private.gf_send_shipment_link(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  token text := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
  address text;
  code text;
begin
  select r.email,s.tracking_code into address,code
  from primefreight_private.gf_recipients r join public.pf_shipments s on s.id = r.shipment_id
  where r.shipment_id = target for update of r;
  if not found then
    raise exception 'Set the confirmed shipment recipient email first.' using errcode = '22023';
  end if;
  insert into primefreight_private.gf_shipment_links (shipment_id,token_hash,expires_at)
  values (target,sha256(convert_to(token,'UTF8')),now() + interval '30 days')
  on conflict (shipment_id) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at;
  delete from primefreight_private.gf_outbox where tracking_code = code and action_kind = 'shipment' and not finished;
  insert into primefreight_private.gf_outbox (recipient,subject,body,tracking_code,action_kind,action_token)
  values (address,'Manage your GlobeFreight Express shipment','Use the private link to request a pickup or securely share delivery instructions.',code,'shipment',token);
end;
$$;

create function primefreight_private.gf_recipient_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from primefreight_private.gf_pickups where shipment_id = old.shipment_id;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.email is not distinct from new.email then return new; end if;
    delete from primefreight_private.gf_pickups where shipment_id = old.shipment_id;
    delete from primefreight_private.gf_shipment_links where shipment_id = old.shipment_id;
  end if;
  perform primefreight_private.gf_send_shipment_link(new.shipment_id);
  return new;
end;
$$;
create trigger gf_protect_pickup_contact after insert or update or delete on primefreight_private.gf_recipients
for each row execute function primefreight_private.gf_recipient_changed();

create function primefreight_private.gf_pickup_view(target uuid, private_view boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('starts_at',starts_at,'ends_at',ends_at,'state',state,'updated_at',updated_at) ||
    case when private_view then jsonb_build_object('directions',directions,'alternate_contact',alternate_contact)
      else '{}'::jsonb end
  from primefreight_private.gf_pickups where shipment_id = target;
$$;

create or replace function primefreight_private.track(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tracking_code',s.tracking_code,'origin',s.origin,'destination',s.destination,'service',s.service,'eta',s.eta,
    'pickup',(select jsonb_build_object('starts_at',p.starts_at,'ends_at',p.ends_at)
      from primefreight_private.gf_pickups p where p.shipment_id = s.id and p.state = 'Confirmed'),
    'events',coalesce((select jsonb_agg(jsonb_build_object('status',e.status,'location',e.location,
      'note',e.note,'posted_at',e.posted_at) order by e.posted_at desc,e.id desc)
      from public.pf_events e where e.shipment_id = s.id),'[]'::jsonb)
  ) from public.pf_shipments s where s.tracking_code = upper(trim(code));
$$;

create function primefreight_private.gf_booking(op text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
  result uuid;
  token text := payload->>'token';
  hash bytea;
  offer primefreight_private.gf_quote_offers%rowtype;
  quote_row public.gf_quotes%rowtype;
  shipment public.pf_shipments%rowtype;
  pickup primefreight_private.gf_pickups%rowtype;
  price numeric;
  denomination text := payload->>'currency';
  deadline timestamptz;
  start_time timestamptz;
  end_time timestamptz;
  delivery_note text := coalesce(trim(payload->>'directions'),'');
  alternate text := coalesce(trim(payload->>'alternate_contact'),'');
  next_state text := payload->>'state';
  latest_status text;
begin
  if op in ('quote-link','accept-quote','shipment-link','pickup-request','delivery-note') then
    if token is null or token !~ '^[0-9a-f]{64}$' then return null; end if;
    hash := sha256(convert_to(token,'UTF8'));
  end if;

  if op in ('quote-link','accept-quote') then
    select quote_id into target from primefreight_private.gf_quote_offers where token_hash = hash;
    if target is null then return null; end if;
    select * into quote_row from public.gf_quotes where id = target for update;
    select * into offer from primefreight_private.gf_quote_offers where quote_id = target and token_hash = hash;
    if not found or (offer.accepted_at is null and offer.expires_at <= now())
       or (offer.accepted_at is null and quote_row.status = 'Closed')
       or offer.accepted_at <= now() - interval '30 days' then return null; end if;
    if op = 'accept-quote' and offer.accepted_at is null then
      update primefreight_private.gf_quote_offers set accepted_at = now() where quote_id = target returning * into offer;
      perform primefreight_private.gf_audit_action('Quote accepted by customer',target);
    end if;
    return jsonb_build_object('reference','GFQ-' || upper(target::text),'amount',offer.amount,'currency',offer.currency,
      'expires_at',offer.expires_at,'accepted_at',offer.accepted_at,
      'tracking_code',(select tracking_code from public.pf_shipments where id = offer.shipment_id),
      'origin',quote_row.origin,'destination',quote_row.destination,'service',quote_row.service);
  end if;

  if op in ('shipment-link','pickup-request','delivery-note') then
    select shipment_id into target from primefreight_private.gf_shipment_links where token_hash = hash and expires_at > now();
    if target is null then return null; end if;
    select * into shipment from public.pf_shipments where id = target for update;
    if not found or not exists(select 1 from primefreight_private.gf_shipment_links
      where shipment_id = target and token_hash = hash and expires_at > now()) then return null; end if;
    select status into latest_status from public.pf_events where shipment_id = target order by posted_at desc,id desc limit 1;
    select * into pickup from primefreight_private.gf_pickups where shipment_id = target;
    if op = 'pickup-request' then
      if latest_status is distinct from 'Label created' or pickup.state = 'Confirmed' then
        raise exception 'Pickup changes for this shipment require staff assistance.' using errcode = '22023';
      end if;
      start_time := (payload->>'starts_at')::timestamptz;
      end_time := (payload->>'ends_at')::timestamptz;
      if start_time is null or end_time is null or start_time <= now() or start_time > now() + interval '90 days'
        or end_time <= start_time or end_time - start_time > interval '12 hours' then
        raise exception 'Choose a future pickup window within 90 days, up to 12 hours long.' using errcode = '22023';
      end if;
      insert into primefreight_private.gf_pickups (shipment_id,starts_at,ends_at,state)
      values (target,start_time,end_time,'Requested')
      on conflict (shipment_id) do update set starts_at = excluded.starts_at,ends_at = excluded.ends_at,
        state = excluded.state,updated_at = clock_timestamp();
      perform primefreight_private.gf_audit_action('Pickup requested by customer',target);
    elsif op = 'delivery-note' then
      if latest_status in ('Delivered','Returned') or length(delivery_note) > 1000 or length(alternate) > 150 then
        raise exception 'Delivery instructions are unavailable or exceed the field limits.' using errcode = '22023';
      end if;
      insert into primefreight_private.gf_pickups (shipment_id,directions,alternate_contact)
      values (target,delivery_note,alternate)
      on conflict (shipment_id) do update set directions = excluded.directions,alternate_contact = excluded.alternate_contact,
        updated_at = clock_timestamp();
      perform primefreight_private.gf_audit_action('Delivery instructions updated by customer',target);
    end if;
    select * into pickup from primefreight_private.gf_pickups where shipment_id = target;
    return jsonb_build_object('tracking_code',shipment.tracking_code,'origin',shipment.origin,'destination',shipment.destination,
      'may_request',coalesce(latest_status = 'Label created',false) and pickup.state is distinct from 'Confirmed',
      'may_instruct',coalesce(latest_status not in ('Delivered','Returned'),false),
      'pickup',primefreight_private.gf_pickup_view(target,true));
  end if;

  if auth.uid() is null then raise exception 'Sign in to continue.' using errcode = '42501'; end if;
  if op = 'pickup-list' then
    return coalesce((
      select jsonb_agg(to_jsonb(q) order by q.starts_at,q.id) from (
        select s.id,s.origin,s.destination,s.tracking_code,p.starts_at,p.ends_at
        from primefreight_private.gf_pickups p join public.pf_shipments s on s.id = p.shipment_id
        where p.state = 'Requested' and primefreight_private.allowed(s.id,'view')
          and (select status from public.pf_events where shipment_id = s.id order by posted_at desc,id desc limit 1) = 'Label created'
        order by p.starts_at,s.id offset greatest(0,coalesce((payload->>'offset')::int,0)) limit 21
      ) q
    ),'[]'::jsonb);
  end if;
  target := (payload->>'id')::uuid;
  if op in ('offer-details','send-offer','book-quote') then
    if not primefreight_private.is_admin() then raise exception 'Administrator access required.' using errcode = '42501'; end if;
    select * into quote_row from public.gf_quotes where id = target for update;
    if not found then raise exception 'Quote unavailable.' using errcode = '22023'; end if;
    select * into offer from primefreight_private.gf_quote_offers where quote_id = target;
    if op = 'send-offer' then
      if offer.accepted_at is not null or quote_row.status = 'Closed' then
        raise exception 'Accepted or closed quotes cannot be replaced.' using errcode = '22023';
      end if;
      price := (payload->>'amount')::numeric;
      deadline := (payload->>'expires_at')::timestamptz;
      if price is null or not (price > 0 and price <= 999999999.99) or price <> round(price,2)
        or denomination is null or denomination not in ('USD','NGN','GBP','EUR','CAD')
        or deadline is null or deadline <= now() or deadline > now() + interval '90 days' then
        raise exception 'Choose a valid price, currency, and expiry within 90 days.' using errcode = '22023';
      end if;
      token := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
      insert into primefreight_private.gf_quote_offers (quote_id,amount,currency,token_hash,expires_at)
      values (target,price,denomination,sha256(convert_to(token,'UTF8')),deadline)
      on conflict (quote_id) do update set amount = excluded.amount,currency = excluded.currency,
        token_hash = excluded.token_hash,expires_at = excluded.expires_at;
      update public.gf_quotes set status = 'Quoted' where id = target;
      delete from primefreight_private.gf_outbox where action_kind = 'quote' and action_record = target and not finished;
      insert into primefreight_private.gf_outbox (recipient,subject,body,action_kind,action_token,action_record)
      values (quote_row.email,'Review your GlobeFreight Express quote',
        'Your freight quote is ' || denomination || ' ' || price::text || '. Review the details and accept the quote using the private link below.',
        'quote',token,target);
      perform primefreight_private.gf_audit_action('Quote offer queued',target);
    elsif op = 'book-quote' then
      if offer.shipment_id is not null then return to_jsonb(offer.shipment_id); end if;
      if offer.accepted_at is null then raise exception 'The customer must accept the quote first.' using errcode = '22023'; end if;
      insert into public.pf_shipments (origin,destination,service,internal_reference)
      values (quote_row.origin,quote_row.destination,quote_row.service,'GFQ-' || upper(target::text)) returning id into result;
      update primefreight_private.gf_quote_offers set shipment_id = result where quote_id = target;
      update public.gf_quotes set status = 'Closed' where id = target;
      perform primefreight_private.gf_operations('set-recipient',jsonb_build_object('id',result,'email',quote_row.email));
      perform primefreight_private.gf_audit_action('Accepted quote booked',target);
      return to_jsonb(result);
    end if;
    return (select to_jsonb(o) - 'token_hash' from primefreight_private.gf_quote_offers o where o.quote_id = target);
  end if;

  if op in ('shipment-details','send-shipment-link','pickup-review') then
    select * into shipment from public.pf_shipments where id = target for update;
    if not found or not primefreight_private.allowed(target,'view') then
      raise exception 'Shipment unavailable.' using errcode = '42501';
    end if;
    if op = 'send-shipment-link' then
      if not primefreight_private.is_admin() then raise exception 'Administrator access required.' using errcode = '42501'; end if;
      perform primefreight_private.gf_send_shipment_link(target);
      perform primefreight_private.gf_audit_action('Private shipment link queued',target);
    elsif op = 'pickup-review' then
      if not (primefreight_private.allowed(target,'edit') or primefreight_private.allowed(target,'post')) then
        raise exception 'You do not have permission to manage pickup.' using errcode = '42501';
      end if;
      select * into pickup from primefreight_private.gf_pickups where shipment_id = target;
      select status into latest_status from public.pf_events where shipment_id = target order by posted_at desc,id desc limit 1;
      if pickup.state is null or pickup.updated_at is distinct from (payload->>'expected_update')::timestamptz
        or latest_status is distinct from 'Label created' then
        raise exception 'This request changed or pickup has already occurred. Refresh before updating it.' using errcode = '22023';
      end if;
      if next_state is null or next_state not in ('Confirmed','Change requested','Cancelled')
        or (next_state = 'Confirmed' and pickup.starts_at <= now()) then
        raise exception 'Choose a valid decision for the requested pickup window.' using errcode = '22023';
      end if;
      if pickup.state is distinct from next_state then
        update primefreight_private.gf_pickups set state = next_state,updated_at = clock_timestamp() where shipment_id = target;
        insert into primefreight_private.gf_outbox (recipient,subject,body,tracking_code)
        select r.email,'GlobeFreight Express pickup update',
          case next_state when 'Confirmed' then 'Your pickup window is confirmed. See the tracking page for the scheduled time.'
            when 'Change requested' then 'Please open your private shipment link to propose a new pickup window.'
            else 'Your pickup request was cancelled. Open your private shipment link to submit a new request.' end,
          shipment.tracking_code
        from primefreight_private.gf_recipients r where r.shipment_id = target;
        perform primefreight_private.gf_audit_action('Pickup: ' || next_state,target);
      end if;
    end if;
    select status into latest_status from public.pf_events where shipment_id = target order by posted_at desc,id desc limit 1;
    return primefreight_private.gf_pickup_view(target,true) ||
      jsonb_build_object('may_review',latest_status = 'Label created');
  end if;
  raise exception 'Unknown operation.' using errcode = '22023';
end;
$$;

create function public.gf_booking(op text,payload jsonb) returns jsonb
language sql set search_path = '' as $$ select primefreight_private.gf_booking($1,$2); $$;

create function public.gf_queue_daily_digest(address text, zone text, start_hour int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  local_now timestamp;
  business_day date;
  overdue int;
  complaints int;
  quotes int;
  pickups int;
begin
  if address is null or length(address) > 254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or zone is null or start_hour is null or start_hour not between 0 and 23 then return false; end if;
  if not exists (select 1 from primefreight_private.admins a join auth.users u on u.id = a.user_id
    where lower(u.email) = lower(trim(address)) and u.email_confirmed_at is not null) then
    raise exception 'Set the daily digest recipient to a confirmed administrator email.' using errcode = '22023';
  end if;
  local_now := now() at time zone zone;
  business_day := local_now::date;
  if extract(hour from local_now) < start_hour then return false; end if;
  insert into primefreight_private.gf_digest_days values (business_day) on conflict do nothing;
  if not found then return false; end if;
  select count(*) into overdue from public.pf_shipments s
    where s.eta < business_day and (select status from public.pf_events where shipment_id = s.id
      order by posted_at desc,id desc limit 1) not in ('Delivered','Returned');
  select count(*) into complaints from public.gf_complaints where status <> 'Resolved';
  select count(*) into quotes from public.gf_quotes q left join primefreight_private.gf_quote_offers o on o.quote_id = q.id
    where q.status <> 'Closed' and (o.quote_id is null or o.accepted_at is not null or o.expires_at <= now());
  select count(*) into pickups from primefreight_private.gf_pickups where state = 'Requested';
  insert into primefreight_private.gf_outbox (recipient,subject,body)
  values (address,'GlobeFreight Express daily operations summary',
    'Operations summary for ' || business_day || E'\n\nOverdue shipments: ' || overdue ||
    E'\nUnresolved complaints: ' || complaints || E'\nQuotes awaiting action: ' || quotes ||
    E'\nPickup requests awaiting review: ' || pickups);
  return true;
end;
$$;

revoke all on function primefreight_private.gf_send_shipment_link(uuid),primefreight_private.gf_recipient_changed(),
  primefreight_private.gf_pickup_view(uuid,boolean),primefreight_private.gf_booking(text,jsonb),
  public.gf_booking(text,jsonb),public.gf_queue_daily_digest(text,text,int) from public,anon,authenticated;
grant execute on function primefreight_private.gf_booking(text,jsonb),public.gf_booking(text,jsonb) to anon,authenticated;
grant execute on function public.gf_queue_daily_digest(text,text,int) to service_role;

commit;
