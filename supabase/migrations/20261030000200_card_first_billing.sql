-- Card first (DECISIONS D26): a garage that signs up chooses Essentials or Pro, gets one month free
-- on it (D25), and adds a card in Stripe Checkout before using the admin (Stripe's trial: £0.00 due
-- today, charged when the month ends). This migration:
--
--   garages.card_required   true for garages that signed up under D26 (set by sign-up, never by the
--                           column default). While billing runs on Stripe, such a garage stays on
--                           "Finish setting up billing" (/app/billing-setup) until its subscription,
--                           or its group home garage's, is trialing, active or past_due: after an
--                           abandoned Checkout, and again if the subscription is cancelled or unpaid.
--                           Existing garages, garages Vitalos sets up and group sites stay false, so
--                           nothing that works today is blocked. With the mock provider nothing is
--                           gated at all.
--
-- Rollback (manual): drop column card_required.

alter table public.garages
  add column card_required boolean not null default false;

comment on column public.garages.card_required is
  'D26: the garage signed up card first, so the admin waits on a trialing, active or past_due subscription while billing runs on Stripe. False for garages that predate D26 or that Vitalos set up.';
