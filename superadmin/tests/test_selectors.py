"""Read rules: counts, plan mapping, attention, quiet hours (incl. clock changes) and redaction."""

from datetime import UTC, datetime, timedelta

import pytest
from django.utils import timezone

from apps.autofix import selectors
from apps.autofix.models import Booking, Customer, Garage, GarageDomain, Job, Message, ReminderSend
from apps.autofix.redact import clean_reason, redact


def test_garage_counts(seeded, af):
    af.garage(status="suspended", plan="growth")
    af.garage(status="cancelled", plan="trial")
    counts = selectors.garage_counts()
    assert counts == {"total": 4, "onboarding": 1, "active": 1, "suspended": 1, "cancelled": 1, "trial": 1}


def test_subscription_mapping(af):
    af.garage(plan="growth", status="active")
    af.garage(plan="front_desk", status="active")
    af.garage(plan="trial", status="onboarding")
    af.garage(plan="trial", status="active")
    af.garage(plan="growth", status="suspended")
    af.garage(plan="trial", status="cancelled")
    af.garage(plan="growth", status="cancelled")
    assert selectors.subscription_counts() == {"active": 2, "trialing": 2, "pastDue": 1}


def test_plan_counts_skip_cancelled(af):
    af.garage(plan="growth", status="active")
    af.garage(plan="growth", status="cancelled")
    assert selectors.plan_counts() == {"essentials": 1, "pro": 0, "trial": 0}


def test_d17_plans_and_old_plans_count_the_same(af):
    future = timezone.now() + timedelta(days=10)
    past = timezone.now() - timedelta(days=1)
    af.garage(plan="growth", status="active")  # old Essentials
    af.garage(plan="essentials", status="active")
    af.garage(plan="front_desk", status="active")  # old Pro
    af.garage(plan="pro", plan_chosen="pro", status="active", trial_ends_at=past)  # trial over, chose Pro
    af.garage(plan="pro", status="active", trial_ends_at=past)  # trial over, not chosen: Essentials
    af.garage(plan="pro", status="onboarding", trial_ends_at=future)  # D17 trial
    af.garage(plan="trial", status="active")  # old trial
    af.garage(plan="essentials", status="suspended")
    assert selectors.plan_counts() == {"essentials": 4, "pro": 2, "trial": 2}
    assert selectors.subscription_counts() == {"active": 5, "trialing": 2, "pastDue": 1}
    assert selectors.garage_counts()["trial"] == 2


@pytest.mark.parametrize(
    ("plan", "trial_days", "chosen", "label", "key"),
    [
        ("growth", None, None, "Essentials", "essentials"),
        ("front_desk", None, None, "Pro", "pro"),
        ("trial", None, None, "Pro (trial)", "trial"),
        ("essentials", None, None, "Essentials", "essentials"),
        ("pro", None, "pro", "Pro", "pro"),
        ("pro", 5, None, "Pro (trial)", "trial"),
        ("pro", -5, "pro", "Pro", "pro"),
        ("pro", -5, None, "Essentials", "essentials"),  # lapsed trial (garage_effective_plan)
    ],
)
def test_plan_labels_across_d17(af, plan, trial_days, chosen, label, key):
    ends = timezone.now() + timedelta(days=trial_days) if trial_days is not None else None
    garage = af.garage(plan=plan, trial_ends_at=ends, plan_chosen=chosen)
    assert garage.plan_label == label and garage.plan_key == key


def test_plan_filters_across_d17(af):
    af.garage(name="Old essentials", plan="growth")
    af.garage(name="New pro", plan="pro")
    af.garage(name="New trial", plan="pro", trial_ends_at=timezone.now() + timedelta(days=3))
    af.garage(name="Old trial", plan="trial")
    af.garage(name="Lapsed trial", plan="pro", trial_ends_at=timezone.now() - timedelta(days=1))
    names = lambda key: sorted(g.name for g in selectors.garages({"plan": key}))  # noqa: E731
    assert names("essentials") == ["Lapsed trial", "Old essentials"]
    assert names("pro") == ["New pro"]
    assert names("trial") == ["New trial", "Old trial"]


def test_overview_kpis_count_won_back_and_failures(seeded):
    kpis = {kpi.key: kpi.value for group in selectors.overview_kpis().values() for kpi in group}
    assert kpis["bookings_30d"] == "2" and kpis["bookings_7d"] == "1"
    assert kpis["won_back_30d"] == "1"
    assert kpis["messages_sent_30d"] == "1" and kpis["messages_failed_30d"] == "1"
    assert kpis["jobs_failed"] == "1"


