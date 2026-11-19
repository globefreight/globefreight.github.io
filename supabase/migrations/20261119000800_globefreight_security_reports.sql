begin;

create function primefreight_private.gf_admin_needs_mfa() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt()->>'aal','aal1') <> 'aal2'
    and exists (select 1 from primefreight_private.admins where user_id = auth.uid())
    and exists (select 1 from auth.mfa_factors where user_id = auth.uid() and status = 'verified');
$$;

create or replace function primefreight_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from primefreight_private.admins where user_id = auth.uid())
    and not primefreight_private.gf_admin_needs_mfa();
$$;

create or replace function primefreight_private.rights(shipment uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin', primefreight_private.is_admin(),
    'mfa_required', primefreight_private.gf_admin_needs_mfa(),
    'suspended', primefreight_private.gf_staff_suspended(auth.uid()),
    'edit', primefreight_private.allowed(shipment,'edit'),
    'post', primefreight_private.allowed(shipment,'post')
  );
$$;

create function primefreight_private.gf_shipment_report(filters jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  first_day date := nullif(filters->>'from','')::date;
  last_day date := nullif(filters->>'to','')::date;
  wanted_service text := nullif(trim(filters->>'service'),'');
  wanted_status text := nullif(trim(filters->>'status'),'');
  wanted_destination text := nullif(lower(trim(filters->>'destination')),'');
begin
  if not primefreight_private.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  if first_day is null or last_day is null or not isfinite(first_day) or not isfinite(last_day)
    or last_day < first_day or last_day - first_day > 366 or length(wanted_destination) > 120 then
    raise exception 'Choose a valid reporting date range of up to one year.' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.tracking_code) from (
    select s.tracking_code,s.origin,s.destination,s.service,s.eta,s.created_at,e.status,e.posted_at as latest_update
    from public.pf_shipments s
    left join lateral (select status,posted_at from public.pf_events where shipment_id = s.id
      order by posted_at desc,id desc limit 1) e on true
    where s.created_at >= (first_day::timestamp at time zone 'UTC')
      and s.created_at < ((last_day + 1)::timestamp at time zone 'UTC')
      and (wanted_service is null or s.service = wanted_service)
      and (wanted_status is null or e.status = wanted_status)
      and (wanted_destination is null or strpos(lower(s.destination),wanted_destination) > 0)
    order by s.created_at desc,s.tracking_code limit 5001
  ) r),'[]'::jsonb);
end;
$$;

create function public.gf_shipment_report(filters jsonb) returns jsonb
language sql stable set search_path = '' as $$ select primefreight_private.gf_shipment_report($1); $$;

revoke all on function primefreight_private.gf_admin_needs_mfa(),primefreight_private.gf_shipment_report(jsonb),
  public.gf_shipment_report(jsonb) from public,anon,authenticated;
grant execute on function primefreight_private.gf_shipment_report(jsonb),public.gf_shipment_report(jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
