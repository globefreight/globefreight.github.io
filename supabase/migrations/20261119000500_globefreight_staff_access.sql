begin;

create table primefreight_private.gf_suspended_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  suspended_at timestamptz not null default clock_timestamp()
);
alter table primefreight_private.gf_suspended_staff enable row level security;

create function primefreight_private.gf_staff_suspended(account uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from primefreight_private.gf_suspended_staff where user_id = account);
$$;

create or replace function primefreight_private.rights(shipment uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin', primefreight_private.is_admin(),
    'suspended', primefreight_private.gf_staff_suspended(auth.uid()),
    'edit', primefreight_private.allowed(shipment,'edit'),
    'post', primefreight_private.allowed(shipment,'post')
  );
$$;

create or replace function primefreight_private.allowed(shipment uuid, action text) returns boolean
language sql stable security definer set search_path = '' as $$
  select primefreight_private.is_admin() or (
    not primefreight_private.gf_staff_suspended(auth.uid()) and exists (
      select 1 from primefreight_private.access a
      where a.shipment_id = shipment and a.user_id = auth.uid()
        and case action when 'view' then true when 'edit' then a.can_edit when 'post' then a.can_post else false end
    )
  );
$$;

create function primefreight_private.gf_guard_staff_assignment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare account uuid;
begin
  if tg_table_name = 'access' then
    account := new.user_id;
  else
    account := new.assigned_to;
  end if;
  if account is not null then
    perform pg_advisory_xact_lock(hashtextextended('gf-staff:' || account::text,0));
    if primefreight_private.gf_staff_suspended(account) then
      raise exception 'This staff account is suspended. Reinstate it before assigning work.' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger gf_guard_shipment_assignment before insert or update on primefreight_private.access
  for each row execute function primefreight_private.gf_guard_staff_assignment();
create trigger gf_guard_complaint_assignment before insert or update of assigned_to on public.gf_complaints
  for each row execute function primefreight_private.gf_guard_staff_assignment();
create trigger gf_guard_exception_assignment before insert or update of assigned_to on primefreight_private.gf_exception_followup
  for each row execute function primefreight_private.gf_guard_staff_assignment();

create function primefreight_private.gf_return_exception_on_revoke() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update primefreight_private.gf_exception_followup set assigned_to = null, updated_at = clock_timestamp()
  where shipment_id = old.shipment_id and assigned_to = old.user_id;
  return null;
end;
$$;
create trigger gf_return_exception_on_revoke after delete on primefreight_private.access
  for each row execute function primefreight_private.gf_return_exception_on_revoke();

