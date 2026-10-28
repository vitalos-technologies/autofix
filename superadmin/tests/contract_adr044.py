"""The Product Pipeline's own validator for the ADR-044 status contract, vendored from
vitalos-platform ``superadmin/apps/products/status.py`` (``parse_status`` and its helpers, unchanged
apart from the imports). The status endpoint's output must pass it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from django.utils import timezone
from django.utils.dateparse import parse_datetime


@dataclass(frozen=True)
class Product:
    key: str
    status_url: str
    superadmin_url: str

    @property
    def trusted_hosts(self) -> frozenset[str]:
        hosts = {urlsplit(url).hostname for url in (self.status_url, self.superadmin_url)}
        return frozenset(host for host in hosts if host)


OK = "ok"
UNAVAILABLE = "unavailable"
NOT_CONFIGURED = "not_configured"

STATUSES = ("operational", "degraded", "down")
SEVERITIES = ("critical", "warning", "info")
TENANT_KEYS = ("total", "active", "trial", "suspended")
SUBSCRIPTION_KEYS = ("active", "trialing", "pastDue")
ENVIRONMENT_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
ENVIRONMENT_LABELS = {
    "production": "Production",
    "staging": "Staging",
    "preview": "Preview",
    "development": "Development",
    "test": "Test",
}
MAX_COUNT = 10**9
MAX_ALERTS = 100
MAX_TITLE = 200
MAX_URL = 500
CLOCK_SKEW = timedelta(minutes=5)


class InvalidStatus(ValueError):
    """The payload does not match the contract. The message names the field, never its value."""


@dataclass(frozen=True)
class Alert:
    severity: str
    title: str
    since: datetime
    url: str | None


@dataclass(frozen=True)
class Snapshot:
    product: str
    environment: str
    status: str
    checked_at: datetime
    tenants: dict[str, int]
    subscriptions: dict[str, int]
    alerts: tuple[Alert, ...]
    superadmin_url: str
    # When this app received the answer (the "last good check" shown on failures).
    received_at: datetime

    @property
    def environment_label(self) -> str:
        return ENVIRONMENT_LABELS.get(self.environment, self.environment.replace("-", " ").capitalize())

    @property
    def critical_alerts(self) -> tuple[Alert, ...]:
        return tuple(alert for alert in self.alerts if alert.severity == "critical")


@dataclass(frozen=True)
class StatusResult:
    state: str
    snapshot: Snapshot | None = None
    last_good: Snapshot | None = None
    # Short machine code for a failure ("timeout", "http_401", "invalid:tenants.total"); safe to show.
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.state == OK


def _cache_key(product: Product) -> str:
    return f"products:status:{product.key}"


def _last_good_key(product: Product) -> str:
    return f"products:last-good:{product.key}"


def _count(value, name: str) -> int:
    # bool is an int subclass in Python; JSON true/false must not pass as 1/0.
    if type(value) is not int or value < 0 or value > MAX_COUNT:
        raise InvalidStatus(name)
    return value


def _counts(payload: dict, name: str, keys: tuple[str, ...]) -> dict[str, int]:
    block = payload.get(name)
    if not isinstance(block, dict):
        raise InvalidStatus(name)
    return {key: _count(block.get(key), f"{name}.{key}") for key in keys}


def _datetime(value, name: str) -> datetime:
    parsed = parse_datetime(value) if isinstance(value, str) and len(value) <= 40 else None
    if parsed is None or timezone.is_naive(parsed):
        raise InvalidStatus(name)
    if parsed > timezone.now() + CLOCK_SKEW:
        raise InvalidStatus(name)
    return parsed


def _https_url(value, name: str) -> str:
    if not isinstance(value, str) or len(value) > MAX_URL:
        raise InvalidStatus(name)
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname:
        raise InvalidStatus(name)
    return value


def _text(value, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise InvalidStatus(name)
    return value.strip()


def _alert(item, index: int, product: Product) -> Alert:
    name = f"alerts[{index}]"
    if not isinstance(item, dict):
        raise InvalidStatus(name)
    severity = item.get("severity")
    if severity not in SEVERITIES:
        raise InvalidStatus(f"{name}.severity")
    if "url" not in item:
        raise InvalidStatus(f"{name}.url")
    url = item["url"]
    if url is not None:
        url = _https_url(url, f"{name}.url")
        # Links go only to the product's own hosts, never somewhere a payload chooses.
        if urlsplit(url).hostname not in product.trusted_hosts:
            raise InvalidStatus(f"{name}.url")
    return Alert(
        severity=severity,
        title=_text(item.get("title"), f"{name}.title", MAX_TITLE),
        since=_datetime(item.get("since"), f"{name}.since"),
        url=url,
    )


def parse_status(payload, product: Product, received_at: datetime | None = None) -> Snapshot:
    """Validate ``payload`` against the contract and return a ``Snapshot``. Unknown keys are ignored."""
    if not isinstance(payload, dict):
        raise InvalidStatus("body")
    if payload.get("product") != product.key:
        raise InvalidStatus("product")
    environment = payload.get("environment")
    if not isinstance(environment, str) or not ENVIRONMENT_PATTERN.match(environment):
        raise InvalidStatus("environment")
    status = payload.get("status")
    if status not in STATUSES:
        raise InvalidStatus("status")
    tenants = _counts(payload, "tenants", TENANT_KEYS)
    for key in ("active", "trial", "suspended"):
        if tenants[key] > tenants["total"]:
            raise InvalidStatus(f"tenants.{key}")
    subscriptions = _counts(payload, "subscriptions", SUBSCRIPTION_KEYS)
    alerts = payload.get("alerts")
    if not isinstance(alerts, list) or len(alerts) > MAX_ALERTS:
        raise InvalidStatus("alerts")
    return Snapshot(
        product=product.key,
        environment=environment,
        status=status,
        checked_at=_datetime(payload.get("checkedAt"), "checkedAt"),
        tenants=tenants,
        subscriptions=subscriptions,
        alerts=tuple(_alert(item, index, product) for index, item in enumerate(alerts)),
        superadmin_url=_https_url(payload.get("superadminUrl"), "superadminUrl"),
        received_at=received_at or timezone.now(),
    )
