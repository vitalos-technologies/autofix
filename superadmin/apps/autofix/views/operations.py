"""Jobs, messaging, domains, sign-ups, activity, team, the Autofix platform log and product status."""

import hmac
import logging
from itertools import chain

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.http import HttpResponseRedirect, JsonResponse
from django.shortcuts import render
from django.template.loader import render_to_string
from django.urls import reverse
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.utils.html import format_html
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_http_methods

from apps.accounts import stepup
from apps.accounts.roles import (
    ROLE_LABELS,
    SUPERADMIN,
    SUPPORT,
    can_change_autofix,
    is_superadmin,
    primary_role,
    role_required,
)
from apps.audit.models import AuditEvent
from apps.audit.selectors import action_label
from apps.audit.services import record
from apps.core.csv_io import csv_response
from apps.core.templatetags.tables import Column, build_table, density

from .. import selectors, services, status
from ..db import AutofixUnavailable
from ..forms import ReasonForm
from .common import parse_uuid, render_unavailable

logger = logging.getLogger(__name__)


def _form_error(form) -> str:
    """One line for an inline action form: the reason or the step-up code, whichever failed."""
    if "reason" in form.errors:
        return "Give a reason of 5 to 500 characters."
    return " ".join(message for messages_ in form.errors.values() for message in messages_)


# --- Jobs --------------------------------------------------------------------------------------


@role_required(SUPPORT)
@require_GET
@never_cache
def jobs(request):
    try:
        health = selectors.job_health()
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Jobs")
    return render(
        request,
        "autofix/jobs.html",
        {"health": health, "can_retry": can_change_autofix(request.user), "reason_form": ReasonForm()},
    )


@role_required(SUPERADMIN)
@require_http_methods(["POST"])
def job_retry(request, pk):
    try:
        job = selectors.job(parse_uuid(pk))
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Jobs")
    form = ReasonForm(request.POST, user=request.user)
    if job is None:
        messages.error(request, "That job could not be found.")
    elif not form.is_valid():
        messages.error(request, _form_error(form))
    else:
        try:
            outcome = services.retry_job(request, job, form.cleaned_data["reason"])
        except ValidationError as exc:
            messages.error(request, " ".join(exc.messages))
        else:
            (messages.success if outcome.ok else messages.error)(request, outcome.message)
    return HttpResponseRedirect(reverse("autofix:jobs"))


# --- Messaging ---------------------------------------------------------------------------------


@role_required()
@require_GET
@never_cache
def messaging(request):
    try:
        summary = selectors.messaging_summary()
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Messaging")
    return render(request, "autofix/messaging.html", {"summary": summary})


# --- Domains -----------------------------------------------------------------------------------

DOMAIN_TARGET = "domain-results"
DOMAIN_COLUMNS = [
    Column("hostname", "Domain", sort_field="hostname"),
    Column("garage", "Garage", sort_field="garage__name"),
    Column("kind", "Kind", sort_field="kind", nowrap=True),
    Column("status", "Verification", sort_field="status", nowrap=True),
    Column("checked", "Last checked", sort_field="last_checked_at", nowrap=True),
    Column("action", "Re-check"),
]


def _domain_row(can_check, csrf_input):
    from apps.core.templatetags.ui import badge_class

    def row(domain):
        error = (
            format_html('<span class="muted block text-xs">{}</span>', domain.error) if domain.error else ""
        )
        if domain.checkable and can_check:
            action = format_html(
                '<form method="post" action="{}" class="flex flex-wrap items-center gap-2">{}'
                '<label class="sr-only" for="reason-{}">Reason for re-checking {}</label>'
                '<input id="reason-{}" name="reason" required minlength="5" maxlength="500" placeholder="Reason" '
                'class="input-sm">{}'
                '<button type="submit" class="btn btn-secondary btn-sm">Re-check</button></form>',
                reverse("autofix:domain_recheck", args=[domain.pk]),
                csrf_input,
                domain.pk,
                domain.hostname,
                domain.pk,
                render_to_string(
                    "partials/step_up_inline.html", {"step_up": stepup.enabled(), "id": domain.pk}
                ),
            )
        elif domain.checkable:
            action = "SuperAdmin only"
        elif domain.status == "failed":
            action = "Garage presses Try again"
        else:
            action = "—"
        return [
            format_html('<span class="font-mono text-xs">{}</span>{}', domain.hostname, error),
            format_html(
                '<a class="text-link hover:underline" href="{}">{}</a>',
                reverse("autofix:garage", args=[domain.garage_id]),
                domain.garage.name,
            ),
            "Custom" if domain.kind == "custom" else "Free subdomain",
            format_html(
                '<span class="{}">{}</span>', badge_class(domain.status), domain.get_status_display()
            ),
            timezone.localtime(domain.last_checked_at).strftime("%d %b %H:%M")
            if domain.last_checked_at
            else "Never",
            action,
        ]

    return row


