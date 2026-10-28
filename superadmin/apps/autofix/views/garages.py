"""Garages: list with filters, bulk bar and CSV export; detail with HTMX tabs; audited actions."""

import logging
from urllib.parse import urlencode, urlsplit

from django.conf import settings
from django.contrib import messages
from django.core.exceptions import BadRequest, PermissionDenied, ValidationError
from django.http import Http404, HttpResponseRedirect
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone
from django.utils.html import format_html
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.accounts import stepup
from apps.accounts.roles import SUPERADMIN, SUPPORT, can_change_autofix, can_support, role_required
from apps.audit.services import record
from apps.core.csv_io import csv_response
from apps.core.htmx import close_modal_response
from apps.core.templatetags.tables import Column, build_table, density
from apps.core.templatetags.ui import badge_class

from .. import plans, selectors, services
from ..db import AutofixUnavailable
from ..forms import BulkStatusForm, PlanStatusForm, ViewAsSupportForm
from .common import parse_uuid, render_unavailable, unavailable_message

logger = logging.getLogger(__name__)

TARGET_ID = "garage-results"
TABS = (
    ("overview", "Overview"),
    ("team", "Team"),
    ("bookings", "Bookings"),
    ("domains", "Domains"),
    ("messaging", "Messaging and reminders"),
    ("plan", "Plan and status"),
    ("agreements", "Agreements"),
    ("audit", "Audit"),
)
TAB_KEYS = {key for key, _ in TABS}
MAX_BULK = 100
COLUMNS = [
    Column("select", "Select"),
    Column("name", "Garage", sort_field="name"),
    Column("plan", "Plan", sort_field="plan", nowrap=True),
    Column("status", "Status", sort_field="status", nowrap=True),
    Column("team", "Team", sort_field="member_count", numeric=True),
    Column("bookings", "Bookings, 30 days", sort_field="bookings_30d", numeric=True),
    Column("last", "Last booking", sort_field="last_booking_at", nowrap=True),
    Column("joined", "Signed up", sort_field="created_at", nowrap=True),
]


def _allow_handoff(response):
    """CSP form-action also covers the redirect after a form post: let View as support leave for Autofix."""
    origin = urlsplit(settings.AUTOFIX_APP_URL)
    if origin.scheme in ("http", "https") and origin.netloc:
        response._csp_update = {"form-action": [f"{origin.scheme}://{origin.netloc}"]}
    return response


def _when(moment, fmt="%d %b %Y") -> str:
    return timezone.localtime(moment).strftime(fmt) if moment else "—"


def _row(garage):
    status = selectors.STATUS_LABELS.get(garage.status, garage.status)
    domain_flag = (
        format_html(' <span class="{}">Domain failing</span>', badge_class("failed"))
        if garage.domain_failing
        else ""
    )
    return [
        format_html(
            '<label class="-m-3 inline-flex min-h-11 min-w-11 items-center justify-center">'
            '<input type="checkbox" name="ids" value="{}" form="bulk-form" class="h-5 w-5 rounded border-slate-300" '
            'aria-label="Select {}" data-bulk-item></label>',
            garage.pk,
            garage.name,
        ),
        format_html(
            '<a class="font-medium text-link hover:underline" href="{}">{}</a>'
            '<span class="muted block text-xs">{}</span>',
            reverse("autofix:garage", args=[garage.pk]),
            garage.name,
            garage.slug,
        ),
        garage.plan_label,
        format_html('<span class="{}">{}</span>{}', badge_class(garage.status), status, domain_flag),
        str(garage.member_count),
        str(garage.bookings_30d),
        _when(garage.last_booking_at),
        _when(garage.created_at),
    ]


def _is_partial(request) -> bool:
    htmx = getattr(request, "htmx", None)
    return bool(htmx) and not htmx.history_restore_request and htmx.target == TARGET_ID


