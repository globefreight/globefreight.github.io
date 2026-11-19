begin;

create table primefreight_private.gf_shipment_addresses (
  shipment_id uuid primary key references public.pf_shipments(id) on delete cascade,
  origin jsonb,
  destination jsonb,
  create_request uuid unique
);
alter table primefreight_private.gf_shipment_addresses enable row level security;

create function primefreight_private.gf_clean_address(input jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  code text := upper(trim(input->>'country_code'));
  country text := trim(input->>'country');
  city text := trim(input->>'city');
  region text := coalesce(trim(input->>'region'),'');
  street text := trim(input->>'street');
  unit text := coalesce(trim(input->>'unit'),'');
  postal text := coalesce(trim(input->>'postal_code'),'');
begin
  if input is null or input = 'null'::jsonb then return null; end if;
  if code is null or code !~ '^[A-Z]{2}$' or coalesce(length(country),0) not between 1 and 100
    or coalesce(length(city),0) not between 1 and 100 or length(region) > 100
    or coalesce(length(street),0) not between 1 and 200 or length(unit) > 80 or length(postal) > 24 then
    raise exception 'Check the country, city, street, and other address fields.' using errcode = '22023';
  end if;
  return jsonb_build_object('country_code',code,'country',country,'region',region,'city',city,
    'street',street,'unit',unit,'postal_code',postal);
end;
$$;

create function primefreight_private.gf_address_label(value jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when value is null then null
    when length(concat_ws(', ',value->>'city',nullif(value->>'region',''),value->>'country')) <= 120
      then concat_ws(', ',value->>'city',nullif(value->>'region',''),value->>'country')
    else concat_ws(', ',left(value->>'city',55),nullif(left(value->>'region',54),''),value->>'country_code')
  end;
$$;

create function primefreight_private.gf_address_work(op text,payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target uuid := (payload->>'id')::uuid;
  request_id uuid := (payload->>'request_id')::uuid;
  origin_address jsonb;
  destination_address jsonb;
  current_shipment public.pf_shipments%rowtype;
  previous primefreight_private.gf_shipment_addresses%rowtype;
  service_name text := payload->>'service';
  estimate date := nullif(payload->>'eta','')::date;
  reference text := coalesce(trim(payload->>'internal_reference'),'');
begin
  if auth.uid() is null then raise exception 'Sign in to continue.' using errcode = '42501'; end if;
  if op = 'read' then
    if not primefreight_private.allowed(target,'view') then raise exception 'Shipment unavailable.' using errcode = '42501'; end if;
    return coalesce((select jsonb_build_object('origin',origin,'destination',destination)
      from primefreight_private.gf_shipment_addresses where shipment_id = target), '{}'::jsonb);
  end if;
  if op <> 'save' or op is null then raise exception 'Unknown address operation.' using errcode = '22023'; end if;
  if target is null then
    if not primefreight_private.is_admin() then raise exception 'Administrator access required.' using errcode = '42501'; end if;
    if request_id is null then raise exception 'A shipment request ID is required.' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('gf-address:' || request_id::text,0));
    select shipment_id into target from primefreight_private.gf_shipment_addresses where create_request = request_id;
    if found then return to_jsonb(target); end if;
  else
    request_id := null;
    select * into current_shipment from public.pf_shipments where id = target for update;
    if not found or not primefreight_private.allowed(target,'edit') then
      raise exception 'You do not have permission to edit this shipment.' using errcode = '42501';
    end if;
    select * into previous from primefreight_private.gf_shipment_addresses where shipment_id = target;
  end if;

  origin_address := coalesce(primefreight_private.gf_clean_address(payload->'origin'),previous.origin);
  destination_address := coalesce(primefreight_private.gf_clean_address(payload->'destination'),previous.destination);
  if target is null then
    if origin_address is null or destination_address is null then
      raise exception 'Enter both pickup and delivery addresses.' using errcode = '22023';
    end if;
    insert into public.pf_shipments (origin,destination,service,eta,internal_reference)
    values (primefreight_private.gf_address_label(origin_address),primefreight_private.gf_address_label(destination_address),
      service_name,estimate,reference) returning id into target;
  else
    update public.pf_shipments
    set origin = coalesce(primefreight_private.gf_address_label(origin_address),nullif(trim(payload->>'legacy_origin'),''),current_shipment.origin),
      destination = coalesce(primefreight_private.gf_address_label(destination_address),nullif(trim(payload->>'legacy_destination'),''),current_shipment.destination),
      service = service_name,eta = estimate,internal_reference = reference
    where id = target;
  end if;
  if origin_address is not null or destination_address is not null then
    insert into primefreight_private.gf_shipment_addresses (shipment_id,origin,destination,create_request)
      values (target,origin_address,destination_address,request_id)
    on conflict (shipment_id) do update set origin=excluded.origin,destination=excluded.destination;
  end if;
  return to_jsonb(target);
end;
$$;

create function public.gf_address_work(op text,payload jsonb) returns jsonb
language sql set search_path = '' as $$ select primefreight_private.gf_address_work($1,$2); $$;
revoke all on function primefreight_private.gf_clean_address(jsonb),primefreight_private.gf_address_label(jsonb),
  primefreight_private.gf_address_work(text,jsonb),public.gf_address_work(text,jsonb) from public,anon,authenticated;
grant execute on function primefreight_private.gf_address_work(text,jsonb),public.gf_address_work(text,jsonb) to authenticated;
notify pgrst, 'reload schema';

commit;
