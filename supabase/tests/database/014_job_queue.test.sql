begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;

select plan(52);

-- Job queue (P3.6): enqueue_job(), claim_jobs(), finish_job(), fail_job().
-- The queue's clock is the transaction's now(), constant inside this test, so
-- run_at and locked_until are compared with now() exactly. The last section
-- runs two real sessions through dblink against committed rows of kind
-- pgtap.skip_locked (removed before and after) to show that concurrent
-- workers never claim the same job and never wait for each other.

insert into public.garages (id, slug, name, booking_prefix) values
  ('a1400000-0000-4000-8000-000000000001', 'pgtap-jobs-a', 'Jobs Garage A', 'JBA');

set local role service_role;

-- ---------------------------------------------------------------------------
-- enqueue_job
-- ---------------------------------------------------------------------------

create temp table queued (label text primary key, job public.jobs not null);
grant all on queued to service_role;

insert into queued select 'plain', public.enqueue_job('pgtap.enqueue', '{"n": 1}'::jsonb);
select is(
  (select concat_ws('|', (job).status, (job).attempts, (job).max_attempts, (job).run_at = now(), coalesce((job).garage_id::text, 'platform'),
                    (job).payload::text, (job).locked_until is null, (job).finished_at is null) from queued where label = 'plain'),
  'queued|0|5|t|platform|{"n": 1}|t|t',
  'a job is queued to run now with 5 attempts, platform-wide unless a garage is given'
);
insert into queued select 'deduped', public.enqueue_job('pgtap.enqueue', '{"n": 2}'::jsonb, now() + interval '1 hour', 'pgtap-014:once', 'a1400000-0000-4000-8000-000000000001');
insert into queued select 'deduped-again', public.enqueue_job('pgtap.enqueue', '{"n": 3}'::jsonb, now(), 'pgtap-014:once', null);
select is(
  (select (job).id from queued where label = 'deduped-again'),
  (select (job).id from queued where label = 'deduped'),
  'the same dedupe key returns the job already queued'
);
select is(
  (select concat_ws('|', (job).payload::text, (job).run_at = now() + interval '1 hour', (job).garage_id) from queued where label = 'deduped-again'),
  '{"n": 2}|t|a1400000-0000-4000-8000-000000000001',
  'and keeps its original payload, run time and garage'
);
select is(
  (select count(*)::integer from public.jobs where dedupe_key = 'pgtap-014:once'),
  1, 'only one job exists for the dedupe key'
);
select is(
  (select count(*)::integer from (select public.enqueue_job('pgtap.enqueue') union all select public.enqueue_job('pgtap.enqueue', null, null, '  ', null)) twice),
  2, 'jobs without a dedupe key (or a blank one) are always new'
);
select throws_ok($$select public.enqueue_job(null)$$, '22023', null, 'a job needs a kind');
select throws_ok($$select public.enqueue_job('pgtap.enqueue', '[1]'::jsonb)$$, '22023', null, 'a job payload is a JSON object');
select throws_ok($$select public.enqueue_job('Not A Kind')$$, '23514', null, 'job kinds are dotted lower-case names');
select throws_ok(
  $$select public.enqueue_job('pgtap.enqueue', '{}'::jsonb, null, null, 'f1400000-0000-4000-8000-000000000001')$$,
  '23503', null, 'a job can only name a garage that exists'
);

-- ---------------------------------------------------------------------------
-- claim_jobs
-- ---------------------------------------------------------------------------

insert into public.jobs (id, kind, run_at) values
  ('c1400000-0000-4000-8000-000000000001', 'pgtap.claim', now() - interval '3 minutes'),
  ('c1400000-0000-4000-8000-000000000002', 'pgtap.claim', now() - interval '2 minutes'),
  ('c1400000-0000-4000-8000-000000000003', 'pgtap.claim', now() - interval '1 minute'),
  ('c1400000-0000-4000-8000-000000000004', 'pgtap.claim', now() + interval '1 hour'),
  ('c1400000-0000-4000-8000-000000000005', 'pgtap.other', now() - interval '5 minutes');

create temp table claimed (round integer, job public.jobs not null);
grant all on claimed to service_role;

