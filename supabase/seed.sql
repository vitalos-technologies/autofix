-- Local seed data lives in the demo seed script (P1.9, `pnpm db:seed`), which
-- creates the demo garages, their staff, services and sample customers.
--
-- Every tenant row needs a garage: insert garages first, then rows with an
-- explicit garage_id (or send the x-garage-id header as the service role).
-- Staff access comes from public.garage_members, not an email allowlist.
select 1;
