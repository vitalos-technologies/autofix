"""Read rules for the audit trail: filters and human-readable sentences."""

from datetime import date, datetime, time, timedelta

from django.utils import timezone
from django.utils.dateparse import parse_date

from .models import AuditEvent
from .services import ACTIONS

FILTER_KEYS = ("actor", "action", "entity_type", "date_from", "date_to")
MAX_TEXT = 100
EXPORT_LIMIT = 10_000


def clean_filters(params) -> dict[str, str]:
    """Validated filter values from a query dict; invalid values are dropped, never raised."""
    filters = {key: (params.get(key) or "").strip()[:MAX_TEXT] for key in FILTER_KEYS}
    if filters["action"] not in ACTIONS:
        filters["action"] = ""
    for key in ("date_from", "date_to"):
        if filters[key] and parse_date(filters[key]) is None:
            filters[key] = ""
    return filters


def _day_start(day: date) -> datetime:
    return timezone.make_aware(datetime.combine(day, time.min))


def filtered(filters: dict[str, str]):
    queryset = AuditEvent.objects.all()
    if filters["actor"]:
        queryset = queryset.filter(actor_email__icontains=filters["actor"])
    if filters["action"]:
        queryset = queryset.filter(action=filters["action"])
    if filters["entity_type"]:
        queryset = queryset.filter(entity_type=filters["entity_type"])
    if filters["date_from"]:
        queryset = queryset.filter(created_at__gte=_day_start(parse_date(filters["date_from"])))
    if filters["date_to"]:
        queryset = queryset.filter(
            created_at__lt=_day_start(parse_date(filters["date_to"]) + timedelta(days=1))
        )
    return queryset


def entity_types() -> list[str]:
    return list(
        AuditEvent.objects.exclude(entity_type="")
        .order_by("entity_type")
        .values_list("entity_type", flat=True)
        .distinct()
    )


def action_label(action: str) -> str:
    return ACTIONS.get(action, action)


def sentence(event: AuditEvent) -> str:
    """ "admin@example.org — Changed a role — support@example.org: Finance → Support"."""
    parts = [event.actor_email or "System", action_label(event.action)]
    if event.summary:
        parts.append(event.summary)
    return " — ".join(parts)