insert into claimed select 1, claimed_job from public.claim_jobs('pgtap.claim', 2) claimed_job;
select is(
  (select array_agg((job).id order by (job).id) from claimed where round = 1),
  array['c1400000-0000-4000-8000-000000000001', 'c1400000-0000-4000-8000-000000000002']::uuid[],
  'claim_jobs takes the oldest due jobs of the kind, up to the limit'
);
select is(
  (select string_agg(distinct concat_ws('|', (job).status, (job).attempts, (job).locked_until = now() + interval '5 minutes'), ',') from claimed where round = 1),
  'running|1|t',
  'claimed jobs are running, on their first attempt, locked for 5 minutes'
);
select is(
  (select string_agg(status, ',' order by id) from public.jobs where id in ('c1400000-0000-4000-8000-000000000001', 'c1400000-0000-4000-8000-000000000002')),
  'running,running', 'the claim is stored'
);
insert into claimed select 2, claimed_job from public.claim_jobs('pgtap.claim', 10) claimed_job;
select is(
  (select array_agg((job).id) from claimed where round = 2),
  array['c1400000-0000-4000-8000-000000000003']::uuid[],
  'a second claim gets the remaining due job only: not the running ones, not the future one'
);
select is(
  (select count(*)::integer from public.claim_jobs('pgtap.claim', 10)),
  0, 'with nothing due, a claim returns nothing'
);
select is(
  (select status || '/' || attempts from public.jobs where id = 'c1400000-0000-4000-8000-000000000005'),
  'queued/0', 'jobs of other kinds are left alone'
);
select throws_ok($$select * from public.claim_jobs('pgtap.claim', 0)$$, '22023', null, 'the limit must be at least 1');
select throws_ok($$select * from public.claim_jobs(null, 5)$$, '22023', null, 'a claim names one kind');

-- A worker died: once its lock runs out, the job is claimed again.
update public.jobs set locked_until = now() - interval '1 second' where id = 'c1400000-0000-4000-8000-000000000001';
insert into claimed select 3, claimed_job from public.claim_jobs('pgtap.claim', 10) claimed_job;
select is(
  (select array_agg((job).id || '/' || (job).attempts || '/' || ((job).locked_until = now() + interval '5 minutes')) from claimed where round = 3),
  array['c1400000-0000-4000-8000-000000000001/2/true'],
  'a running job whose lock expired is claimed again, as its second attempt'
);

-- ... unless that was its last attempt: then it fails instead.
update public.jobs set attempts = 5, locked_until = now() - interval '1 second' where id = 'c1400000-0000-4000-8000-000000000002';
select is(
  (select count(*)::integer from public.claim_jobs('pgtap.claim', 10)),
  0, 'an expired job on its last attempt is not claimed again'
);
select is(
  (select concat_ws('|', status, locked_until is null, finished_at = now(), last_error like 'LOCK_EXPIRED%') from public.jobs where id = 'c1400000-0000-4000-8000-000000000002'),
  'failed|t|t|t', 'it is failed with a LOCK_EXPIRED error'
);

-- ---------------------------------------------------------------------------
-- finish_job
-- ---------------------------------------------------------------------------

select is(public.finish_job('c1400000-0000-4000-8000-000000000003'), true, 'finish_job completes a running job');
select is(
  (select concat_ws('|', status, locked_until is null, finished_at = now()) from public.jobs where id = 'c1400000-0000-4000-8000-000000000003'),
  'done|t|t', 'a finished job is done, unlocked and timestamped'
);
select is(public.finish_job('c1400000-0000-4000-8000-000000000003'), false, 'finishing it again does nothing');
select is(public.finish_job('c1400000-0000-4000-8000-000000000004'), false, 'a job that is not running cannot be finished');
select is(public.finish_job(gen_random_uuid()), false, 'an unknown job cannot be finished');

-- ---------------------------------------------------------------------------
-- fail_job: retries with 2^attempts minutes of backoff, then failed
-- ---------------------------------------------------------------------------

insert into public.jobs (id, kind, run_at) values
  ('c1400000-0000-4000-8000-000000000011', 'pgtap.retry', now() - interval '1 minute'),
  ('c1400000-0000-4000-8000-000000000012', 'pgtap.final', now() - interval '1 minute'),
  ('c1400000-0000-4000-8000-000000000013', 'pgtap.fatal', now() - interval '1 minute');

select is((select count(*)::integer from public.claim_jobs('pgtap.retry', 1)), 1, 'claim the retry job (attempt 1)');
select is(public.fail_job('c1400000-0000-4000-8000-000000000011', 'DVSA_TIMEOUT'), 'queued', 'a first failure queues a retry');
select is(
  (select concat_ws('|', status, attempts, run_at = now() + interval '2 minutes', locked_until is null, finished_at is null, last_error)
   from public.jobs where id = 'c1400000-0000-4000-8000-000000000011'),
  'queued|1|t|t|t|DVSA_TIMEOUT', 'the retry runs 2 minutes later (2^1) and keeps the error'
);
select is((select count(*)::integer from public.claim_jobs('pgtap.retry', 1)), 0, 'the job is not claimable before its retry time');
update public.jobs set run_at = now() where id = 'c1400000-0000-4000-8000-000000000011';
select is((select count(*)::integer from public.claim_jobs('pgtap.retry', 1)), 1, 'claim it again (attempt 2)');
select is(public.fail_job('c1400000-0000-4000-8000-000000000011', 'DVSA_TIMEOUT again'), 'queued', 'a second failure queues another retry');
select is(
  (select (run_at = now() + interval '4 minutes')::text || '/' || attempts from public.jobs where id = 'c1400000-0000-4000-8000-000000000011'),
  'true/2', 'the second retry waits 4 minutes (2^2)'
);

