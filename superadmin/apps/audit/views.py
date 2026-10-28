"""Audit trail page and CSV export. SuperAdmin only: the trail holds IP addresses and security events."""

import csv
import io
from urllib.parse import urlencode

from django.http import HttpResponse
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

from apps.accounts.roles import SUPERADMIN, role_required
from apps.core.csv_io import escape_cell
from apps.core.templatetags.tables import Column, build_table, density

from . import selectors
from .services import ACTIONS, record

COLUMNS = [
    Column("when", "When", sort_field="created_at", mono=True, nowrap=True),
    Column("event", "Event", sort_field="action"),
    Column("ip", "IP address", sort_field="ip", mono=True, nowrap=True),
]
TARGET_ID = "audit-results"


def _is_partial(request) -> bool:
    htmx = getattr(request, "htmx", None)
    return bool(htmx) and not htmx.history_restore_request and htmx.target == TARGET_ID


def _row(event):
    when = timezone.localtime(event.created_at).strftime("%d %b %Y %H:%M:%S")
    return [when, selectors.sentence(event), str(event.ip or "—")]


@role_required(SUPERADMIN)
@require_GET
@never_cache
def trail(request):
    filters = selectors.clean_filters(request.GET)
    table = build_table(
        request,
        selectors.filtered(filters),
        COLUMNS,
        _row,
        caption="Audit trail: who did what, when and from where",
        target_id=TARGET_ID,
        url=reverse("audit:trail"),
        default_sort="when",
        default_dir="desc",
        empty_message="No audit events match these filters.",
    )
    if _is_partial(request):
        return render(request, "partials/data_table.html", {"table": table})
    context = {
        "table": table,
        "filters": filters,
        "action_choices": sorted(ACTIONS.items(), key=lambda item: item[1]),
        "entity_types": selectors.entity_types(),
        "sort": request.GET.get("sort", ""),
        "dir": request.GET.get("dir", ""),
        "density": density(request),
        "active_filters": any(filters.values()),
    }
    return render(request, "audit/trail.html", context)


@role_required(SUPERADMIN)
@require_GET
@never_cache
def export_csv(request):
    filters = selectors.clean_filters(request.GET)
    events = list(selectors.filtered(filters).order_by("-created_at", "-id")[: selectors.EXPORT_LIMIT])
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["time", "actor", "action", "event", "entity_type", "entity_id", "summary", "ip"])
    for event in events:
        writer.writerow(
            [
                escape_cell(event.created_at.isoformat()),
                escape_cell(event.actor_email),
                escape_cell(event.action),
                escape_cell(selectors.action_label(event.action)),
                escape_cell(event.entity_type),
                escape_cell(event.entity_id),
                escape_cell(event.summary),
                escape_cell(event.ip or ""),
            ]
        )
    record(
        "audit.exported",
        request=request,
        entity_type="audit.auditevent",
        summary=f"{len(events)} rows",
        rows=len(events),
        capped=len(events) >= selectors.EXPORT_LIMIT,
        filters=urlencode({key: value for key, value in filters.items() if value}),
    )
    response = HttpResponse(buffer.getvalue(), content_type="text/csv; charset=utf-8")
    stamp = timezone.localtime().strftime("%Y%m%d-%H%M")
    response["Content-Disposition"] = f'attachment; filename="autofix-superadmin-audit-{stamp}.csv"'
    return response
