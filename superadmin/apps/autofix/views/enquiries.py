"""Enquiries: what people send from the contact page (autofix.vitalos.co.uk/contact).

SuperAdmin and Support read them and change status and notes; Finance never sees them (they carry
contact details). The list shows who, about what and where it stands; the sender's email, phone and
message are on the detail page, and each opening of it is audited. Changes go through Autofix's
``platform_update_enquiry`` with a fresh authenticator code, like every other change.
"""

from django.contrib import messages
from django.core.exceptions import ValidationError
from django.http import Http404, HttpResponseRedirect
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone
from django.utils.html import format_html
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_POST

from apps.accounts.roles import SUPPORT, role_required
from apps.core.templatetags.tables import Column, build_table, density
from apps.core.templatetags.ui import badge_class

from .. import selectors, services
from ..db import AutofixUnavailable
from ..forms import EnquiryForm
from .common import parse_uuid, render_unavailable

TARGET_ID = "enquiry-results"
COLUMNS = [
    Column("received", "Received", sort_field="received_at", nowrap=True),
    Column("from", "From", sort_field="name"),
    Column("topic", "Topic", sort_field="topic", nowrap=True),
    Column("status", "Status", sort_field="status", nowrap=True),
    Column("handled", "Handled by"),
]


def _row(enquiry):
    garage = (
        format_html('<span class="muted block text-xs">{}</span>', enquiry.garage_name)
        if enquiry.garage_name
        else ""
    )
    return [
        timezone.localtime(enquiry.received_at).strftime("%d %b %Y %H:%M"),
        format_html(
            '<a class="font-medium text-link hover:underline" href="{}">{}</a>{}',
            reverse("autofix:enquiry", args=[enquiry.pk]),
            enquiry.name,
            garage,
        ),
        enquiry.get_topic_display(),
        format_html(
            '<span class="{}">{}</span>',
            badge_class(f"enquiry_{enquiry.status}"),
            enquiry.get_status_display(),
        ),
        enquiry.handled_by_name or "—",
    ]


def _no_store(response):
    response["Cache-Control"] = "no-store"
    return response


@role_required(SUPPORT)
@require_GET
@never_cache
def enquiry_list(request):
    filters = selectors.clean_enquiry_filters(request.GET)
    try:
        table = build_table(
            request,
            selectors.enquiries(filters),
            COLUMNS,
            _row,
            caption="Contact page enquiries, newest first",
            target_id=TARGET_ID,
            url=reverse("autofix:enquiries"),
            default_sort="received",
            default_dir="desc",
            tiebreak=("-id",),
            per_page=25,
            empty_message="No enquiries match these filters.",
        )
        counts = selectors.enquiry_counts()
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Enquiries")
    htmx = getattr(request, "htmx", None)
    if htmx and not htmx.history_restore_request and htmx.target == TARGET_ID:
        return render(request, "partials/data_table.html", {"table": table})
    return render(
        request,
        "autofix/enquiries.html",
        {
            "table": table,
            "counts": counts,
            "filters": filters,
            "statuses": selectors.ENQUIRY_STATUS_LABELS.items(),
            "topics": selectors.ENQUIRY_TOPIC_LABELS.items(),
            "density": density(request),
        },
    )


def _enquiry_or_404(pk):
    enquiry = selectors.enquiry(parse_uuid(pk))
    if enquiry is None:
        raise Http404
    return enquiry


def _history_text(entry) -> str:
    detail = entry.detail or {}
    if entry.action == "platform.enquiry_status_changed":
        labels = selectors.ENQUIRY_STATUS_LABELS
        before, after = detail.get("from"), detail.get("to")
        return f"Status: {labels.get(before, before)} → {labels.get(after, after)}"
    length = detail.get("length") or 0
    return f"Notes changed ({length} characters)" if length else "Notes cleared"


def _detail(request, enquiry, form, status=200):
    try:
        history = [
            {"when": entry.created_at, "actor": entry.actor_name, "text": _history_text(entry)}
            for entry in selectors.enquiry_history(enquiry.pk)
        ]
    except AutofixUnavailable:
        history = None
    return _no_store(
        render(
            request,
            "autofix/enquiry_detail.html",
            {"enquiry": enquiry, "form": form, "history": history},
            status=status,
        )
    )


@role_required(SUPPORT)
@require_GET
@never_cache
def enquiry_detail(request, pk):
    try:
        enquiry = _enquiry_or_404(pk)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Enquiry")
    services.record_enquiry_view(request, enquiry)
    form = EnquiryForm(initial={"status": enquiry.status, "notes": enquiry.notes or ""}, user=request.user)
    return _detail(request, enquiry, form)


@role_required(SUPPORT)
@require_POST
def enquiry_update(request, pk):
    try:
        enquiry = _enquiry_or_404(pk)
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Enquiry")
    form = EnquiryForm(request.POST, user=request.user)
    if form.is_valid():
        try:
            outcome = services.update_enquiry(
                request, enquiry, status=form.cleaned_data["status"], notes=form.cleaned_data["notes"]
            )
        except ValidationError as exc:
            form.add_error(None, exc)
        else:
            if outcome.ok:
                messages.success(request, outcome.message)
                return HttpResponseRedirect(reverse("autofix:enquiry", args=[enquiry.pk]))
            form.add_error(None, outcome.message)
    return _detail(request, enquiry, form, status=200)