update public.jobs set attempts = 4 where id = 'c1400000-0000-4000-8000-000000000012';
select is((select max(attempts) from public.claim_jobs('pgtap.final', 1)), 5, 'claim a job on its fifth (last) attempt');
select is(public.fail_job('c1400000-0000-4000-8000-000000000012', 'still broken'), 'failed', 'failing the last attempt fails the job');
select is(
  (select concat_ws('|', status, attempts, locked_until is null, finished_at = now(), run_at < now(), last_error)
   from public.jobs where id = 'c1400000-0000-4000-8000-000000000012'),
  'failed|5|t|t|t|still broken', 'a failed job is unlocked, timestamped and not rescheduled'
);
select is((select count(*)::integer from public.claim_jobs('pgtap.final', 1)), 0, 'a failed job is never claimed again');

select is((select count(*)::integer from public.claim_jobs('pgtap.fatal', 1)), 1, 'claim a job that will fail permanently');
select is(
  public.fail_job('c1400000-0000-4000-8000-000000000013', repeat('x', 2500), false),
  'failed', 'p_retry => false fails the job on its first attempt'
);
select is(
  (select char_length(last_error) from public.jobs where id = 'c1400000-0000-4000-8000-000000000013'),
  2000, 'errors are stored up to 2000 characters'
);
select is(public.fail_job('c1400000-0000-4000-8000-000000000013', 'again'), null, 'a job that is not running cannot be failed');
select is(
  (select status || '/' || (last_error = repeat('x', 2000)) from public.jobs where id = 'c1400000-0000-4000-8000-000000000013'),
  'failed/true', 'and a refused fail_job leaves the job as it was'
);

reset role;

select ok(
  pg_get_functiondef('public.claim_jobs(text,integer)'::regprocedure) ~* 'for update skip locked',
  'claim_jobs locks candidates with FOR UPDATE SKIP LOCKED'
);
set local role authenticated;
select throws_ok($$select * from public.claim_jobs('pgtap.claim', 1)$$, '42501', null, 'signed-in staff cannot claim jobs');
select throws_ok($$select public.enqueue_job('pgtap.enqueue')$$, '42501', null, 'signed-in staff cannot enqueue jobs');
reset role;
set local role anon;
select throws_ok($$select public.finish_job(gen_random_uuid())$$, '42501', null, 'anon cannot touch the queue');
reset role;

-- ---------------------------------------------------------------------------
-- Two concurrent workers (dblink): skip locked, never the same job
-- ---------------------------------------------------------------------------
-- The peers connect to this server's own address with the local stack's
-- password (supabase test db connects over the Docker network, where
-- non-loopback connections use password auth, which dblink requires). Where
-- that is not possible the section is skipped and says so.

create function pg_temp.peer_connstr()
returns text
language sql
as $$
  select format('host=%s port=%s dbname=%s user=postgres password=postgres',
                host(inet_server_addr()), inet_server_port(), current_database())
$$;

create function pg_temp.peers_available()
returns boolean
language plpgsql
as $$
begin
  if inet_server_addr() is null or host(inet_server_addr()) in ('127.0.0.1', '::1') then
    return false;
  end if;
  perform extensions.dblink_connect('pgtap_seed', pg_temp.peer_connstr());
  perform extensions.dblink_connect('pgtap_worker_1', pg_temp.peer_connstr());
  perform extensions.dblink_connect('pgtap_worker_2', pg_temp.peer_connstr());
  return true;
exception
  when others then
    return false;
end
$$;

create function pg_temp.peer_count(p_status text default null)
returns integer
language sql
as $$
  select count from extensions.dblink('pgtap_seed', format(
    'select count(*)::integer from public.jobs where kind = %L and (%L::text is null or status = %L::text)',
    'pgtap.skip_locked', p_status, p_status)) as result(count integer)
$$;

create function pg_temp.peer_claim(p_connection text, p_limit integer)
returns uuid[]
language sql
as $$
  select coalesce(array_agg(id order by id), '{}'::uuid[])
  from extensions.dblink(p_connection, format('select id from public.claim_jobs(%L, %s)', 'pgtap.skip_locked', p_limit)) as result(id uuid)
