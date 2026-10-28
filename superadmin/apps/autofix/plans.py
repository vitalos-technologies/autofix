"""Autofix plans across the D17 switch (two plans, Essentials and Pro, with a 14-day Pro trial).

Before the switch ``garages.plan`` holds ``trial``, ``growth`` or ``front_desk``. After it
(``20261029000100_plans.sql``) it holds ``essentials`` or ``pro``: a garage is on the trial while
``plan = 'pro'`` and ``trial_ends_at`` is ahead, and a trial that ended without the garage choosing Pro
(``plan_chosen``) already counts as Essentials, before the daily ``plans.expire_trials`` job rewrites it
(``public.garage_effective_plan``). D17 maps ``growth`` -> Essentials, ``front_desk`` -> Pro and ``trial``
-> Pro on trial. Everything in the super admin reads plans through this module (DECISIONS A402).
"""

from django.db.models import Q
from django.utils import timezone

ESSENTIALS = "essentials"
PRO = "pro"
TRIAL = "trial"
# What staff can choose (the trial is set by sign-up, not by hand).
PLAN_CHOICES = [(ESSENTIALS, "Essentials"), (PRO, "Pro")]
LABELS = {ESSENTIALS: "Essentials", PRO: "Pro"}
# Every value garages.plan may hold, old or new, and what it means.
CANONICAL = {ESSENTIALS: ESSENTIALS, PRO: PRO, "growth": ESSENTIALS, "front_desk": PRO, TRIAL: PRO}
DB_VALUES = {ESSENTIALS: (ESSENTIALS, "growth"), PRO: (PRO, "front_desk", TRIAL)}
# The value the database accepted before D17, used when it refuses the new one.
LEGACY = {ESSENTIALS: "growth", PRO: "front_desk"}
FILTERS = [(ESSENTIALS, "Essentials"), (PRO, "Pro"), (TRIAL, "On trial")]


def canonical(value: str | None) -> str:
    return CANONICAL.get(value or "", value or "")


def _now(now):
    return now or timezone.now()


def trial_q(now=None) -> Q:
    """Garages on the Pro trial: the old ``trial`` plan, or Pro with a trial end still ahead."""
    return Q(plan=TRIAL) | (Q(plan=PRO) & Q(trial_ends_at__gt=_now(now)))


def lapsed_q(now=None) -> Q:
    """A Pro trial that ended without the garage choosing Pro: Essentials in effect."""
    return Q(plan=PRO) & Q(trial_ends_at__lte=_now(now)) & ~Q(plan_chosen=PRO)


def paid_q(now=None) -> Q:
    return Q(plan__in=DB_VALUES[ESSENTIALS] + DB_VALUES[PRO]) & ~trial_q(now)


def filter_q(key: str, now=None) -> Q | None:
    if key == TRIAL:
        return trial_q(now)
    if key == ESSENTIALS:
        return Q(plan__in=DB_VALUES[ESSENTIALS]) | lapsed_q(now)
    if key == PRO:
        return Q(plan__in=DB_VALUES[PRO]) & ~trial_q(now) & ~lapsed_q(now)
    return None


def on_trial(garage, now=None) -> bool:
    ends = getattr(garage, "trial_ends_at", None)
    return garage.plan == TRIAL or (garage.plan == PRO and bool(ends and ends > _now(now)))


def lapsed(garage, now=None) -> bool:
    ends = getattr(garage, "trial_ends_at", None)
    return (
        garage.plan == PRO
        and bool(ends and ends <= _now(now))
        and getattr(garage, "plan_chosen", None) != PRO
    )


def effective(garage, now=None) -> str:
    """The plan the garage may use now (``public.garage_effective_plan``)."""
    return ESSENTIALS if lapsed(garage, now) else canonical(garage.plan)


def label(garage, now=None) -> str:
    key = effective(garage, now)
    name = LABELS.get(key, (garage.plan or "").replace("_", " ").capitalize())
    return f"{name} (trial)" if on_trial(garage, now) else name


def same_plan(garage, chosen: str, now=None) -> bool:
    """Whether choosing ``chosen`` changes nothing. Choosing Pro during the trial does change: it makes
    Pro the garage's chosen plan and ends the trial. So does settling a lapsed trial either way."""
    if on_trial(garage, now) or lapsed(garage, now):
        return False
    return garage.plan in (chosen, LEGACY.get(chosen))
