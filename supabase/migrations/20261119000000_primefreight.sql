begin;

create schema primefreight_private;
revoke all on schema primefreight_private from public;
grant usage on schema primefreight_private to anon, authenticated;

create table primefreight_private.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table public.pf_shipments (
  id uuid primary key default gen_random_uuid(),
  tracking_code text not null unique default ('PF-' || upper(replace(gen_random_uuid()::text, '-', ''))),
  origin text not null check (length(trim(origin)) between 1 and 100),
  destination text not null check (length(trim(destination)) between 1 and 100),
  service text not null check (service in ('Express', 'Air Freight', 'Ocean Freight', 'Road Freight')),
  eta date,
  internal_reference text not null default '' check (length(internal_reference) <= 150),
  created_at timestamptz not null default now()
);

create table primefreight_private.access (
  shipment_id uuid references public.pf_shipments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  can_edit boolean not null default false,
  can_post boolean not null default false,
  primary key (shipment_id, user_id)
);

create index pf_access_by_user on primefreight_private.access (user_id, shipment_id);

create table public.pf_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.pf_shipments(id) on delete cascade,
  status text not null check (status in ('Label created', 'Picked up', 'In transit', 'Customs clearance', 'Out for delivery', 'Delivered', 'Exception', 'Returned')),
  location text not null default '' check (length(location) <= 100),
  note text not null default '' check (length(note) <= 500),
  posted_at timestamptz not null default clock_timestamp(),
  posted_by uuid default auth.uid() references auth.users(id) on delete set null
);

create index pf_events_timeline on public.pf_events (shipment_id, posted_at desc, id desc);

create function primefreight_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from primefreight_private.admins where user_id = auth.uid());
$$;

create function primefreight_private.allowed(shipment uuid, action text) returns boolean
language sql stable security definer set search_path = '' as $$
  select primefreight_private.is_admin() or exists (
    select 1 from primefreight_private.access a
    where a.shipment_id = shipment and a.user_id = auth.uid()
    and case action when 'view' then true when 'edit' then a.can_edit when 'post' then a.can_post else false end
  );
$$;

create function primefreight_private.initial_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pf_events (shipment_id, status, location) values (new.id, 'Label created', new.origin);
  return new;
end;
$$;

create trigger pf_initial_event after insert on public.pf_shipments
for each row execute function primefreight_private.initial_event();

alter table public.pf_shipments enable row level security;
alter table public.pf_events enable row level security;
alter table primefreight_private.admins enable row level security;
alter table primefreight_private.access enable row level security;

revoke all on public.pf_shipments, public.pf_events from public, anon, authenticated;
grant select on public.pf_shipments, public.pf_events to authenticated;
grant insert (origin, destination, service, eta, internal_reference),
      update (origin, destination, service, eta, internal_reference) on public.pf_shipments to authenticated;
grant insert (shipment_id, status, location, note) on public.pf_events to authenticated;

create policy pf_view_shipments on public.pf_shipments for select to authenticated using (primefreight_private.allowed(id, 'view'));
create policy pf_create_shipments on public.pf_shipments for insert to authenticated with check ((select primefreight_private.is_admin()));
create policy pf_edit_shipments on public.pf_shipments for update to authenticated
  using (primefreight_private.allowed(id, 'edit')) with check (primefreight_private.allowed(id, 'edit'));
create policy pf_view_events on public.pf_events for select to authenticated using (primefreight_private.allowed(shipment_id, 'view'));
create policy pf_post_events on public.pf_events for insert to authenticated with check (primefreight_private.allowed(shipment_id, 'post'));

create function primefreight_private.track(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tracking_code', s.tracking_code, 'origin', s.origin, 'destination', s.destination,
    'service', s.service, 'eta', s.eta,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('status', e.status, 'location', e.location,
        'note', e.note, 'posted_at', e.posted_at) order by e.posted_at desc, e.id desc)
      from public.pf_events e where e.shipment_id = s.id
    ), '[]'::jsonb)
  )
  from public.pf_shipments s where s.tracking_code = upper(trim(code));
$$;

create function primefreight_private.rights(shipment uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin', primefreight_private.is_admin(),
    'edit', primefreight_private.allowed(shipment, 'edit'),
    'post', primefreight_private.allowed(shipment, 'post')
  );
$$;

create function primefreight_private.shipment_staff(shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not primefreight_private.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('email', u.email, 'can_edit', a.can_edit, 'can_post', a.can_post) order by u.email)
    from primefreight_private.access a join auth.users u on u.id = a.user_id
    where a.shipment_id = shipment
  ), '[]'::jsonb);
end;
$$;

create function primefreight_private.set_access(shipment uuid, staff_email text, can_edit boolean, can_post boolean, revoke_access boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare staff_id uuid;
begin
  if not primefreight_private.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  select id into staff_id from auth.users
  where lower(email) = lower(trim(staff_email)) and email_confirmed_at is not null;
  if staff_id is null then
    raise exception 'Create and confirm this staff account in Supabase Auth first.' using errcode = '22023';
  end if;
  if exists (select 1 from primefreight_private.admins where user_id = staff_id) then
    raise exception 'This account is an administrator.' using errcode = '22023';
  end if;

  if revoke_access then
    delete from primefreight_private.access a where a.shipment_id = shipment and a.user_id = staff_id;
  else
    insert into primefreight_private.access values (shipment, staff_id, can_edit, can_post)
    on conflict (shipment_id, user_id) do update set can_edit = excluded.can_edit, can_post = excluded.can_post;
  end if;
end;
$$;

create function public.pf_track(code text) returns jsonb
language sql stable set search_path = '' as $$ select primefreight_private.track($1); $$;
create function public.pf_rights(shipment uuid default null) returns jsonb
language sql stable set search_path = '' as $$ select primefreight_private.rights($1); $$;
create function public.pf_shipment_staff(shipment uuid) returns jsonb
language sql stable set search_path = '' as $$ select primefreight_private.shipment_staff($1); $$;
create function public.pf_set_access(shipment uuid, staff_email text, can_edit boolean, can_post boolean, revoke_access boolean)
returns void language sql set search_path = '' as $$ select primefreight_private.set_access($1,$2,$3,$4,$5); $$;

revoke all on all functions in schema primefreight_private from public, anon, authenticated;
revoke all on function public.pf_track(text), public.pf_rights(uuid), public.pf_shipment_staff(uuid),
  public.pf_set_access(uuid,text,boolean,boolean,boolean) from public, anon, authenticated;
grant execute on function primefreight_private.track(text), public.pf_track(text) to anon, authenticated;
grant execute on function primefreight_private.is_admin(), primefreight_private.allowed(uuid,text),
  primefreight_private.rights(uuid), primefreight_private.shipment_staff(uuid),
  primefreight_private.set_access(uuid,text,boolean,boolean,boolean),
  public.pf_rights(uuid), public.pf_shipment_staff(uuid),
  public.pf_set_access(uuid,text,boolean,boolean,boolean) to authenticated;

commit;