@role_required(SUPPORT)
@require_GET
@never_cache
def domains(request):
    from django.middleware.csrf import get_token

    status_filter = request.GET.get("status", "")
    kind = request.GET.get("kind", "custom")
    csrf_input = format_html(
        '<input type="hidden" name="csrfmiddlewaretoken" value="{}">', get_token(request)
    )
    try:
        table = build_table(
            request,
            selectors.domains(status_filter, kind),
            DOMAIN_COLUMNS,
            _domain_row(can_change_autofix(request.user), csrf_input),
            caption="Garage domains and their verification state",
            target_id=DOMAIN_TARGET,
            url=reverse("autofix:domains"),
            default_sort="hostname",
            default_dir="asc",
            tiebreak=("id",),
            empty_message="No domains match these filters.",
        )
        counts = selectors.domain_counts()
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Domains")
    if getattr(request, "htmx", None) and request.htmx.target == DOMAIN_TARGET:
        return render(request, "partials/data_table.html", {"table": table})
    return render(
        request,
        "autofix/domains.html",
        {
            "table": table,
            "counts": counts,
            "status": status_filter,
            "kind": kind,
            "density": density(request),
        },
    )


@role_required(SUPERADMIN)
@require_http_methods(["POST"])
def domain_recheck(request, pk):
    try:
        domain = selectors.domain(parse_uuid(pk))
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Domains")
    form = ReasonForm(request.POST, user=request.user)
    back = request.POST.get("next", "")
    if not url_has_allowed_host_and_scheme(
        back, allowed_hosts={request.get_host()}, require_https=request.is_secure()
    ):
        back = reverse("autofix:domains")
    if domain is None:
        messages.error(request, "That domain could not be found.")
    elif not form.is_valid():
        messages.error(request, _form_error(form))
    else:
        try:
            outcome = services.request_domain_check(request, domain, form.cleaned_data["reason"])
        except ValidationError as exc:
            messages.error(request, " ".join(exc.messages))
        else:
            (messages.success if outcome.ok else messages.error)(request, outcome.message)
    return HttpResponseRedirect(back)


# --- Sign-ups ----------------------------------------------------------------------------------


@role_required()
@require_GET
@never_cache
def signups(request):
    try:
        days = int(request.GET.get("days", 30))
    except ValueError:
        days = 30
    days = days if days in (7, 30, 90, 0) else 30
    try:
        funnel = selectors.signup_funnel(days=days)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Sign-ups")
    return render(request, "autofix/signups.html", {"funnel": funnel, "days": days})


# --- Activity ----------------------------------------------------------------------------------

ACTIVITY_LIMIT = 100


@role_required()
@require_GET
@never_cache
def activity(request):
    """Both trails, newest first. Sign-in events (with IP addresses) stay on the SuperAdmin Audit page."""
    source = request.GET.get("source", "all")
    source = source if source in ("all", "superadmin", "autofix") else "all"
    local = []
    if source in ("all", "superadmin"):
        local = [
            {
                "when": event.created_at,
                "source": "Super admin",
                "actor": event.actor_email or "System",
                "text": action_label(event.action),
                "summary": event.summary,
            }
            for event in AuditEvent.objects.exclude(action__startswith="auth.")[:ACTIVITY_LIMIT]
        ]
    remote, error = [], ""
    if source in ("all", "autofix"):
        try:
            remote = [
                {
                    "when": entry.created_at,
                    "source": "Autofix",
                    "actor": entry.actor_name,
                    "text": entry.action.replace("platform.", "").replace("_", " ").capitalize(),
                    "summary": entry.target_garage.name
                    if entry.target_garage_id and entry.target_garage
                    else "",
                }
                for entry in selectors.recent_platform_activity(ACTIVITY_LIMIT)
            ]
        except AutofixUnavailable:
            error = "Autofix activity could not be read just now."
    entries = sorted(chain(local, remote), key=lambda item: item["when"], reverse=True)[:ACTIVITY_LIMIT]
    return render(request, "autofix/activity.html", {"entries": entries, "source": source, "error": error})


# --- Team --------------------------------------------------------------------------------------


