-- P5.6: advanced reports and exports (Pro feature advanced_reports; D17;
-- assumptions A334-A341 in docs/autofix/phase-5/P5.6-reports.md).
--
--   1. booking_assignments: which member did the job (one row per booking,
--      name snapshot so the report keeps a leaver's name). Written only by
--      assign_booking_technician() (owners/managers, Pro).
--   2. Report functions for owners and managers of the selected garage, Pro
--      only (require_garage_feature(..., 'advanced_reports')). Dates are
--      garage-local and inclusive; the window is [from 00:00, to + 1 00:00)
--      in garages.timezone, so a clock-change day is 23 or 25 hours long.
--        report_revenue_by_service(from, to)
--        report_revenue_by_technician(from, to)
--        report_bay_utilisation(from, to)       per resource per local day
--        report_hours(from, to)                 sold vs worked per technician
--        report_reminder_roi(from, to)          per reminder kind
--        report_campaign_roi(from, to)          only when campaign_sends exists
--   Nothing here replaces create_booking*, available_slots* or any earlier
--   function; basic figures (Today, reminder_won_back) are unchanged.

-- ---------------------------------------------------------------------------
-- 1. booking_assignments
-- ---------------------------------------------------------------------------

create table public.booking_assignments (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null default public.current_garage_id() references public.garages(id) on delete cascade,
  booking_id uuid not null,
  technician_id uuid references auth.users(id) on delete set null,
  technician_name text not null,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  constraint booking_assignments_booking_key unique (garage_id, booking_id),
  constraint booking_assignments_booking_id_fkey foreign key (garage_id, booking_id)
    references public.bookings (garage_id, id) on delete cascade,
  constraint booking_assignments_name_check check (char_length(btrim(technician_name)) between 1 and 120)
);

comment on table public.booking_assignments is
  'P5.6: the member who did the job, for revenue and hours by technician. technician_name is a snapshot (kept when the member leaves). Written only by assign_booking_technician().';

create index booking_assignments_technician_idx on public.booking_assignments (garage_id, technician_id);

alter table public.booking_assignments enable row level security;

-- booking_assignments
--   "garage members read booking assignments"  select  members of the selected garage (not plan checked: stays readable after a downgrade)
--   no insert/update/delete for staff: assign_booking_technician() writes (owners/managers, garage_has_feature advanced_reports)
create policy "garage members read booking assignments" on public.booking_assignments
  for select to authenticated using (garage_id = (select public.current_garage_id()));

revoke all on public.booking_assignments from anon, authenticated;
grant select on public.booking_assignments to authenticated;
grant select, insert, update, delete on public.booking_assignments to service_role;

-- Assign (or with p_technician_id null, unassign) the member who did the job.
-- Owners and managers of the selected garage, two-step sign-in as elsewhere,
-- Pro. Any member of the garage may be assigned (owners often do the work).
create function public.assign_booking_technician(p_booking_id uuid, p_technician_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  member_name text;
  previous uuid;
begin
  if target_garage is null or not public.garage_actor_allowed()
     or public.current_garage_role() is distinct from 'owner' and public.current_garage_role() is distinct from 'manager' then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'advanced_reports');

  if p_booking_id is null or not exists (
    select 1 from public.bookings booking
    where booking.garage_id = target_garage and booking.id = p_booking_id and booking.deleted_at is null
  ) then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;

  select assignment.technician_id into previous
  from public.booking_assignments assignment
  where assignment.garage_id = target_garage and assignment.booking_id = p_booking_id;

  if p_technician_id is null then
    delete from public.booking_assignments where garage_id = target_garage and booking_id = p_booking_id;
  else
    select left(coalesce(
             nullif(btrim(profile.display_name), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(split_part(account.email, '@', 1), ''),
             'Team member'), 120)
      into member_name
    from public.garage_members member
    join auth.users account on account.id = member.user_id
    left join public.admin_profiles profile on profile.user_id = member.user_id
    where member.garage_id = target_garage and member.user_id = p_technician_id;
    if member_name is null then
      raise exception 'NOT_A_MEMBER' using errcode = '22023';
    end if;
    insert into public.booking_assignments as existing (garage_id, booking_id, technician_id, technician_name, assigned_by, assigned_at)
    values (target_garage, p_booking_id, p_technician_id, member_name, auth.uid(), now())
    on conflict (garage_id, booking_id) do update
      set technician_id = excluded.technician_id,
          technician_name = excluded.technician_name,
          assigned_by = excluded.assigned_by,
          assigned_at = excluded.assigned_at;
  end if;

  if previous is distinct from p_technician_id then
    insert into public.admin_audit_log (garage_id, actor_id, action, entity_type, entity_id, detail)
    values (target_garage, auth.uid(), 'booking.technician_assigned', 'booking', p_booking_id::text,
            jsonb_build_object('from', previous, 'to', p_technician_id));
  end if;

  return jsonb_build_object('booking_id', p_booking_id, 'technician_id', p_technician_id, 'technician_name', member_name);
end
$$;

comment on function public.assign_booking_technician(uuid, uuid) is
  'P5.6: sets (or clears, with null) the member who did a booking''s job. Owners/managers of the selected garage (garage_actor_allowed), Pro (advanced_reports). Audited booking.technician_assigned.';

-- ---------------------------------------------------------------------------
-- 2. Report internals (not granted to any API role)
-- ---------------------------------------------------------------------------

-- The caller's garage and the report window. Owners and managers of the
-- selected garage (or the service role with x-garage-id), Pro only. Dates
-- are garage-local and inclusive; at most 366 days.
create function public.report_window(p_from date, p_to date)
returns table (garage_id uuid, zone text, from_at timestamptz, to_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_garage uuid := public.current_garage_id();
  garage_zone text;
begin
  if target_garage is null
     or (public.current_garage_role() is distinct from 'owner' and public.current_garage_role() is distinct from 'manager'
         and auth.role() is distinct from 'service_role' and current_setting('role', true) is distinct from 'service_role') then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  perform public.require_garage_feature(target_garage, 'advanced_reports');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'INVALID_RANGE: from and to are required, from <= to, at most 366 days' using errcode = '22023';
  end if;
  select coalesce(nullif(garage.timezone, ''), 'Europe/London') into garage_zone from public.garages garage where garage.id = target_garage;
  return query select target_garage, garage_zone,
    p_from::timestamp at time zone garage_zone,
    (p_to + 1)::timestamp at time zone garage_zone;
end
$$;

-- Minutes covered by a multirange (rounded down to whole minutes).
create function public.report_minutes(p_ranges tstzmultirange)
returns integer
language sql
immutable
set search_path = ''
as $$
  select coalesce(floor(sum(extract(epoch from upper(part) - lower(part))) / 60), 0)::integer
  from unnest(coalesce(p_ranges, '{}'::tstzmultirange)) part
$$;

-- The jobs a revenue or hours report counts: bookings whose appointment
-- starts in the window, not requested/cancelled/no-show, not trashed, with
-- the issued/paid invoice total (null when none) and the technician.
create function public.report_jobs(p_garage_id uuid, p_from_at timestamptz, p_to_at timestamptz)
returns table (
  booking_id uuid,
  status text,
  service_id uuid,
  service_name text,
  technician_id uuid,
  technician_name text,
  invoiced_pence bigint,
  price_pence bigint,
  sold_minutes integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    booking.id,
    booking.status,
    booking.service_id,
    coalesce(service.name, 'Service removed'),
    assignment.technician_id,
    assignment.technician_name,
    invoiced.total,
    coalesce(booking.price_pence, 0)::bigint,
    greatest(0, floor(extract(epoch from booking.ends_at - booking.starts_at) / 60))::integer
  from public.bookings booking
  left join public.services service on service.garage_id = booking.garage_id and service.id = booking.service_id
  left join public.booking_assignments assignment on assignment.garage_id = booking.garage_id and assignment.booking_id = booking.id
  left join lateral (
    select sum(invoice.total_pence)::bigint as total
    from public.invoices invoice
    where invoice.garage_id = booking.garage_id
      and invoice.booking_id = booking.id
      and invoice.status in ('issued', 'paid')
      and invoice.deleted_at is null
  ) invoiced on true
  where booking.garage_id = p_garage_id
    and booking.starts_at >= p_from_at
    and booking.starts_at < p_to_at
    and booking.status not in ('requested', 'cancelled', 'no_show')
    and booking.deleted_at is null
$$;

-- ---------------------------------------------------------------------------
-- 3. Reports (owners/managers of the selected garage, Pro)
-- ---------------------------------------------------------------------------

create function public.report_revenue_by_service(p_from date, p_to date)
returns table (service_id uuid, service_name text, bookings integer, invoiced_pence bigint, estimated_pence bigint, total_pence bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  win record;
begin
  select * into win from public.report_window(p_from, p_to);
  return query
  select
    job.service_id,
    min(job.service_name),
    count(*)::integer,
    coalesce(sum(job.invoiced_pence), 0)::bigint,
    coalesce(sum(job.price_pence) filter (where job.invoiced_pence is null), 0)::bigint,
    coalesce(sum(coalesce(job.invoiced_pence, job.price_pence)), 0)::bigint
  from public.report_jobs(win.garage_id, win.from_at, win.to_at) job
  group by job.service_id
  order by 6 desc, 2;
end
$$;

create function public.report_revenue_by_technician(p_from date, p_to date)
returns table (technician_id uuid, technician_name text, bookings integer, invoiced_pence bigint, estimated_pence bigint, total_pence bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  win record;
begin
  select * into win from public.report_window(p_from, p_to);
  return query
  select
    job.technician_id,
    job.technician_name,
    count(*)::integer,
    coalesce(sum(job.invoiced_pence), 0)::bigint,
    coalesce(sum(job.price_pence) filter (where job.invoiced_pence is null), 0)::bigint,
    coalesce(sum(coalesce(job.invoiced_pence, job.price_pence)), 0)::bigint
  from public.report_jobs(win.garage_id, win.from_at, win.to_at) job
  group by job.technician_id, job.technician_name
  order by (job.technician_name is null), 6 desc, 2;
end
$$;

-- Open minutes: the day's opening windows (several rows per weekday allowed)
-- in the garage's time zone, none on a closure day. Booked minutes: the
-- resource's live bookings' `during` (requested counts: it holds the
-- resource) inside those windows. Resources: active ones, plus inactive ones
-- with bookings in the window.
create function public.report_bay_utilisation(p_from date, p_to date)
returns table (resource_id uuid, resource_name text, resource_kind text, day date, open_minutes integer, booked_minutes integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  checked record;
begin
  select * into checked from public.report_window(p_from, p_to);
  return query
  with win as (
    select checked.garage_id, checked.zone, checked.from_at, checked.to_at
  ),
  days as (
    select series::date as day
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') series
  ),
  windows as (
    select days.day,
           range_agg(tstzrange((days.day + hours.opens) at time zone win.zone, (days.day + hours.closes) at time zone win.zone, '[)')) as open_ranges
    from days
    cross join win
    join public.opening_hours hours on hours.garage_id = win.garage_id and hours.weekday = extract(isodow from days.day)
    where not exists (
      select 1 from public.closures closure
      where closure.garage_id = win.garage_id and days.day between closure.starts_on and closure.ends_on
    )
    group by days.day
  ),
  live as (
    select booking.resource_id, booking.during
    from public.bookings booking, win
    where booking.garage_id = win.garage_id
      and booking.status not in ('cancelled', 'no_show')
      and booking.deleted_at is null
      and booking.during && tstzrange(win.from_at, win.to_at, '[)')
  ),
  resource_list as (
    select resource.id, resource.name, resource.kind, resource.sort
    from public.resources resource, win
    where resource.garage_id = win.garage_id
      and (resource.active or exists (select 1 from live where live.resource_id = resource.id))
  )
  select
    resource_list.id,
    resource_list.name,
    resource_list.kind,
    days.day,
    public.report_minutes(windows.open_ranges),
    coalesce((
      select public.report_minutes(range_agg(live.during) * windows.open_ranges)
      from live
      where live.resource_id = resource_list.id and live.during && windows.open_ranges
    ), 0)
  from resource_list
  cross join days
  left join windows on windows.day = days.day
  order by resource_list.sort, resource_list.name, resource_list.id, days.day;
end
$$;

-- Hours sold vs worked per technician. Jobs: report_jobs() that reached
-- arrived or later. Sold: the appointment length (ends_at - starts_at, the
-- service duration; no buffer or travel). Worked, from the status timeline
-- (booking_events status_changed/cancelled, each status lasting until the
-- next change): time in in_progress (waiting_parts excluded); a job never
-- marked in_progress counts its time in arrived. A job is measured once it
-- reached ready or collected with a start; sold and worked minutes cover
-- measured jobs only.
create function public.report_hours(p_from date, p_to date)
returns table (technician_id uuid, technician_name text, jobs integer, measured_jobs integer, sold_minutes integer, worked_minutes integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  checked record;
begin
  select * into checked from public.report_window(p_from, p_to);
  return query
  with win as (
    select checked.garage_id, checked.zone, checked.from_at, checked.to_at
  ),
  job as (
    select job.*
    from win cross join lateral public.report_jobs(win.garage_id, win.from_at, win.to_at) job
    where job.status in ('arrived', 'in_progress', 'waiting_parts', 'ready', 'collected')
  ),
  spans as (
    select event.booking_id,
           event.data ->> 'to' as status,
           event.at,
           lead(event.at) over (partition by event.booking_id order by event.at, event.created_at, event.id) as next_at
    from public.booking_events event, win
    where event.garage_id = win.garage_id
      and event.type in ('status_changed', 'cancelled')
      and event.booking_id in (select job.booking_id from job)
  ),
  per_job as (
    select job.booking_id, job.technician_id, job.technician_name, job.sold_minutes,
           coalesce(sum(extract(epoch from spans.next_at - spans.at)) filter (where spans.status = 'in_progress' and spans.next_at is not null), 0) as in_progress_s,
           coalesce(sum(extract(epoch from spans.next_at - spans.at)) filter (where spans.status = 'arrived' and spans.next_at is not null), 0) as arrived_s,
           bool_or(spans.status = 'in_progress' and spans.next_at is not null) as had_work,
           bool_or(spans.status = 'arrived' and spans.next_at is not null) as had_arrival,
           bool_or(spans.status in ('ready', 'collected')) as finished
    from job
    left join spans on spans.booking_id = job.booking_id
    group by job.booking_id, job.technician_id, job.technician_name, job.sold_minutes
  ),
  measured as (
    select per_job.*,
           coalesce(per_job.finished, false) and (coalesce(per_job.had_work, false) or coalesce(per_job.had_arrival, false)) as is_measured,
           case when coalesce(per_job.had_work, false) then per_job.in_progress_s else per_job.arrived_s end as worked_s
    from per_job
  )
  select
    measured.technician_id,
    measured.technician_name,
    count(*)::integer,
    count(*) filter (where measured.is_measured)::integer,
    coalesce(sum(measured.sold_minutes) filter (where measured.is_measured), 0)::integer,
    coalesce(floor(sum(measured.worked_s) filter (where measured.is_measured) / 60), 0)::integer
  from measured
  group by measured.technician_id, measured.technician_name
  order by (measured.technician_name is null), 2;
end
$$;

-- Reminder ROI per kind, on reminder_won_back()'s rules: sent = sends with
-- sent_at in the window; booked/pence = live, untrashed bookings credited to
-- a send of that kind and created in the window (issued/paid invoice total,
-- else the booking's price, else 0). sms_segments = metered segments of the
-- sends counted as sent (usage_events source 'sms:reminder_send:<id>').
create function public.report_reminder_roi(p_from date, p_to date)
returns table (kind text, sent integer, booked integer, pence bigint, sms_segments numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  checked record;
begin
  select * into checked from public.report_window(p_from, p_to);
  return query
  with win as (
    select checked.garage_id, checked.zone, checked.from_at, checked.to_at
  ),
  sent as (
    select send.kind, count(*)::integer as sent, coalesce(sum(usage.quantity), 0) as segments
    from public.reminder_sends send
    cross join win
    left join public.usage_events usage
      on usage.garage_id = send.garage_id and usage.metric = 'sms_segments' and usage.source_key = 'sms:reminder_send:' || send.id::text
    where send.garage_id = win.garage_id and send.sent_at >= win.from_at and send.sent_at < win.to_at
    group by send.kind
  ),
  won as (
    select send.kind, count(*)::integer as booked, coalesce(sum(coalesce(invoiced.total, booking.price_pence, 0)), 0)::bigint as pence
    from public.bookings booking
    cross join win
    join public.reminder_sends send on send.garage_id = booking.garage_id and send.id = booking.reminder_send_id
    left join lateral (
      select sum(invoice.total_pence) as total
      from public.invoices invoice
      where invoice.garage_id = booking.garage_id and invoice.booking_id = booking.id
        and invoice.status in ('issued', 'paid') and invoice.deleted_at is null
    ) invoiced on true
    where booking.garage_id = win.garage_id
      and booking.status not in ('cancelled', 'no_show')
      and booking.deleted_at is null
      and booking.created_at >= win.from_at
      and booking.created_at < win.to_at
    group by send.kind
  )
  select coalesce(sent.kind, won.kind), coalesce(sent.sent, 0), coalesce(won.booked, 0), coalesce(won.pence, 0)::bigint, coalesce(sent.segments, 0)
  from sent full join won on won.kind = sent.kind
  order by case coalesce(sent.kind, won.kind) when 'mot' then 0 when 'service' then 1 when 'review' then 2 when 'missed_call' then 3 else 4 end;
end
$$;

-- Campaign ROI, only when the campaigns feature (P5.5, built separately) is
-- installed: public.campaign_sends with garage_id, sent_at and booking_id.
-- Otherwise one row with available = false. Same rules as reminders.
create function public.report_campaign_roi(p_from date, p_to date)
returns table (available boolean, sent integer, booked integer, pence bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  win record;
  has_table boolean;
begin
  select * into win from public.report_window(p_from, p_to);
  select count(*) = 3 into has_table
  from information_schema.columns col
  where col.table_schema = 'public' and col.table_name = 'campaign_sends'
    and col.column_name in ('garage_id', 'sent_at', 'booking_id');
  if not has_table then
    return query select false, 0, 0, 0::bigint;
    return;
  end if;
  return query execute format($sql$
    select
      true,
      (select count(*)::integer from public.campaign_sends send
        where send.garage_id = %1$L and send.sent_at >= %2$L and send.sent_at < %3$L),
      count(credited.id)::integer,
      coalesce(sum(credited.pence), 0)::bigint
    from (
      select distinct booking.id, coalesce((
        select sum(invoice.total_pence) from public.invoices invoice
        where invoice.garage_id = booking.garage_id and invoice.booking_id = booking.id
          and invoice.status in ('issued', 'paid') and invoice.deleted_at is null
      ), booking.price_pence, 0) as pence
      from public.campaign_sends send
      join public.bookings booking on booking.garage_id = send.garage_id and booking.id = send.booking_id
      where send.garage_id = %1$L
        and booking.status not in ('cancelled', 'no_show')
        and booking.deleted_at is null
        and booking.created_at >= %2$L and booking.created_at < %3$L
    ) credited
  $sql$, win.garage_id, win.from_at, win.to_at);
end
$$;

comment on function public.report_revenue_by_service(date, date) is
  'P5.6: revenue per service for bookings starting in the garage-local dates (inclusive), excluding requested/cancelled/no-show/trashed. invoiced = issued/paid invoices linked to the booking; estimated = the booking price snapshot where there is none. Owners/managers, Pro.';
comment on function public.report_revenue_by_technician(date, date) is
  'P5.6: report_revenue_by_service() grouped by booking_assignments (technician null = unassigned). Owners/managers, Pro.';
comment on function public.report_bay_utilisation(date, date) is
  'P5.6: per resource per garage-local day: open minutes (opening hours minus closures, in garages.timezone) and booked minutes (live bookings'' during inside them). Owners/managers, Pro.';
comment on function public.report_hours(date, date) is
  'P5.6: hours sold (appointment length) vs worked (time in in_progress, else arrived, from booking_events) per technician, finished jobs only. Owners/managers, Pro.';
comment on function public.report_reminder_roi(date, date) is
  'P5.6: reminders sent, bookings and pence won back per kind (reminder_won_back rules) plus metered SMS segments. Owners/managers, Pro.';
comment on function public.report_campaign_roi(date, date) is
  'P5.6: campaign sends, bookings and pence won back when campaign_sends exists; available = false otherwise. Owners/managers, Pro.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.assign_booking_technician(uuid, uuid) from public, anon;
revoke all on function public.report_window(date, date) from public, anon, authenticated, service_role;
revoke all on function public.report_minutes(tstzmultirange) from public, anon, authenticated, service_role;
revoke all on function public.report_jobs(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.report_revenue_by_service(date, date) from public, anon;
revoke all on function public.report_revenue_by_technician(date, date) from public, anon;
revoke all on function public.report_bay_utilisation(date, date) from public, anon;
revoke all on function public.report_hours(date, date) from public, anon;
revoke all on function public.report_reminder_roi(date, date) from public, anon;
revoke all on function public.report_campaign_roi(date, date) from public, anon;

grant execute on function public.assign_booking_technician(uuid, uuid) to authenticated, service_role;
grant execute on function public.report_revenue_by_service(date, date) to authenticated, service_role;
grant execute on function public.report_revenue_by_technician(date, date) to authenticated, service_role;
grant execute on function public.report_bay_utilisation(date, date) to authenticated, service_role;
grant execute on function public.report_hours(date, date) to authenticated, service_role;
grant execute on function public.report_reminder_roi(date, date) to authenticated, service_role;
grant execute on function public.report_campaign_roi(date, date) to authenticated, service_role;