def test_deleted_bookings_are_not_counted(seeded, af):
    hartley = seeded["hartley"]
    booking = seeded["booking"]
    af.make(
        Booking,
        garage=hartley,
        customer_id=booking.customer_id,
        vehicle_id=booking.vehicle_id,
        service_id=booking.service_id,
        resource_id=booking.resource_id,
        deleted_at=timezone.now(),
    )
    kpis = {kpi.key: kpi.value for kpi in selectors.overview_kpis()["activity"]}
    assert kpis["bookings_30d"] == "2"


def test_attention_lists_critical_first(seeded):
    items = selectors.attention_items()
    kinds = [item.kind for item in items]
    assert {"job_failed", "domain_failed", "onboarding_stuck", "messaging_failed"} <= set(kinds)
    severities = [item.severity for item in items]
    assert severities == sorted(severities, key=lambda s: 0 if s == "critical" else 1)


def test_attention_redacts_job_errors(seeded):
    job = next(item for item in selectors.attention_items() if item.kind == "job_failed")
    assert "+447700900123" not in job.detail and "AB12 CDE" not in job.detail and "[reg]" in job.detail


def test_stuck_onboarding_respects_the_setting(af, settings):
    af.garage(status="onboarding", created_at=timezone.now() - timedelta(hours=30))
    assert not [i for i in selectors.attention_items() if i.kind == "onboarding_stuck"]
    settings.ONBOARDING_STUCK_HOURS = 24
    assert [i for i in selectors.attention_items() if i.kind == "onboarding_stuck"]


def test_expired_job_locks_need_attention(af):
    af.make(Job, status="running", attempts=1, locked_until=timezone.now() - timedelta(minutes=1))
    assert any(item.kind == "job_stuck" for item in selectors.attention_items())


def test_pending_domains_with_an_error_are_warnings(af):
    garage = af.garage()
    af.make(GarageDomain, garage=garage, status="pending_dns", error="No CNAME yet")
    item = next(i for i in selectors.attention_items() if i.kind == "domain_failed")
    assert item.severity == "warning"


def test_garage_filters(seeded):
    names = lambda f: sorted(g.name for g in selectors.garages(f))  # noqa: E731
    assert names({"q": "hartley"}) == ["Hartley Road Motors"]
    assert names({"q": "DEMO-B"}) == ["Demo Garage B"]
    assert names({"plan": "trial"}) == ["Demo Garage B"]
    assert names({"plan": "essentials"}) == ["Hartley Road Motors"]
    assert names({"status": "active"}) == ["Hartley Road Motors"]
    assert len(names({"plan": "bogus"})) == 2


def test_clean_garage_filters_drops_unknown_values():
    assert selectors.clean_garage_filters({"plan": "x", "status": "y", "q": " a "}) == {
        "q": "a",
        "plan": "",
        "status": "",
    }


def test_garage_list_annotations(seeded):
    hartley = next(g for g in selectors.garages({}) if g.slug == "hartley-road")
    demo = next(g for g in selectors.garages({}) if g.slug == "demo-b")
    assert hartley.member_count == 2 and hartley.bookings_30d == 2 and hartley.last_booking_at
    assert demo.domain_failing and not hartley.domain_failing


# --- Quiet hours ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("utc", "inside"),
    [
        (datetime(2026, 10, 28, 9, 0, tzinfo=UTC), True),  # Wed 09:00 GMT
        (datetime(2026, 10, 28, 8, 59, tzinfo=UTC), False),
        (datetime(2026, 10, 28, 18, 59, tzinfo=UTC), True),
        (datetime(2026, 10, 28, 19, 0, tzinfo=UTC), False),
        (datetime(2026, 10, 31, 10, 0, tzinfo=UTC), True),  # Saturday
        (datetime(2026, 11, 1, 12, 0, tzinfo=UTC), False),  # Sunday
        # Saturday 24 Oct 2026 is BST (UTC+1): 08:30 UTC is 09:30 local, 18:30 UTC is 19:30 local.
        (datetime(2026, 10, 24, 8, 30, tzinfo=UTC), True),
        (datetime(2026, 10, 24, 18, 30, tzinfo=UTC), False),
        # Monday 26 Oct 2026, after the clocks went back: GMT again.
        (datetime(2026, 10, 26, 8, 30, tzinfo=UTC), False),
        (datetime(2026, 10, 26, 18, 30, tzinfo=UTC), True),
        # Monday 30 Mar 2026, after the clocks went forward (BST).
        (datetime(2026, 3, 30, 8, 0, tzinfo=UTC), True),
        (datetime(2026, 3, 30, 7, 59, tzinfo=UTC), False),
    ],
)
def test_messaging_hours_follow_london_time(utc, inside):
    assert selectors.within_messaging_hours(utc) is inside