$$;

create temp table peer as select pg_temp.peers_available() as available;
create temp table peer_claims (worker text primary key, ids uuid[] not null);

select case when (select available from peer) then diag('dblink peers connected to ' || host(inet_server_addr()))
            else diag('dblink peers unavailable (server address ' || coalesce(host(inet_server_addr()), 'unix socket') || '): skipping the two-session test') end;

-- Committed rows both peers can see (the test's own transaction cannot share
-- its uncommitted rows). Leftovers from an aborted run are removed first.
create function pg_temp.peer_seed()
returns integer
language plpgsql
as $$
begin
  perform extensions.dblink_exec('pgtap_seed', $sql$delete from public.jobs where kind = 'pgtap.skip_locked'$sql$);
  perform extensions.dblink_exec('pgtap_seed',
    $sql$insert into public.jobs (kind, run_at) select 'pgtap.skip_locked', now() - make_interval(mins => n) from generate_series(1, 4) n$sql$);
  return pg_temp.peer_count();
end
$$;

create function pg_temp.peer_first_claim()
returns integer
language plpgsql
as $$
begin
  perform extensions.dblink_exec('pgtap_worker_1', 'begin');
  perform extensions.dblink_exec('pgtap_worker_1', 'set local role service_role');
  insert into peer_claims values ('worker_1', pg_temp.peer_claim('pgtap_worker_1', 2));
  return cardinality((select ids from peer_claims where worker = 'worker_1'));
end
$$;

-- Worker 2 runs while worker 1's transaction still holds its two rows. With
-- lock_timeout 2s, a claim that waited for worker 1 would raise instead.
create function pg_temp.peer_second_claim()
returns integer
language plpgsql
as $$
begin
  perform extensions.dblink_exec('pgtap_worker_2', 'begin');
  perform extensions.dblink_exec('pgtap_worker_2', 'set local role service_role');
  perform extensions.dblink_exec('pgtap_worker_2', 'set local lock_timeout = ''2s''');
  insert into peer_claims values ('worker_2', pg_temp.peer_claim('pgtap_worker_2', 10));
  return cardinality((select ids from peer_claims where worker = 'worker_2'));
end
$$;

create function pg_temp.peer_finish()
returns text
language plpgsql
as $$
declare
  outcome text;
begin
  perform extensions.dblink_exec('pgtap_worker_1', 'commit');
  perform extensions.dblink_exec('pgtap_worker_2', 'rollback');
  outcome := pg_temp.peer_count('running') || ' running/' || pg_temp.peer_count('queued') || ' queued';
  return outcome;
end
$$;

create function pg_temp.peer_cleanup()
returns integer
language plpgsql
as $$
declare
  remaining integer;
begin
  perform extensions.dblink_exec('pgtap_seed', $sql$delete from public.jobs where kind = 'pgtap.skip_locked'$sql$);
  remaining := pg_temp.peer_count();
  perform extensions.dblink_disconnect('pgtap_worker_1');
  perform extensions.dblink_disconnect('pgtap_worker_2');
  perform extensions.dblink_disconnect('pgtap_seed');
  return remaining;
end
$$;

select case when (select available from peer)
  then is(pg_temp.peer_seed(), 4, 'four committed jobs are visible to both workers')
  else skip('dblink peers unavailable', 1) end;
select case when (select available from peer)
  then is(pg_temp.peer_first_claim(), 2, 'worker 1 claims two jobs and keeps its transaction open')
  else skip('dblink peers unavailable', 1) end;
select case when (select available from peer)
  then is(pg_temp.peer_second_claim(), 2, 'worker 2 claims the other two at once, skipping the rows worker 1 has locked')
  else skip('dblink peers unavailable', 1) end;
select case when (select available from peer)
  then is(
    (select not (one.ids && two.ids) and cardinality(one.ids || two.ids) = 4
     from peer_claims one, peer_claims two where one.worker = 'worker_1' and two.worker = 'worker_2'),
    true, 'no job is claimed by both workers')
  else skip('dblink peers unavailable', 1) end;
select case when (select available from peer)
  then is(cardinality(pg_temp.peer_claim('pgtap_worker_2', 10)), 0, 'with every job locked or taken, a claim returns nothing without waiting')
  else skip('dblink peers unavailable', 1) end;
select case when (select available from peer)
  then is(pg_temp.peer_finish(), '2 running/2 queued', 'worker 1''s claims commit; worker 2''s roll back and the jobs are queued again')
  else skip('dblink peers unavailable', 1) end;
select case when (select available from peer)
  then is(pg_temp.peer_cleanup(), 0, 'the committed test jobs are removed')
  else skip('dblink peers unavailable', 1) end;

select * from finish();
rollback;