@role_required()
@require_GET
@never_cache
def garage_list(request):
    filters = selectors.clean_garage_filters(request.GET)
    try:
        queryset = selectors.garages(filters)
        table = build_table(
            request,
            queryset,
            COLUMNS,
            _row,
            caption="Garages on Autofix",
            target_id=TARGET_ID,
            url=reverse("autofix:garages"),
            default_sort="joined",
            default_dir="desc",
            tiebreak=("id",),
            per_page=25,
            empty_message="No garages match these filters.",
        )
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garages")
    if _is_partial(request):
        return render(request, "partials/data_table.html", {"table": table})
    context = {
        "table": table,
        "filters": filters,
        "plans": plans.FILTERS,
        "statuses": selectors.GARAGE_STATUSES,
        "sort": request.GET.get("sort", ""),
        "dir": request.GET.get("dir", ""),
        "density": density(request),
        "bulk_url": reverse("autofix:garages_bulk"),
        "bulk_qs": request.GET.urlencode(),
        "bulk_actions": [{"key": "export", "label": "Export selected (CSV)"}]
        + ([{"key": "status", "label": "Change status…"}] if can_change_autofix(request.user) else []),
        "export_url": f"{reverse('autofix:garages_export')}?{urlencode({k: v for k, v in filters.items() if v})}",
    }
    return render(request, "autofix/garages.html", context)


def _export(request, filters, ids=None):
    try:
        rows = selectors.garages_for_export(filters, ids)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garages")
    record(
        "autofix.garages_exported",
        request=request,
        entity_type="autofix.garage",
        summary=f"{len(rows)} garages",
        rows=len(rows),
        filters=urlencode({k: v for k, v in filters.items() if v}),
        selected=bool(ids),
    )
    return csv_response(
        "autofix-garages",
        ["id", "name", "slug", "plan", "status", "team", "bookings_30d", "last_booking_at", "signed_up_at"],
        (
            [
                g.pk,
                g.name,
                g.slug,
                g.plan,
                g.status,
                g.member_count,
                g.bookings_30d,
                g.last_booking_at.isoformat() if g.last_booking_at else "",
                g.created_at.isoformat(),
            ]
            for g in rows
        ),
    )


@role_required()
@require_GET
@never_cache
def garage_export(request):
    """Business fields only (no contact details): any role may export."""
    return _export(request, selectors.clean_garage_filters(request.GET))


def _selected_ids(request) -> list[str]:
    ids = []
    for raw in request.POST.getlist("ids"):
        value = str(parse_uuid(raw)) if raw else ""
        if value and value not in ids:
            ids.append(value)
    if len(ids) > MAX_BULK:
        raise BadRequest("Too many garages selected.")
    return ids


@role_required()
@require_POST
def garage_bulk(request):
    try:
        ids = _selected_ids(request)
    except Http404:
        raise BadRequest("Invalid selection.") from None
    action = request.POST.get("action", "")
    back = f"{reverse('autofix:garages')}?{request.POST.get('qs', '')[:500]}"
    if not ids:
        messages.error(request, "Select at least one garage.")
        return HttpResponseRedirect(back)
    if action == "export":
        return _export(request, {}, ids)
    if action != "status":
        raise BadRequest("Unknown action.")
    if not can_change_autofix(request.user):
        raise PermissionDenied
    try:
        garages = selectors.garages_by_ids(ids)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garages")
    form = BulkStatusForm(request.POST if request.POST.get("confirm") else None, user=request.user)
    if request.POST.get("confirm") and form.is_valid():
        done, failed = 0, []
        for garage in garages:
            if garage.status == form.cleaned_data["status"]:
                continue
            try:
                outcome = services.change_plan_status(
                    request,
                    garage,
                    plan=None,
                    status=form.cleaned_data["status"],
                    reason=form.cleaned_data["reason"],
                )
            except ValidationError as exc:
                failed.append(f"{garage.name}: {' '.join(exc.messages)}")
                continue
            if outcome.ok:
                done += 1
            else:
                failed.append(f"{garage.name}: {outcome.message}")
        if failed:
            messages.error(request, f"{done} changed. Not changed: {'; '.join(failed)}")
        else:
            messages.success(request, f"{done} garage{'s' if done != 1 else ''} changed.")
        return HttpResponseRedirect(back)
    return render(
        request,
        "autofix/bulk_confirm.html",
        {"garages": garages, "form": form, "ids": ids, "qs": request.POST.get("qs", "")[:500]},
    )


@role_required()
@require_GET
@never_cache
def garage_detail(request, pk):
    pk = parse_uuid(pk)
    try:
        garage = selectors.garage(pk)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garage")
    if garage is None:
        raise Http404
    tab = request.GET.get("tab", "overview")
    tab = tab if tab in TAB_KEYS else "overview"
    context = {"garage": garage, "tabs": TABS, "tab": tab}
    context.update(_tab_context(request, garage, tab))
    return _allow_handoff(render(request, "autofix/garage_detail.html", context))