def test_messaging_hours_use_the_garage_time_zone():
    moment = datetime(2026, 10, 28, 8, 30, tzinfo=UTC)
    assert not selectors.within_messaging_hours(moment, "Europe/London")
    assert selectors.within_messaging_hours(moment, "Europe/Paris")
    assert selectors.within_messaging_hours(moment, "Not/AZone") is False


def test_quiet_hour_breaches_are_counted(af):
    garage = af.garage()
    af.make(ReminderSend, garage=garage, status="sent", sent_at=timezone.now().replace(hour=3, minute=0))
    summary = selectors.messaging_summary()
    assert summary["quiet_hours"]["outside"] >= 1


def test_london_day_start_on_the_clock_change_day():
    # Sunday 25 Oct 2026 01:30 UTC is 01:30 GMT, after the 02:00 BST -> 01:00 GMT change.
    start = selectors.london_day_start(datetime(2026, 10, 25, 1, 30, tzinfo=UTC))
    assert start.astimezone(UTC) == datetime(2026, 10, 24, 23, 0, tzinfo=UTC)


def test_messaging_summary_rates_and_opt_outs(seeded, af):
    hartley = seeded["hartley"]
    af.make(Customer, garage=hartley, opted_out_at=timezone.now(), reminder_consent=False)
    summary = selectors.messaging_summary()
    sms = next(row for row in summary["channels"] if row["channel"] == "sms")
    assert sms["total"] == 2 and sms["delivery_rate"] == "50.0%" and sms["failure_rate"] == "50.0%"
    assert summary["opt_outs"]["recent"] == 1 and summary["opt_outs"]["consented"] == 1
    assert summary["calls"]["missed_calls"] == 1
    assert summary["errors"][0]["error_code"] == "30003"


def test_messaging_summary_scoped_to_a_garage(seeded, af):
    af.make(Message, garage=seeded["demo"], status="failed")
    assert selectors.messaging_summary(garage_id=seeded["hartley"].pk)["channels"][0]["failed"] == 1


def test_signup_funnel(seeded):
    funnel = selectors.signup_funnel(days=0)
    steps = {step["label"]: step["count"] for step in funnel["funnel"]}
    assert steps["Signed up"] == 2 and steps["Accepted the DPA"] == 1
    assert steps["Finished onboarding"] == 1 and steps["Took a first booking"] == 1
    assert steps["Added a custom domain"] == 2
    assert [g.slug for g in funnel["stuck"]] == ["demo-b"]
    assert len(funnel["weekly"]) == 12 and sum(funnel["weekly_values"]) == 2


def test_booking_people_are_masked_and_anonymised_customers_hidden(seeded, af):
    hartley = seeded["hartley"]
    customer = af.make(Customer, garage=hartley, name="Gone Person", anonymised_at=timezone.now())
    booking = seeded["booking"]
    af.make(
        Booking,
        garage=hartley,
        customer=customer,
        vehicle_id=booking.vehicle_id,
        service_id=booking.service_id,
        resource_id=booking.resource_id,
    )
    people = selectors.garage_booking_people(hartley)
    assert all(row["phone"].startswith("•••") for row in people)
    assert "Gone Person" not in [row["customer"] for row in people]


def test_job_health(seeded):
    health = selectors.job_health()
    assert health["totals"]["failed"] == 1
    assert health["failures"][0]["error"].count("[") >= 2


# --- Redaction -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Failed for AB12 CDE", "Failed for [reg]"),
        ("Failed for ab12cde", "Failed for [reg]"),
        ("Prefix A123 BCD", "Prefix [reg]"),
        ("Suffix ABC 123D", "Suffix [reg]"),
        ("Call 07700 900123 now", "Call [phone] now"),
        ("Call +44 7700 900123", "Call [phone]"),
        ("Mail jo@example.co.uk", "Mail [email]"),
        (
            "Job 3c000000-0000-4000-8000-000000000001 failed",
            "Job 3c000000-0000-4000-8000-000000000001 failed",
        ),
        ("", ""),
        (None, ""),
    ],
)
def test_redact(raw, expected):
    assert redact(raw) == expected


def test_redact_truncates():
    assert len(redact("x" * 1000)) == 300


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Good   reason ", "Good reason"),
        ("four", None),
        ("x" * 501, None),
        (None, None),
        ("a\x00b\ncd", "a b cd"),
    ],
)
def test_clean_reason(raw, expected):
    assert clean_reason(raw) == expected


def test_unmanaged_garage_model_reads_masked_view_columns():
    names = {field.name for field in Garage._meta.fields}
    assert "settings" not in names and "address" not in names
    customer = {field.name for field in Customer._meta.fields}
    assert (
        {"phone_masked", "email_masked"} <= customer and "phone" not in customer and "email" not in customer
    )
