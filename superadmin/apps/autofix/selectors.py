"""Reads over Pitline data (the ``autofix`` alias). Business rules for what each page shows live here.

Every public function is wrapped in ``db.reads``: a missing or failing Pitline connection becomes
``AutofixUnavailable`` and the page says so instead of breaking. Time windows are computed in
Europe/London (the garages' time zone) and timestamps stay ``timestamptz`` throughout.

Nothing here returns message bodies, phone numbers, email addresses, registrations or job payloads:
the database views do not carry them (contact details and registrations arrive already masked). Two
exceptions: ``voicemail``, a Twilio recording link read only by the playback proxy and never rendered; and
contact page enquiries (``enquiry``), sent to Vitalos itself: staff need the sender's details to reply, so
the view carries them and only SuperAdmin and Support pages read them.
"""

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import Count, Exists, Max, OuterRef, Q, Subquery
from django.urls import reverse
from django.utils import timezone

from apps.core.kpi import Kpi

from . import plans
from .db import reads
from .models import (
    ENQUIRY_STATUSES,
    ENQUIRY_TOPICS,
    GARAGE_STATUSES,
    PLATFORM_LINE_LABEL,
    Booking,
    Call,
    CallVoicemail,
    Customer,
    Garage,
    GarageAgreement,
    GarageDomain,
    GarageInvite,
    GarageMember,
    Job,
    Message,
    PlatformAdmin,
    PlatformAuditEntry,
    PlatformEnquiry,
    PlatformImpersonation,
    ReminderSend,
    Resource,
    Service,
)
from .redact import redact

LONDON = ZoneInfo("Europe/London")
QUIET_START = time(9, 0)
QUIET_END = time(19, 0)
ATTENTION_LIMIT = 12
RECENT_FAILURES = 20
SENT_STATUSES = ("sent", "delivered")
PLAN_FILTERS = dict(plans.FILTERS)
STATUS_LABELS = dict(GARAGE_STATUSES)


# --- Time helpers ------------------------------------------------------------------------------


def london_day_start(moment: datetime | None = None) -> datetime:
    local = (moment or timezone.now()).astimezone(LONDON)
    return datetime.combine(local.date(), time.min, tzinfo=LONDON)


def within_messaging_hours(moment: datetime, zone: str = "Europe/London") -> bool:
    """CLAUDE.md rule 5: 09:00 to 19:00, Monday to Saturday, in the garage's time zone."""
    try:
        tz = ZoneInfo(zone or "Europe/London")
    except (KeyError, ValueError):
        tz = LONDON
    local = moment.astimezone(tz)
    return local.weekday() < 6 and QUIET_START <= local.time() < QUIET_END


def _stuck_cutoff(now: datetime) -> datetime:
    return now - timedelta(hours=settings.ONBOARDING_STUCK_HOURS)


def _pct(part: int, whole: int) -> str:
    return f"{(100 * part / whole):.1f}%" if whole else "—"


# --- Platform admins (link field) --------------------------------------------------------------


@reads
def platform_admin_choices() -> list[tuple[str, str]]:
    return [
        (str(admin.user_id), f"{admin.display_name or 'Unnamed'} ({admin.email or admin.user_id})")
        for admin in PlatformAdmin.objects.all()
    ]


@reads
def platform_admins() -> list[PlatformAdmin]:
    return list(PlatformAdmin.objects.all())


# --- Overview ----------------------------------------------------------------------------------


@reads
def garage_counts() -> dict[str, int]:
    rows = dict(
        Garage.objects.values_list("status").annotate(total=Count("id")).values_list("status", "total")
    )
    total = sum(rows.values())
    trial = Garage.objects.filter(plans.trial_q(), status__in=("onboarding", "active")).count()
    return {
        "total": total,
        "onboarding": rows.get("onboarding", 0),
        "active": rows.get("active", 0),
        "suspended": rows.get("suspended", 0),
        "cancelled": rows.get("cancelled", 0),
        "trial": trial,
    }


@reads
def plan_counts() -> dict[str, int]:
    """Garages that are not cancelled: Essentials (a lapsed trial included), Pro and on the Pro trial."""
    live = Garage.objects.exclude(status="cancelled")
    return {
        "essentials": live.filter(plans.filter_q(plans.ESSENTIALS)).count(),
        "pro": live.filter(plans.filter_q(plans.PRO)).count(),
        "trial": live.filter(plans.trial_q()).count(),
    }


