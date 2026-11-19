begin;

alter table public.pf_shipments
  alter column tracking_code set default ('GF-' || upper(replace(gen_random_uuid()::text, '-', '')));

create table primefreight_private.gf_tracking_aliases (
  alias text primary key,
  shipment_id uuid not null references public.pf_shipments(id) on delete cascade
);
alter table primefreight_private.gf_tracking_aliases enable row level security;

insert into primefreight_private.gf_tracking_aliases (alias, shipment_id)
select tracking_code, id from public.pf_shipments where tracking_code like 'PF-%';

update public.pf_shipments s
set tracking_code = case when exists (
  select 1 from public.pf_shipments existing where existing.tracking_code = 'GF-' || substring(a.alias from 4)
) then 'GF-' || upper(replace(gen_random_uuid()::text, '-', ''))
else 'GF-' || substring(a.alias from 4) end
from primefreight_private.gf_tracking_aliases a
where s.id = a.shipment_id;

-- Leave already-attempted sends intact so retries keep the same email content.
update primefreight_private.gf_outbox mail
set tracking_code = s.tracking_code
from primefreight_private.gf_tracking_aliases a join public.pf_shipments s on s.id = a.shipment_id
where mail.tracking_code = a.alias and not mail.finished and mail.attempts = 0;

create function primefreight_private.gf_track_with_alias(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select primefreight_private.track(coalesce(
    (select s.tracking_code from primefreight_private.gf_tracking_aliases a
      join public.pf_shipments s on s.id = a.shipment_id where a.alias = upper(trim(code))),
    upper(trim(code))));
$$;

revoke all on function primefreight_private.gf_track_with_alias(text) from public, anon, authenticated;
grant execute on function primefreight_private.gf_track_with_alias(text) to anon, authenticated;

create or replace function public.pf_track(code text) returns jsonb
language sql stable set search_path = '' as $$
  select primefreight_private.gf_track_with_alias($1);
$$;

notify pgrst, 'reload schema';
commit;
