begin;

create table public.gf_complaints (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null check (length(customer_name) between 1 and 100),
  customer_email text not null check (length(customer_email) between 3 and 254),
  tracking_code text not null check (length(tracking_code) <= 50),
  category text not null check (category in ('Shipment delay', 'Delivery issue', 'Loss or damage', 'Design and print', 'Other')),
  description text not null check (length(description) between 10 and 2000),
  status text not null default 'Open' check (status in ('Open', 'In review', 'Resolved')),
  internal_note text not null default '' check (length(internal_note) <= 2000),
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_email text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index gf_complaints_received on public.gf_complaints (received_at desc, id desc);
create index gf_complaints_assignee on public.gf_complaints (assigned_to, received_at desc, id desc);
create index gf_complaints_email_received on public.gf_complaints (customer_email, received_at desc);

alter table public.gf_complaints enable row level security;
revoke all on public.gf_complaints from public, anon, authenticated;
grant select on public.gf_complaints to authenticated;
grant update (status, internal_note) on public.gf_complaints to authenticated;

create policy gf_complaints_read on public.gf_complaints for select to authenticated
  using ((select primefreight_private.is_admin()) or assigned_to = (select auth.uid()));
create policy gf_complaints_update on public.gf_complaints for update to authenticated
  using ((select primefreight_private.is_admin()) or assigned_to = (select auth.uid()))
  with check ((select primefreight_private.is_admin()) or assigned_to = (select auth.uid()));

create function primefreight_private.gf_touch_complaint() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  if new.assigned_to is null then
    new.assigned_email := null;
  end if;
  return new;
end;
$$;

create trigger gf_touch_complaint before update on public.gf_complaints
for each row execute function primefreight_private.gf_touch_complaint();

create function primefreight_private.gf_submit_complaint(
  customer text, email_address text, tracking text, topic text, details text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  normalized_email text := lower(trim(email_address));
  case_id uuid;
begin
  if normalized_email is null or length(normalized_email) > 254
      or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      or trim(customer) is null or length(trim(customer)) not between 1 and 100
      or length(coalesce(trim(tracking), '')) > 50
      or trim(details) is null or length(trim(details)) not between 10 and 2000
      or topic is null or topic not in ('Shipment delay', 'Delivery issue', 'Loss or damage', 'Design and print', 'Other') then
    raise exception 'Check the complaint form fields and try again.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('gf-complaints:' || normalized_email, 0));
  select id into case_id
  from public.gf_complaints
  where customer_email = normalized_email and received_at >= now() - interval '5 minutes'
    and customer_name = trim(customer) and tracking_code = upper(coalesce(trim(tracking), ''))
    and category = topic and description = trim(details)
  order by received_at desc limit 1;
  if case_id is not null then
    return case_id;
  end if;
  if (select count(*) from public.gf_complaints
      where customer_email = normalized_email and received_at >= now() - interval '1 hour') >= 5 then
    raise exception 'Too many recent submissions for this email. Please try again later.' using errcode = '22023';
  end if;

  insert into public.gf_complaints (customer_name, customer_email, tracking_code, category, description)
  values (trim(customer), normalized_email, upper(coalesce(trim(tracking), '')), topic, trim(details))
  returning id into case_id;
  return case_id;
end;
$$;

create function primefreight_private.gf_assign_complaint(case_id uuid, staff_email text, expected_update timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
  staff_id uuid;
  normalized_email text := nullif(lower(trim(staff_email)), '');
begin
  if not primefreight_private.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if normalized_email is not null then
    select id into staff_id from auth.users
    where lower(email) = normalized_email and email_confirmed_at is not null;
    if staff_id is null or exists (select 1 from primefreight_private.admins where user_id = staff_id) then
      raise exception 'Enter the email of a confirmed staff account.' using errcode = '22023';
    end if;
  end if;

  update public.gf_complaints
  set assigned_to = staff_id, assigned_email = normalized_email
  where id = case_id and updated_at = expected_update;
  if not found then
    raise exception 'This complaint changed. Refresh the inbox before trying again.' using errcode = '22023';
  end if;
end;
$$;

create function public.gf_submit_complaint(
  customer text, email_address text, tracking text, topic text, details text
) returns uuid language sql set search_path = '' as $$
  select primefreight_private.gf_submit_complaint($1, $2, $3, $4, $5);
$$;

create function public.gf_assign_complaint(case_id uuid, staff_email text, expected_update timestamptz)
returns void language sql set search_path = '' as $$
  select primefreight_private.gf_assign_complaint($1, $2, $3);
$$;

revoke all on function primefreight_private.gf_touch_complaint(),
  primefreight_private.gf_submit_complaint(text,text,text,text,text),
  primefreight_private.gf_assign_complaint(uuid,text,timestamptz),
  public.gf_submit_complaint(text,text,text,text,text),
  public.gf_assign_complaint(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function primefreight_private.gf_submit_complaint(text,text,text,text,text),
  public.gf_submit_complaint(text,text,text,text,text) to anon, authenticated;
grant execute on function primefreight_private.gf_assign_complaint(uuid,text,timestamptz),
  public.gf_assign_complaint(uuid,text,timestamptz) to authenticated;

commit;