@reads
def subscription_counts() -> dict[str, int]:
    """Plans mapped to the Product Pipeline's subscription states (ADR-044; DECISIONS A403).

    active: Essentials or Pro, not on trial, on an active garage. trialing: on the Pro trial (old
    ``trial`` plan or ``trial_ends_at`` ahead), onboarding or active. pastDue: a paid plan on a
    suspended garage (Pitline suspends for non-payment; there is no billing system yet).
    """
    return {
        "active": Garage.objects.filter(plans.paid_q(), status="active").count(),
        "trialing": Garage.objects.filter(plans.trial_q(), status__in=("onboarding", "active")).count(),
        "pastDue": Garage.objects.filter(plans.paid_q(), status="suspended").count(),
    }


@reads
def overview_kpis(now: datetime | None = None) -> dict[str, list[Kpi]]:
    now = now or timezone.now()
    today = london_day_start(now)
    week = now - timedelta(days=7)
    month = now - timedelta(days=30)
    counts = garage_counts.__wrapped__()
    bookings = Booking.objects.filter(deleted_at__isnull=True)
    made = bookings.aggregate(
        today=Count("id", filter=Q(created_at__gte=today)),
        week=Count("id", filter=Q(created_at__gte=week)),
        month=Count("id", filter=Q(created_at__gte=month)),
        won_back=Count("id", filter=Q(created_at__gte=month, reminder_send_id__isnull=False)),
    )
    sends = ReminderSend.objects.filter(sent_at__gte=month, status__in=SENT_STATUSES).count()
    outbound = Message.objects.filter(direction="outbound", created_at__gte=month)
    messages = outbound.aggregate(
        sent=Count("id", filter=Q(status__in=SENT_STATUSES)),
        failed=Count("id", filter=Q(status="failed")),
    )
    failed_jobs = Job.objects.filter(status="failed").count()
    return {
        "garages": [
            Kpi("garages_total", "Garages", str(counts["total"]), "All time"),
            Kpi("garages_active", "Active", str(counts["active"]), "Now"),
            Kpi("garages_trial", "On trial", str(counts["trial"]), "Trial plan, not cancelled"),
            Kpi("garages_suspended", "Suspended", str(counts["suspended"]), "Now"),
            Kpi("garages_cancelled", "Cancelled", str(counts["cancelled"]), "All time"),
        ],
        "activity": [
            Kpi("bookings_today", "Bookings today", str(made["today"]), "Made since 00:00 (Europe/London)"),
            Kpi("bookings_7d", "Bookings, 7 days", str(made["week"]), "Made in the last 7 days"),
            Kpi("bookings_30d", "Bookings, 30 days", str(made["month"]), "Made in the last 30 days"),
            Kpi("reminders_30d", "Reminders sent", str(sends), "Last 30 days"),
            Kpi("won_back_30d", "Won back", str(made["won_back"]), "Bookings from a reminder, 30 days"),
            Kpi("messages_sent_30d", "Messages sent", str(messages["sent"]), "Texts and emails, 30 days"),
            Kpi(
                "messages_failed_30d",
                "Messages failed",
                str(messages["failed"]),
                f"{_pct(messages['failed'], messages['sent'] + messages['failed'])} of sends, 30 days",
            ),
            Kpi("jobs_failed", "Failed jobs", str(failed_jobs), "Waiting for a retry"),
        ],
    }


@dataclass(frozen=True)
class AttentionItem:
    kind: str
    severity: str  # "critical" or "warning"
    title: str
    detail: str
    url: str
    when: datetime | None = None
    garage_id: str = ""
    key: str = field(default="", compare=False)


