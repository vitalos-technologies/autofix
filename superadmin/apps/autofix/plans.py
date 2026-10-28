"""Autofix plans across the D17 switch (two plans, Essentials and Pro, with a 14-day Pro trial).

Before the switch ``garages.plan`` holds ``trial``, ``growth`` or ``front_desk``; after it ``essentials``
or ``pro``, with the trial in ``trial_ends_at``. D17 maps ``growth`` -> Essentials, ``front_desk`` -> Pro
and ``trial`` -> Pro on trial. Everything in the super admin reads plans through this module, so it shows
the same thing before and after the plans migration lands (DECISIONS A402).
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


def trial_q(now=None) -> Q:
    """Garages on the Pro trial: the old ``trial`` plan, or a trial end still ahead."""
    return Q(plan=TRIAL) | Q(trial_ends_at__gt=now or timezone.now())


def paid_q(now=None) -> Q:
    return Q(plan__in=DB_VALUES[ESSENTIALS] + DB_VALUES[PRO]) & ~trial_q(now)


def filter_q(key: str, now=None) -> Q | None:
    if key == TRIAL:
        return trial_q(now)
    if key in DB_VALUES:
        return Q(plan__in=DB_VALUES[key]) & ~trial_q(now) if key == PRO else Q(plan__in=DB_VALUES[key])
    return None


def on_trial(garage, now=None) -> bool:
    ends = getattr(garage, "trial_ends_at", None)
    return garage.plan == TRIAL or bool(ends and ends > (now or timezone.now()))


def label(garage, now=None) -> str:
    name = LABELS.get(canonical(garage.plan), garage.plan.replace("_", " ").capitalize())
    return f"{name} (trial)" if on_trial(garage, now) else name


def same_plan(current: str, chosen: str) -> bool:
    """Whether choosing ``chosen`` changes nothing (a garage on the old trial moving to Pro does change)."""
    return current in (chosen, LEGACY.get(chosen))