@role_required()
@require_GET
def team(request):
    from django_otp.plugins.otp_totp.models import TOTPDevice

    users = get_user_model().objects.filter(is_active=True).prefetch_related("groups")
    with_device = set(TOTPDevice.objects.filter(confirmed=True).values_list("user_id", flat=True))
    rows = [
        {
            "user": user,
            "role": ROLE_LABELS.get(primary_role(user), "No role"),
            "mfa": user.pk in with_device,
            "linked": bool(user.autofix_admin_id),
        }
        for user in users
    ]
    admins, error = [], ""
    try:
        admins = selectors.platform_admins()
    except AutofixUnavailable:
        error = "Autofix platform admins could not be read just now."
    linked = {str(user.autofix_admin_id) for user in users if user.autofix_admin_id}
    return render(
        request,
        "autofix/team.html",
        {
            "rows": rows,
            "admins": admins,
            "linked": linked,
            "admins_error": error,
            "is_superadmin": is_superadmin(request.user),
        },
    )


# --- Autofix platform log (Audit → Autofix) -----------------------------------------------------

PLATFORM_COLUMNS = [
    Column("when", "When", sort_field="created_at", mono=True, nowrap=True),
    Column("action", "Action", sort_field="action"),
    Column("garage", "Garage", sort_field="target_garage__name"),
    Column("actor", "By"),
    Column("reason", "Reason"),
]
PLATFORM_TARGET = "platform-audit-results"


def _platform_filters(params) -> dict:
    filters = {
        "action": (params.get("action") or "")[:80],
        "garage": (params.get("garage") or "").strip()[:80],
    }
    for key in ("date_from", "date_to"):
        filters[key] = parse_date(params.get(key) or "") if params.get(key) else None
    return filters


def _platform_row(entry):
    return [
        timezone.localtime(entry.created_at).strftime("%d %b %Y %H:%M:%S"),
        entry.action,
        entry.target_garage.name if entry.target_garage_id and entry.target_garage else "—",
        entry.actor_name,
        entry.reason or "—",
    ]


@role_required(SUPERADMIN)
@require_GET
@never_cache
def platform_audit(request):
    filters = _platform_filters(request.GET)
    try:
        table = build_table(
            request,
            selectors.platform_audit(filters),
            PLATFORM_COLUMNS,
            _platform_row,
            caption="Autofix platform log: every super admin action in Autofix",
            target_id=PLATFORM_TARGET,
            url=reverse("autofix:platform_audit"),
            default_sort="when",
            empty_message="No Autofix platform actions match these filters.",
        )
        actions = selectors.platform_actions()
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Audit")
    if getattr(request, "htmx", None) and request.htmx.target == PLATFORM_TARGET:
        return render(request, "partials/data_table.html", {"table": table})
    return render(
        request,
        "audit/platform.html",
        {"table": table, "filters": filters, "actions": actions, "density": density(request)},
    )


@role_required(SUPERADMIN)
@require_GET
@never_cache
def platform_audit_export(request):
    filters = _platform_filters(request.GET)
    try:
        entries = list(selectors.platform_audit(filters).order_by("-created_at", "-id")[:10_000])
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Audit")
    record(
        "audit.autofix_exported",
        request=request,
        entity_type="autofix.platform_audit_log",
        summary=f"{len(entries)} rows",
    )
    return csv_response(
        "autofix-platform-log",
        ["time", "action", "garage_id", "garage", "entity_type", "entity_id", "by", "reason"],
        (
            [
                e.created_at.isoformat(),
                e.action,
                e.target_garage_id or "",
                e.target_garage.name if e.target_garage_id and e.target_garage else "",
                e.entity_type,
                e.entity_id,
                e.actor_name,
                e.reason or "",
            ]
            for e in entries
        ),
    )


# --- Product status (ADR-044) ------------------------------------------------------------------


def _bearer(request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def _json(data: dict, status_code: int = 200) -> JsonResponse:
    response = JsonResponse(data, status=status_code)
    response["Cache-Control"] = "no-store"
    return response


@require_GET
@never_cache
def product_status(request):
    """GET /api/platform/v1/status for the Vitalos Product Pipeline. Bearer AUTOFIX_STATUS_TOKEN only."""
    expected = settings.AUTOFIX_STATUS_TOKEN
    if not expected:
        return _json({"error": "not_configured"}, 503)
    supplied = _bearer(request)
    if not supplied or not hmac.compare_digest(supplied.encode(), expected.encode()):
        response = _json({"error": "unauthorized"}, 401)
        response["WWW-Authenticate"] = 'Bearer realm="autofix-status"'
        return response
    try:
        body = status.payload()
    except AutofixUnavailable:
        logger.warning("Product status unavailable: Autofix data could not be read")
        return _json({"error": "unavailable"}, 503)
    return _json(body)
