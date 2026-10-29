"""Command palette and live search: garages by name or slug, custom domains by hostname and, for
SuperAdmin and Support, contact page enquiries by sender or garage name."""

from django.urls import reverse
from django.utils import timezone

from apps.accounts.roles import can_handle_enquiries
from apps.core.palette import PaletteResult

from . import selectors
from .db import AutofixUnavailable, reads
from .models import Garage, GarageDomain

LIMIT = 6


@reads
def _find(query: str) -> tuple[list[Garage], list[GarageDomain]]:
    garages = list(selectors._garage_filters(Garage.objects.all(), {"q": query}).order_by("name")[:LIMIT])
    domains = list(
        GarageDomain.objects.filter(hostname__icontains=query.lower(), deleted_at__isnull=True)
        .select_related("garage")
        .order_by("hostname")[:LIMIT]
    )
    return garages, domains


def palette_results(user, query: str) -> list[PaletteResult]:
    if len(query) < 2:
        return []
    try:
        garages, domains = _find(query)
    except AutofixUnavailable:
        return []
    results = [
        PaletteResult(
            "Garages",
            garage.name,
            reverse("autofix:garage", args=[garage.pk]),
            f"{garage.plan_label} · {selectors.STATUS_LABELS.get(garage.status, garage.status)}",
            "wrench",
        )
        for garage in garages
    ]
    results += [
        PaletteResult(
            "Domains",
            domain.hostname,
            f"{reverse('autofix:garage', args=[domain.garage_id])}?tab=domains",
            domain.garage.name,
            "globe",
        )
        for domain in domains
    ]
    return results


def enquiry_results(user, query: str) -> list[PaletteResult]:
    """Enquiries for SuperAdmin and Support only; the hint carries topic, status and date, no contact details."""
    if len(query) < 2 or not can_handle_enquiries(user):
        return []
    try:
        found = selectors.find_enquiries(query, LIMIT)
    except AutofixUnavailable:
        return []
    return [
        PaletteResult(
            "Enquiries",
            enquiry.name,
            reverse("autofix:enquiry", args=[enquiry.pk]),
            f"{enquiry.get_topic_display()} · {enquiry.get_status_display()} · {timezone.localtime(enquiry.received_at):%d %b}",
            "inbox",
        )
        for enquiry in found
    ]
