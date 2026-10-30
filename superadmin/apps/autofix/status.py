"""Product status for the Vitalos Product Pipeline (ADR-044 contract), served at /api/platform/v1/status.

Counts and alerts only: no garage names, no people, no free text from Pitline. Validated against the
contract by ``tests/test_status_contract.py`` (a copy of the Product Pipeline's own validator).
"""

import re
from collections import defaultdict
from datetime import UTC, datetime
from urllib.parse import urlsplit

from django.conf import settings
from django.utils import timezone

from . import selectors

ENVIRONMENT_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
MAX_ALERTS = 100
TENANT_KEYS = ("total", "active", "trial", "suspended", "onboarding", "cancelled")
ALERT_TITLES = {
    "job_failed": ("{n} Pitline job{s} failed", "/jobs/"),
    "job_stuck": ("{n} Pitline job{s} stuck with an expired lock", "/jobs/"),
    "domain_failed": ("{n} custom domain{s} failing verification", "/domains/"),
    "onboarding_stuck": ("{n} garage{s} onboarding for over {hours} hours", "/signups/"),
    "messaging_failed": ("Text or email failures in the last 24 hours ({n} provider{s})", "/messaging/"),
}


def environment() -> str:
    value = (settings.APP_ENVIRONMENT or "development").strip().lower().replace("_", "-")
    return value if ENVIRONMENT_PATTERN.match(value) else "development"


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _alerts(items, now: datetime) -> list[dict]:
    base = settings.AUTOFIX_SUPERADMIN_URL.rstrip("/")
    secure = urlsplit(base).scheme == "https"
    grouped: dict[str, list] = defaultdict(list)
    for item in items:
        grouped[item.kind].append(item)
    alerts = []
    for kind, (template, path) in ALERT_TITLES.items():
        found = grouped.get(kind)
        if not found:
            continue
        times = [item.when for item in found if item.when and item.when <= now]
        alerts.append(
            {
                "severity": "critical" if any(item.severity == "critical" for item in found) else "warning",
                "title": template.format(
                    n=len(found), s="" if len(found) == 1 else "s", hours=settings.ONBOARDING_STUCK_HOURS
                ),
                "since": _iso(min(times) if times else now),
                # Links only to this super admin, and only over https (the contract refuses others).
                "url": f"{base}{path}" if secure else None,
            }
        )
    return alerts[:MAX_ALERTS]


def payload(now: datetime | None = None) -> dict:
    """The ADR-044 status document. Raises ``AutofixUnavailable`` when Pitline cannot be read."""
    now = now or timezone.now()
    snapshot = selectors.status_snapshot(now=now)
    tenants = {key: snapshot["tenants"].get(key, 0) for key in TENANT_KEYS}
    alerts = _alerts(snapshot["attention"], now)
    status = "degraded" if any(alert["severity"] == "critical" for alert in alerts) else "operational"
    return {
        "product": "autofix",
        "environment": environment(),
        "status": status,
        "checkedAt": _iso(now),
        "tenants": tenants,
        "subscriptions": snapshot["subscriptions"],
        "alerts": alerts,
        "superadminUrl": settings.AUTOFIX_SUPERADMIN_URL,
    }