@reads
def attention_items(now: datetime | None = None, limit: int = ATTENTION_LIMIT) -> list[AttentionItem]:
    """Failed jobs, expired job locks, domains failing verification, onboarding stuck over 48 hours
    and Twilio/Resend failures in the last 24 hours. Critical first, newest first."""
    now = now or timezone.now()
    items: list[AttentionItem] = []
    for job in Job.objects.filter(status="failed").select_related("garage").order_by("-finished_at")[:limit]:
        where = f" at {job.garage.name}" if job.garage_id and job.garage else ""
        items.append(
            AttentionItem(
                "job_failed",
                "critical",
                f"Job {job.kind} failed{where}",
                redact(job.last_error) or "No error recorded",
                reverse("autofix:jobs"),
                job.finished_at,
                str(job.garage_id or ""),
                key=f"job:{job.id}",
            )
        )
    for job in Job.objects.filter(status="running", locked_until__lt=now).order_by("locked_until")[:limit]:
        items.append(
            AttentionItem(
                "job_stuck",
                "warning",
                f"Job {job.kind} is stuck (lock expired)",
                f"Attempt {job.attempts} of {job.max_attempts}",
                reverse("autofix:jobs"),
                job.locked_until,
                key=f"lock:{job.id}",
            )
        )
    failing = GarageDomain.objects.filter(deleted_at__isnull=True, kind="custom").filter(
        Q(status="failed") | Q(status__in=("pending_dns", "verifying"), error__isnull=False)
    )
    for domain in failing.select_related("garage").order_by("-updated_at")[:limit]:
        items.append(
            AttentionItem(
                "domain_failed",
                "critical" if domain.status == "failed" else "warning",
                f"{domain.hostname} is failing verification",
                f"{domain.garage.name}: {redact(domain.error) or domain.get_status_display()}",
                f"{reverse('autofix:garage', args=[domain.garage_id])}?tab=domains",
                domain.last_checked_at or domain.updated_at,
                str(domain.garage_id),
                key=f"domain:{domain.id}:{domain.status}",
            )
        )
    stuck = Garage.objects.filter(status="onboarding", created_at__lt=_stuck_cutoff(now)).order_by(
        "created_at"
    )
    for garage in stuck[:limit]:
        hours = int((now - garage.created_at).total_seconds() // 3600)
        items.append(
            AttentionItem(
                "onboarding_stuck",
                "warning",
                f"{garage.name} has been onboarding for {hours} hours",
                "No DPA or onboarding not completed",
                reverse("autofix:garage", args=[garage.id]),
                garage.created_at,
                str(garage.id),
                key=f"onboarding:{garage.id}",
            )
        )
    failures = (
        Message.objects.filter(
            direction="outbound", status="failed", created_at__gte=now - timedelta(hours=24)
        )
        .values("provider", "channel")
        .annotate(total=Count("id"), latest=Max("created_at"))
        .order_by("-total")
    )
    for row in failures:
        provider = {"twilio": "Twilio", "resend": "Resend"}.get(row["provider"], row["provider"].title())
        items.append(
            AttentionItem(
                "messaging_failed",
                "critical" if row["total"] >= 10 else "warning",
                f"{provider}: {row['total']} {row['channel']} failure{'s' if row['total'] != 1 else ''} in 24 hours",
                "See Messaging for error codes",
                reverse("autofix:messaging"),
                row["latest"],
                key=f"messaging:{row['provider']}:{row['channel']}:{london_day_start(now).date()}",
            )
        )
    rank = {"critical": 0, "warning": 1}
    epoch = datetime(1970, 1, 1, tzinfo=LONDON)
    items.sort(key=lambda item: (rank[item.severity], -(item.when or epoch).timestamp()))
    return items[:limit]


# --- Garages -----------------------------------------------------------------------------------


def _garage_filters(queryset, filters: dict):
    if filters.get("q"):
        needle = filters["q"]
        queryset = queryset.filter(Q(name__icontains=needle) | Q(slug__icontains=needle.lower()))
    plan_q = plans.filter_q(filters.get("plan", ""))
    if plan_q is not None:
        queryset = queryset.filter(plan_q)
    if filters.get("status") in STATUS_LABELS:
        queryset = queryset.filter(status=filters["status"])
    return queryset


def clean_garage_filters(params) -> dict[str, str]:
    filters = {key: (params.get(key) or "").strip()[:80] for key in ("q", "plan", "status")}
    if filters["plan"] not in PLAN_FILTERS:
        filters["plan"] = ""
    if filters["status"] not in STATUS_LABELS:
        filters["status"] = ""
    return filters


@reads
def garages(filters: dict, now: datetime | None = None):
    now = now or timezone.now()
    month = now - timedelta(days=30)
    custom_failing = GarageDomain.objects.filter(
        garage_id=OuterRef("pk"), kind="custom", deleted_at__isnull=True, status="failed"
    )
    queryset = _garage_filters(Garage.objects.all(), filters).annotate(
        member_count=Count("members", distinct=True),
        bookings_30d=Count(
            "bookings",
            filter=Q(bookings__created_at__gte=month, bookings__deleted_at__isnull=True),
            distinct=True,
        ),
        last_booking_at=Max("bookings__created_at"),
        domain_failing=Exists(custom_failing),
    )
    return queryset


@reads
def garages_for_export(filters: dict, ids: list | None = None) -> list:
    queryset = garages.__wrapped__(filters)
    if ids:
        queryset = queryset.filter(pk__in=ids)
    return list(queryset.order_by("name"))


@reads
def garage(pk) -> Garage | None:
    return Garage.objects.filter(pk=pk).first()


@reads
def garages_by_ids(ids) -> list[Garage]:
    found = {str(item.pk): item for item in Garage.objects.filter(pk__in=ids)}
    return [found[str(pk)] for pk in ids if str(pk) in found]


@reads
def garage_overview(garage_obj: Garage, now: datetime | None = None) -> dict:
    now = now or timezone.now()
    today = london_day_start(now)
    bookings = Booking.objects.filter(garage=garage_obj, deleted_at__isnull=True)
    made = bookings.aggregate(
        today=Count("id", filter=Q(created_at__gte=today)),
        week=Count("id", filter=Q(created_at__gte=now - timedelta(days=7))),
        month=Count("id", filter=Q(created_at__gte=now - timedelta(days=30))),
        upcoming=Count("id", filter=Q(starts_at__gte=now, status__in=Booking.BOOKED_STATUSES)),
    )
    customers = Customer.objects.filter(garage=garage_obj, anonymised_at__isnull=True)
    return {
        "kpis": [
            Kpi("g_bookings_today", "Bookings today", str(made["today"]), "Made since 00:00"),
            Kpi("g_bookings_7d", "Bookings, 7 days", str(made["week"]), "Made"),
            Kpi("g_bookings_30d", "Bookings, 30 days", str(made["month"]), "Made"),
            Kpi("g_upcoming", "Upcoming", str(made["upcoming"]), "Booked from now on"),
        ],
        "facts": [
            ("Plan", garage_obj.plan_label),
            (
                "Trial ends",
                timezone.localtime(garage_obj.trial_ends_at).strftime("%d %b %Y")
                if garage_obj.trial_ends_at
                else "—",
            ),
            ("Status", STATUS_LABELS.get(garage_obj.status, garage_obj.status)),
            ("Free address", f"{garage_obj.slug}.pitline.co.uk"),
            ("Time zone", garage_obj.timezone),
            ("MOT", "Enabled" if garage_obj.mot_enabled else "Not offered"),
            ("Team", str(GarageMember.objects.filter(garage=garage_obj).count())),
            ("Customers", str(customers.count())),
            (
                "Opted in to reminders",
                str(customers.filter(reminder_consent=True, opted_out_at__isnull=True).count()),
            ),
            ("Services", str(Service.objects.filter(garage=garage_obj, deleted_at__isnull=True).count())),
            ("Bays and vans", str(Resource.objects.filter(garage=garage_obj, active=True).count())),
            (
                "DPA accepted",
                "Yes" if GarageAgreement.objects.filter(garage=garage_obj, kind="dpa").exists() else "No",
            ),
        ],
    }


@reads
def garage_team(garage_obj: Garage) -> dict:
    return {
        "members": list(GarageMember.objects.filter(garage=garage_obj)),
        "invites": list(GarageInvite.objects.filter(garage=garage_obj)[:20]),
    }


@reads
def garage_bookings(garage_obj: Garage, now: datetime | None = None, days: int = 30) -> dict:
    """Counts and a daily trend. Rows carry no personal data (reference, time, service, status)."""
    now = now or timezone.now()
    since = london_day_start(now) - timedelta(days=days - 1)
    bookings = Booking.objects.filter(garage=garage_obj, deleted_at__isnull=True)
    recent = bookings.filter(created_at__gte=since)
    per_day: dict[date, int] = {}
    for created in recent.values_list("created_at", flat=True):
        day = created.astimezone(LONDON).date()
        per_day[day] = per_day.get(day, 0) + 1
    start = since.date()
    trend = [per_day.get(start + timedelta(days=offset), 0) for offset in range(days)]
    by_status = list(recent.values("status").annotate(total=Count("id")).order_by("-total"))
    by_source = list(recent.values("source").annotate(total=Count("id")).order_by("-total"))
    rows = list(bookings.select_related("service").order_by("-starts_at")[:25])
    return {
        "trend": trend,
        "total": sum(trend),
        "days": days,
        "by_status": by_status,
        "by_source": by_source,
        "rows": rows,
    }


@reads
def garage_booking_people(garage_obj: Garage, limit: int = 25) -> list[dict]:
    """Support only, audited by the caller: the customer's name and masked contact per booking."""
    rows = (
        Booking.objects.filter(garage=garage_obj, deleted_at__isnull=True)
        .select_related("customer", "vehicle", "service")
        .order_by("-starts_at")[:limit]
    )
    return [
        {
            "reference": row.reference,
            "starts_at": row.starts_at,
            "service": row.service.name if row.service_id else "",
            "status": row.status,
            "customer": row.customer.name if row.customer.anonymised_at is None else "Anonymised",
            "phone": row.customer.phone_masked or "—",
            "email": row.customer.email_masked or "—",
            "vehicle": " ".join(
                part
                for part in (row.vehicle.registration_masked, row.vehicle.make, row.vehicle.model)
                if part
            ),
        }
        for row in rows
    ]


@reads
def garage_domains(garage_obj: Garage) -> list[GarageDomain]:
    return list(
        GarageDomain.objects.filter(garage=garage_obj, deleted_at__isnull=True).order_by("kind", "hostname")
    )


@reads
def garage_messaging(garage_obj: Garage, now: datetime | None = None) -> dict:
    now = now or timezone.now()
    return messaging_summary.__wrapped__(now=now, garage_id=garage_obj.pk)


@reads
def garage_agreements(garage_obj: Garage) -> list[GarageAgreement]:
    return list(GarageAgreement.objects.filter(garage=garage_obj))


@reads
def garage_platform_audit(garage_obj: Garage, limit: int = 50) -> list[PlatformAuditEntry]:
    return list(PlatformAuditEntry.objects.filter(target_garage=garage_obj)[:limit])


@reads
def garage_plan_history(garage_obj: Garage) -> list[PlatformAuditEntry]:
    return list(
        PlatformAuditEntry.objects.filter(
            target_garage=garage_obj,
            action__in=("platform.garage_plan_changed", "platform.garage_status_changed"),
        )[:20]
    )


@reads
def garage_impersonations(garage_obj: Garage) -> list[PlatformImpersonation]:
    return list(PlatformImpersonation.objects.filter(garage=garage_obj)[:10])


# --- Jobs --------------------------------------------------------------------------------------


@reads
def job_health(now: datetime | None = None) -> dict:
    now = now or timezone.now()
    by_kind = list(
        Job.objects.values("kind", "status").annotate(total=Count("id")).order_by("kind", "status")
    )
    kinds: dict[str, dict[str, int]] = {}
    for row in by_kind:
        kinds.setdefault(row["kind"], {"queued": 0, "running": 0, "done": 0, "failed": 0})[row["status"]] = (
            row["total"]
        )
    oldest = (
        Job.objects.filter(status="queued", run_at__lte=now)
        .order_by("run_at")
        .values_list("run_at", flat=True)
        .first()
    )
    failures = [
        {"job": job, "error": redact(job.last_error)}
        for job in Job.objects.filter(status="failed")
        .select_related("garage")
        .order_by("-finished_at")[:RECENT_FAILURES]
    ]
    expired = list(Job.objects.filter(status="running", locked_until__lt=now).order_by("locked_until"))
    reminder_problems = list(
        ReminderSend.objects.filter(status__in=("skipped", "failed"), updated_at__gte=now - timedelta(days=7))
        .values("garage_id", "garage__name")
        .annotate(
            skipped=Count("id", filter=Q(status="skipped")),
            failed=Count("id", filter=Q(status="failed")),
        )
        .order_by("-failed", "-skipped", "garage__name")
    )
    totals = {
        status: sum(row[status] for row in kinds.values())
        for status in ("queued", "running", "done", "failed")
    }
    return {
        "kinds": sorted(kinds.items()),
        "totals": totals,
        "oldest_queued_at": oldest,
        "queue_delay": (now - oldest) if oldest else None,
        "failures": failures,
        "expired": expired,
        "reminder_problems": reminder_problems,
    }


@reads
def job(pk) -> Job | None:
    return Job.objects.filter(pk=pk).first()


# --- Messaging ---------------------------------------------------------------------------------


@reads
def messaging_summary(now: datetime | None = None, garage_id=None, days: int = 30) -> dict:
    now = now or timezone.now()
    since = now - timedelta(days=days)
    messages = Message.objects.filter(direction="outbound", created_at__gte=since)
    sends = ReminderSend.objects.filter(updated_at__gte=since)
    customers = Customer.objects.all()
    # Garage calls only: Pitline's own line is not a garage's messaging.
    calls = Call.objects.filter(created_at__gte=since, is_platform=False)
    if garage_id:
        messages, sends = messages.filter(garage_id=garage_id), sends.filter(garage_id=garage_id)
        customers, calls = customers.filter(garage_id=garage_id), calls.filter(garage_id=garage_id)
    channels = []
    for row in (
        messages.values("channel")
        .annotate(
            total=Count("id"),
            delivered=Count("id", filter=Q(status="delivered")),
            sent=Count("id", filter=Q(status="sent")),
            failed=Count("id", filter=Q(status="failed")),
            pending=Count("id", filter=Q(status__in=("queued", "sending"))),
        )
        .order_by("channel")
    ):
        row["delivery_rate"] = _pct(row["delivered"], row["total"])
        row["failure_rate"] = _pct(row["failed"], row["total"])
        channels.append(row)
    errors = list(
        messages.filter(status="failed")
        .values("provider", "channel", "error_code")
        .annotate(total=Count("id"))
        .order_by("-total")[:10]
    )
    reminder_status = list(sends.values("status").annotate(total=Count("id")).order_by("-total"))
    # Quiet hours: every reminder actually sent must fall within 09:00-19:00 Mon-Sat locally.
    sent = sends.filter(sent_at__isnull=False, sent_at__gte=since).values_list("sent_at", "garage__timezone")
    checked = outside = 0
    for sent_at, zone in sent.iterator():
        checked += 1
        if not within_messaging_hours(sent_at, zone):
            outside += 1
    opted_out_recent = customers.filter(opted_out_at__gte=since).count()
    return {
        "days": days,
        "channels": channels,
        "errors": errors,
        "reminder_status": reminder_status,
        "quiet_hours": {
            "checked": checked,
            "outside": outside,
            "compliance": _pct(checked - outside, checked) if checked else "No sends",
        },
        "opt_outs": {
            "recent": opted_out_recent,
            "total": customers.filter(opted_out_at__isnull=False).count(),
            "consented": customers.filter(reminder_consent=True, opted_out_at__isnull=True).count(),
        },
        "calls": calls.aggregate(
            total=Count("id"),
            missed_calls=Count("id", filter=Q(missed=True)),
            texted_back=Count("id", filter=Q(missed=True, text_back_message_id__isnull=False)),
        ),
        "inbound": Message.objects.filter(direction="inbound", created_at__gte=since)
        .filter(**({"garage_id": garage_id} if garage_id else {}))
        .count(),
    }


# --- Calls -------------------------------------------------------------------------------------

# A text-back's messages row status, as the Calls list shows it.
TEXT_BACK_LABELS = {
    "queued": "Sending",
    "sending": "Sending",
    "sent": "Sent",
    "delivered": "Delivered",
    "failed": "Failed",
}
NEW_VOICEMAIL_HOURS = 24
# The ``garage`` filter value for Pitline's own line (A420).
PLATFORM_LINE = "platform"


def clean_call_filters(params) -> dict[str, str]:
    """``garage`` (a UUID, or ``platform`` for Pitline's own line), ``missed`` and ``voicemail`` ("1" or
    empty). Anything else is dropped."""
    garage_id = (params.get("garage") or "").strip()
    try:
        garage_id = (
            garage_id if garage_id == PLATFORM_LINE else str(uuid.UUID(garage_id)) if garage_id else ""
        )
    except ValueError:
        garage_id = ""
    return {
        "garage": garage_id,
        "missed": "1" if params.get("missed") == "1" else "",
        "voicemail": "1" if params.get("voicemail") == "1" else "",
    }


@reads
def calls(filters: dict):
    """Calls across every garage and Pitline's own line (or one of them, with ``filters["garage"]``),
    with the text-back's status.

    Callers arrive masked by the database; the recording link is not on these rows (``voicemail``).
    """
    text_back = Message.objects.filter(pk=OuterRef("text_back_message_id")).values("status")[:1]
    queryset = Call.objects.select_related("garage").annotate(text_back_status=Subquery(text_back))
    if filters.get("garage") == PLATFORM_LINE:
        queryset = queryset.filter(is_platform=True)
    elif filters.get("garage"):
        queryset = queryset.filter(garage_id=filters["garage"], is_platform=False)
    if filters.get("missed"):
        queryset = queryset.filter(missed=True)
    if filters.get("voicemail"):
        queryset = queryset.filter(has_voicemail=True)
    return queryset


@reads
def call_garages() -> list[tuple[str, str]]:
    """Pitline's own line (once it has had a call), then garages that have had a call, for the filter."""
    with_calls = Garage.objects.filter(Exists(Call.objects.filter(garage_id=OuterRef("pk"))))
    choices = [(str(pk), name) for pk, name in with_calls.order_by("name").values_list("pk", "name")]
    if Call.objects.filter(is_platform=True).exists():
        choices.insert(0, (PLATFORM_LINE, PLATFORM_LINE_LABEL))
    return choices


@reads
def voicemail(pk) -> tuple[Call, str] | None:
    """A call with a voicemail and its Twilio recording link, for the playback proxy only."""
    call = Call.objects.filter(pk=pk, has_voicemail=True).select_related("garage").first()
    link = CallVoicemail.objects.filter(pk=pk).values_list("voicemail_url", flat=True).first()
    if call is None or not link:
        return None
    return call, link


@reads
def new_voicemails(
    now: datetime | None = None, hours: int = NEW_VOICEMAIL_HOURS, limit: int = 50
) -> list[Call]:
    """Voicemails left in the last ``hours`` hours on any garage's line or Pitline's own, newest first
    (the bell's "new voicemail")."""
    now = now or timezone.now()
    return list(
        Call.objects.filter(has_voicemail=True, created_at__gte=now - timedelta(hours=hours))
        .select_related("garage")
        .order_by("-created_at")[:limit]
    )


# --- Domains -----------------------------------------------------------------------------------


@reads
def domains(status: str = "", kind: str = ""):
    queryset = GarageDomain.objects.filter(deleted_at__isnull=True).select_related("garage")
    if status in {key for key, _ in GarageDomain._meta.get_field("status").choices}:
        queryset = queryset.filter(status=status)
    if kind in ("custom", "subdomain"):
        queryset = queryset.filter(kind=kind)
    return queryset


@reads
def domain_counts() -> dict[str, int]:
    rows = (
        GarageDomain.objects.filter(deleted_at__isnull=True, kind="custom")
        .values("status")
        .annotate(total=Count("id"))
    )
    counts = {"pending_dns": 0, "verifying": 0, "active": 0, "failed": 0}
    counts.update({row["status"]: row["total"] for row in rows})
    return counts


@reads
def domain(pk) -> GarageDomain | None:
    return GarageDomain.objects.filter(pk=pk, deleted_at__isnull=True).select_related("garage").first()


# --- Sign-ups and onboarding -------------------------------------------------------------------


@reads
def signup_funnel(now: datetime | None = None, days: int = 30) -> dict:
    now = now or timezone.now()
    since = now - timedelta(days=days) if days else None
    cohort = Garage.objects.all()
    if since:
        cohort = cohort.filter(created_at__gte=since)
    signed_up = cohort.count()
    dpa = cohort.filter(Exists(GarageAgreement.objects.filter(garage_id=OuterRef("pk"), kind="dpa"))).count()
    completed = cohort.filter(
        Q(onboarding_completed_at__isnull=False) | Q(status__in=("active", "suspended"))
    ).count()
    custom_domain = cohort.filter(
        Exists(GarageDomain.objects.filter(garage_id=OuterRef("pk"), kind="custom", deleted_at__isnull=True))
    ).count()
    first_booking = cohort.filter(
        Exists(Booking.objects.filter(garage_id=OuterRef("pk"), deleted_at__isnull=True))
    ).count()
    steps = [
        ("Signed up", signed_up),
        ("Accepted the DPA", dpa),
        ("Finished onboarding", completed),
        ("Added a custom domain", custom_domain),
        ("Took a first booking", first_booking),
    ]
    funnel = [
        {
            "label": label,
            "count": count,
            "rate": _pct(count, signed_up),
            "width": round(100 * count / signed_up) if signed_up else 0,
        }
        for label, count in steps
    ]
    weekly: dict[date, int] = {}
    for created in Garage.objects.filter(created_at__gte=now - timedelta(weeks=12)).values_list(
        "created_at", flat=True
    ):
        local = created.astimezone(LONDON).date()
        monday = local - timedelta(days=local.weekday())
        weekly[monday] = weekly.get(monday, 0) + 1
    this_monday = now.astimezone(LONDON).date() - timedelta(days=now.astimezone(LONDON).weekday())
    weeks = [this_monday - timedelta(weeks=offset) for offset in range(11, -1, -1)]
    stuck = list(
        Garage.objects.filter(status="onboarding", created_at__lt=_stuck_cutoff(now)).order_by("created_at")
    )
    recent = list(Garage.objects.order_by("-created_at")[:10])
    return {
        "days": days,
        "funnel": funnel,
        "weekly": [(week, weekly.get(week, 0)) for week in weeks],
        "weekly_values": [weekly.get(week, 0) for week in weeks],
        "stuck": stuck,
        "recent": recent,
        "stuck_hours": settings.ONBOARDING_STUCK_HOURS,
    }


# --- Platform audit ----------------------------------------------------------------------------

PLATFORM_FILTER_KEYS = ("action", "garage", "date_from", "date_to")


@reads
def platform_actions() -> list[str]:
    return list(PlatformAuditEntry.objects.order_by("action").values_list("action", flat=True).distinct())


@reads
def platform_audit(filters: dict):
    queryset = PlatformAuditEntry.objects.select_related("target_garage")
    if filters.get("action"):
        queryset = queryset.filter(action=filters["action"])
    if filters.get("garage"):
        queryset = queryset.filter(target_garage__name__icontains=filters["garage"])
    if filters.get("date_from"):
        queryset = queryset.filter(
            created_at__gte=datetime.combine(filters["date_from"], time.min, tzinfo=LONDON)
        )
    if filters.get("date_to"):
        queryset = queryset.filter(
            created_at__lt=datetime.combine(filters["date_to"] + timedelta(days=1), time.min, tzinfo=LONDON)
        )
    return queryset


@reads
def recent_platform_activity(limit: int = 50) -> list[PlatformAuditEntry]:
    return list(PlatformAuditEntry.objects.select_related("target_garage")[:limit])


# --- Product status (ADR-044) ------------------------------------------------------------------


@reads
def status_snapshot(now: datetime | None = None) -> dict:
    now = now or timezone.now()
    counts = garage_counts.__wrapped__()
    return {
        "tenants": counts,
        "subscriptions": subscription_counts.__wrapped__(),
        "attention": attention_items.__wrapped__(now=now, limit=50),
    }


# --- Enquiries (contact page) ------------------------------------------------------------------

ENQUIRY_STATUS_LABELS = dict(ENQUIRY_STATUSES)
ENQUIRY_TOPIC_LABELS = dict(ENQUIRY_TOPICS)
ENQUIRY_ACTIONS = ("platform.enquiry_status_changed", "platform.enquiry_notes_changed")


def clean_enquiry_filters(params) -> dict[str, str]:
    filters = {key: (params.get(key) or "").strip()[:40] for key in ("status", "topic")}
    if filters["status"] not in ENQUIRY_STATUS_LABELS:
        filters["status"] = ""
    if filters["topic"] not in ENQUIRY_TOPIC_LABELS:
        filters["topic"] = ""
    return filters


@reads
def enquiries(filters: dict):
    """Newest first. The list shows who, about what and where it stands; contact details are on the detail page."""
    queryset = PlatformEnquiry.objects.only(
        "id", "name", "garage_name", "topic", "status", "received_at", "handled_by_name", "updated_at"
    )
    if filters.get("status"):
        queryset = queryset.filter(status=filters["status"])
    if filters.get("topic"):
        queryset = queryset.filter(topic=filters["topic"])
    return queryset


@reads
def enquiry_counts() -> dict[str, int]:
    rows = dict(
        PlatformEnquiry.objects.values_list("status")
        .annotate(total=Count("id"))
        .values_list("status", "total")
    )
    return {key: rows.get(key, 0) for key in ENQUIRY_STATUS_LABELS}


@reads
def enquiry(pk) -> PlatformEnquiry | None:
    return PlatformEnquiry.objects.filter(pk=pk).first()


@reads
def enquiry_history(pk) -> list[PlatformAuditEntry]:
    """Status and notes changes from Pitline's platform log (notes by length only, never their text)."""
    return list(
        PlatformAuditEntry.objects.filter(
            entity_type="platform_enquiry", entity_id=str(pk), action__in=ENQUIRY_ACTIONS
        ).order_by("-created_at", "-id")[:50]
    )


@reads
def find_enquiries(query: str, limit: int = 6) -> list[PlatformEnquiry]:
    """Command palette: by sender or garage name (never by email, so addresses stay out of search URLs)."""
    return list(
        PlatformEnquiry.objects.filter(Q(name__icontains=query) | Q(garage_name__icontains=query)).only(
            "id", "name", "garage_name", "topic", "status", "received_at"
        )[:limit]
    )
