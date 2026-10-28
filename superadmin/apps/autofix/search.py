"""Command palette and live search: garages by name or slug, and custom domains by hostname."""

from django.urls import reverse

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