def _tab_context(request, garage, tab: str) -> dict:
    """Data for one tab. Failures show inside the tab, so the rest of the page still works."""
    loaders = {
        "overview": lambda: {
            "overview": selectors.garage_overview(garage),
            "impersonations": selectors.garage_impersonations(garage),
        },
        "team": lambda: {"team": selectors.garage_team(garage)},
        "bookings": lambda: {"bookings": selectors.garage_bookings(garage)},
        "domains": lambda: {"domains": selectors.garage_domains(garage)},
        "messaging": lambda: {"messaging": selectors.garage_messaging(garage)},
        "plan": lambda: {"history": selectors.garage_plan_history(garage), "plan_form": _plan_form(garage)},
        "agreements": lambda: {"agreements": selectors.garage_agreements(garage)},
        "audit": lambda: {
            "platform_audit": selectors.garage_platform_audit(garage),
            "local_audit": _local_audit(garage),
        },
    }
    try:
        return loaders[tab]()
    except AutofixUnavailable as error:
        return {"tab_error": unavailable_message(error)}


def _plan_form(garage):
    return PlanStatusForm(initial={"plan": plans.effective(garage), "status": garage.status})


def _local_audit(garage):
    from apps.audit.models import AuditEvent

    return list(AuditEvent.objects.filter(entity_type="autofix.garage", entity_id=str(garage.pk))[:50])


@role_required()
@require_GET
@never_cache
def garage_tab(request, pk, tab):
    pk = parse_uuid(pk)
    if tab not in TAB_KEYS:
        raise Http404
    try:
        garage = selectors.garage(pk)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garage")
    if garage is None:
        raise Http404
    context = {"garage": garage, "tab": tab}
    context.update(_tab_context(request, garage, tab))
    return render(request, f"autofix/tabs/{tab}.html", context)


def _garage_or_404(pk):
    garage = selectors.garage(parse_uuid(pk))
    if garage is None:
        raise Http404
    return garage


@role_required(SUPERADMIN)
@require_http_methods(["GET", "POST"])
def garage_plan(request, pk):
    try:
        garage = _garage_or_404(pk)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garage")
    form = PlanStatusForm(
        request.POST or None,
        initial={"plan": plans.effective(garage), "status": garage.status},
        user=request.user,
    )
    if request.method == "POST" and form.is_valid():
        try:
            outcome = services.change_plan_status(request, garage, **form.cleaned_data)
        except ValidationError as exc:
            form.add_error(None, exc)
        else:
            if outcome.ok:
                return close_modal_response(
                    request, f"{reverse('autofix:garage', args=[garage.pk])}?tab=plan", outcome.message
                )
            form.add_error(None, outcome.message)
    return render(
        request,
        "partials/form_modal.html",
        {
            "form": form,
            "title": f"Change plan or status: {garage.name}",
            "action": reverse("autofix:garage_plan", args=[garage.pk]),
            "submit": "Save change",
            "cancel_url": f"{reverse('autofix:garage', args=[garage.pk])}?tab=plan",
        },
    )


@role_required(SUPPORT)
@require_http_methods(["GET", "POST"])
def view_as_support(request, pk):
    """Audited POST, then a redirect to Autofix's own read-only support session. No credentials."""
    try:
        garage = _garage_or_404(pk)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garage")
    form = ViewAsSupportForm(request.POST or None, user=request.user)
    if request.method == "POST" and form.is_valid():
        destination = services.view_as_support(request, garage, form.cleaned_data["reason"])
        return _allow_handoff(HttpResponseRedirect(destination))
    return _allow_handoff(
        render(
            request,
            "autofix/view_as_support.html",
            {
                "form": form,
                "garage": garage,
                "title": f"View as support: {garage.name}",
                "action": reverse("autofix:view_as_support", args=[garage.pk]),
            },
        )
    )


@role_required(SUPPORT)
@require_POST
@never_cache
def booking_people(request, pk):
    """Customer names and masked contacts on a garage's recent bookings. Support only; audited."""
    if not can_support(request.user):
        raise PermissionDenied
    if not stepup.check(request.user, request.POST.get(stepup.FIELD)):
        response = render(request, "autofix/tabs/_step_up_refused.html", {"message": stepup.INVALID})
        response["Cache-Control"] = "no-store"
        return response
    try:
        garage = _garage_or_404(pk)
        rows = selectors.garage_booking_people(garage)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Garage")
    services.record_personal_data_view(request, garage, "customer details on recent bookings", len(rows))
    response = render(request, "autofix/tabs/_booking_people.html", {"garage": garage, "people": rows})
    response["Cache-Control"] = "no-store"
    return response