create function primefreight_private.gf_staff_admin(op text,payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  account uuid;
  address text;
  target uuid;
  input_value text := trim(payload->>'value');
  expected timestamptz;
  begin_at int := greatest(0,coalesce((payload->>'offset')::int,0));
begin
  if not primefreight_private.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  if op = 'find-shipment' then
    select id into target from public.pf_shipments where tracking_code = upper(input_value);
    return to_jsonb(target);
  end if;
  if op = 'directory' then
    return coalesce((select jsonb_agg(to_jsonb(d) order by d.email,d.id) from (
      select u.id,u.email,(s.user_id is not null) as suspended,
        (select count(*) from primefreight_private.access a where a.user_id = u.id) as shipments,
        (select count(*) from public.gf_complaints c where c.assigned_to = u.id) as complaints
      from auth.users u left join primefreight_private.gf_suspended_staff s on s.user_id = u.id
      where u.email is not null and u.email_confirmed_at is not null
        and not exists(select 1 from primefreight_private.admins a where a.user_id = u.id)
        and (coalesce(input_value,'') = '' or strpos(lower(u.email),lower(input_value)) > 0)
      order by u.email,u.id offset begin_at limit 21
    ) d),'[]'::jsonb);
  end if;

  select u.id,u.email into account,address from auth.users u
  where u.id = (payload->>'staff_id')::uuid and u.email_confirmed_at is not null and u.email is not null
    and not exists(select 1 from primefreight_private.admins a where a.user_id = u.id);
  if not found then raise exception 'Choose a confirmed staff account.' using errcode = '22023'; end if;

  if op = 'staff-work' then
    return jsonb_build_object(
      'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc,s.id desc) from (
        select p.id,p.tracking_code,p.origin,p.destination,p.created_at,a.can_edit,a.can_post
        from primefreight_private.access a join public.pf_shipments p on p.id = a.shipment_id
        where a.user_id = account order by p.created_at desc,p.id desc
        offset greatest(0,coalesce((payload->>'shipment_offset')::int,0)) limit 11
      ) s),'[]'::jsonb),
      'complaints',coalesce((select jsonb_agg(to_jsonb(c) order by c.received_at desc,c.id desc) from (
        select p.id,'GF-' || upper(p.id::text) as reference,p.category,p.status,p.received_at,p.updated_at
        from public.gf_complaints p where p.assigned_to = account order by p.received_at desc,p.id desc
        offset greatest(0,coalesce((payload->>'complaint_offset')::int,0)) limit 11
      ) c),'[]'::jsonb)
    );
  end if;

  if op in ('suspend','reinstate') then
    perform pg_advisory_xact_lock(hashtextextended('gf-staff:' || account::text,0));
    if op = 'suspend' then
      insert into primefreight_private.gf_suspended_staff(user_id) values(account) on conflict do nothing;
      if not found then return null; end if;
      delete from primefreight_private.access where user_id = account;
      update public.gf_complaints set assigned_to = null where assigned_to = account;
      update primefreight_private.gf_exception_followup
        set assigned_to = null, updated_at = clock_timestamp() where assigned_to = account;
      perform primefreight_private.gf_audit_action('Staff access suspended',account);
    else
      delete from primefreight_private.gf_suspended_staff where user_id = account;
      if found then perform primefreight_private.gf_audit_action('Staff access reinstated',account); end if;
    end if;
    return null;
  end if;

  if op in ('shipment-grant','shipment-revoke') then
    select id into target from public.pf_shipments where tracking_code = upper(input_value);
    if not found then raise exception 'Shipment tracking number not found.' using errcode = '22023'; end if;
    perform primefreight_private.set_access(target,address,coalesce((payload->>'can_edit')::boolean,false),
      coalesce((payload->>'can_post')::boolean,false),op = 'shipment-revoke');
    return null;
  end if;

  if op in ('complaint-assign','complaint-revoke') then
    if input_value is null or input_value !~* '^(GF-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Enter a valid complaint reference.' using errcode = '22023';
    end if;
    target := regexp_replace(input_value,'^GF-','','i')::uuid;
    select c.updated_at into expected from public.gf_complaints c
    where c.id = target and (op = 'complaint-assign' or c.assigned_to = account)
    for update;
    if not found then raise exception 'Complaint or assignment not found.' using errcode = '22023'; end if;
    if op = 'complaint-revoke' and (payload->>'updated_at')::timestamptz is distinct from expected then
      raise exception 'This complaint changed. Refresh before removing its assignment.' using errcode = '22023';
    end if;
    perform primefreight_private.gf_assign_complaint(target,
      case when op = 'complaint-assign' then address else null end,expected);
    return null;
  end if;

  raise exception 'Unknown staff administration operation.' using errcode = '22023';
end;
$$;

create function public.gf_staff_admin(op text,payload jsonb) returns jsonb
language sql set search_path = '' as $$ select primefreight_private.gf_staff_admin($1,$2); $$;
revoke all on function primefreight_private.gf_staff_suspended(uuid),primefreight_private.gf_guard_staff_assignment(),
  primefreight_private.gf_return_exception_on_revoke(),primefreight_private.gf_staff_admin(text,jsonb),
  public.gf_staff_admin(text,jsonb) from public,anon,authenticated;
grant execute on function primefreight_private.gf_staff_admin(text,jsonb),public.gf_staff_admin(text,jsonb) to authenticated;
notify pgrst, 'reload schema';

commit;
