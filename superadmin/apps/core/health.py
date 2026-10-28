"""System health: the checks behind the page footer and the System health page.

Each check is cheap (a handful of indexed queries) and never raises: a failing dependency becomes a
"fail" result rather than a broken page. Status levels, worst first: fail, warn, ok, info. "info" is
neutral (a fact, not a problem) and never lowers the overall status.
"""

import logging
import time
from dataclasses import dataclass, field
from datetime import timedelta

from django.conf import settings
from django.db import connection
from django.utils import dateformat, timezone

logger = logging.getLogger(__name__)

RANK = {"fail": 0, "warn": 1, "ok": 2, "info": 3}
STALE_QUEUE = timedelta(minutes=10)


@dataclass
class Check:
    key: str
    label: str
    status: str
    summary: str
    details: list[tuple[str, str]] = field(default_factory=list)


def _database() -> Check:
    started = time.monotonic()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
    except Exception:  # noqa: BLE001 - any database error means unhealthy
        logger.exception("Health check: database unavailable")
        return Check("database", "Database", "fail", "Not reachable")
    elapsed = round((time.monotonic() - started) * 1000)
    return Check(
        "database",
        "Super admin database",
        "warn" if elapsed > 500 else "ok",
        f"Responding ({elapsed} ms)",
        [("Engine", connection.vendor.capitalize()), ("Query time", f"{elapsed} ms")],
    )


def _autofix(now) -> Check:
    """Autofix's Supabase Postgres as autofix_superadmin: reachable, and read-only by default."""
    from django.db import connections

    from apps.autofix import selectors
    from apps.autofix.db import ALIAS, AutofixUnavailable, is_configured

    if not is_configured():
        return Check("autofix", "Autofix data", "fail", "Not connected: set AUTOFIX_DATABASE_URL")
    started = time.monotonic()
    try:
        counts = selectors.garage_counts()
    except AutofixUnavailable:
        return Check("autofix", "Autofix data", "fail", "Not reachable")
    elapsed = round((time.monotonic() - started) * 1000)
    connection = connections[ALIAS]
    details = [
        ("Garages", str(counts["total"])),
        ("Query time", f"{elapsed} ms"),
        ("Engine", connection.vendor.capitalize()),
    ]
    if connection.vendor == "postgresql" and getattr(settings, "AUTOFIX_EXPECT_READ_ONLY", True):
        try:
            with connection.cursor() as cursor:
                cursor.execute("SHOW transaction_read_only")
                read_only = cursor.fetchone()[0] == "on"
        except Exception:  # noqa: BLE001
            read_only = False
        details.append(("Sessions", "Read-only by default" if read_only else "NOT read-only"))
        if not read_only:
            return Check(
                "autofix", "Autofix data", "warn", "Connected, but sessions are not read-only", details
            )
    return Check(
        "autofix", "Autofix data", "warn" if elapsed > 800 else "ok", f"Connected ({elapsed} ms)", details
    )


def _jobs(now) -> Check:
    from apps.autofix import selectors
    from apps.autofix.db import AutofixUnavailable, is_configured

    if not is_configured():
        return Check("jobs", "Autofix job queue", "info", "Not connected")
    try:
        health = selectors.job_health(now=now)
    except AutofixUnavailable:
        return Check("jobs", "Autofix job queue", "fail", "Could not be read")
    failed, stuck = health["totals"]["failed"], len(health["expired"])
    delay = health["queue_delay"]
    details = [
        ("Failed, waiting for retry", str(failed)),
        ("Stuck (lock expired)", str(stuck)),
        ("Oldest due job waiting", _when(health["oldest_queued_at"]) or "None"),
    ]
    if stuck or (delay and delay > STALE_QUEUE):
        return Check("jobs", "Autofix job queue", "warn", "Jobs are waiting longer than they should", details)
    if failed:
        return Check(
            "jobs", "Autofix job queue", "warn", f"{failed} failed job{'s' if failed != 1 else ''}", details
        )
    return Check("jobs", "Autofix job queue", "ok", "Up to date", details)


def _status_endpoint() -> Check:
    configured = bool(settings.AUTOFIX_STATUS_TOKEN)
    return Check(
        "status",
        "Product Pipeline status",
        "info",
        "Token set: /api/platform/v1/status answers"
        if configured
        else "No token: the status endpoint answers 503",
        [("Superadmin URL", settings.AUTOFIX_SUPERADMIN_URL)],
    )


def _messaging(now) -> Check:
    from apps.autofix import selectors
    from apps.autofix.db import AutofixUnavailable, is_configured

    if not is_configured():
        return Check("messaging", "Texts and emails", "info", "Not connected")
    try:
        items = [
            item for item in selectors.attention_items(now=now, limit=50) if item.kind == "messaging_failed"
        ]
    except AutofixUnavailable:
        return Check("messaging", "Texts and emails", "fail", "Could not be read")
    if items:
        return Check(
            "messaging", "Texts and emails", "warn", items[0].title, [(i.title, i.detail) for i in items]
        )
    return Check("messaging", "Texts and emails", "ok", "No failures in the last 24 hours")


def _when(moment) -> str:
    if moment is None:
        return ""
    return dateformat.format(timezone.localtime(moment), "j M Y, H:i")


def checks() -> list[Check]:
    now = timezone.now()
    database = _database()
    if database.status == "fail":
        return [database]
    return [database, _autofix(now), _jobs(now), _messaging(now), _status_endpoint()]


def overall(results: list[Check]) -> dict:
    """The worst status and a one-line summary for the footer."""
    problems = [check for check in results if check.status in ("fail", "warn")]
    worst = min((check.status for check in results), key=RANK.__getitem__, default="ok")
    worst = "ok" if worst == "info" else worst
    if not problems:
        summary = "All systems normal"
    elif len(problems) == 1:
        summary = f"{problems[0].label}: {problems[0].summary}"
    else:
        summary = f"{len(problems)} issues need a look"
    return {"status": worst, "summary": summary, "problems": problems}
