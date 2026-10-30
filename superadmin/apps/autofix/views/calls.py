"""Calls and voicemails: every garage's calls and Pitline's own line (A420), the garage Calls tab, and
audited voicemail playback.

SuperAdmin and Support only (``can_support``): callers are masked by the database, but who called a
garage and what they said is still the garage's customer data. Finance sees neither page nor tab.

Playback (``voicemail.py``): an audited POST with a fresh authenticator code returns a player whose
source carries a ten-minute ticket for that person and call; the stream fetches the recording from
Twilio server-side and records each playback. The browser never sees a Twilio link or credential.
"""

from urllib.parse import urlencode

from django.core.exceptions import PermissionDenied
from django.http import Http404, JsonResponse, StreamingHttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import render
from django.template.loader import render_to_string
from django.urls import reverse
from django.utils import timezone
from django.utils.html import format_html
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_POST

from apps.accounts import stepup
from apps.accounts.roles import SUPPORT, can_support, role_required
from apps.core.templatetags.tables import Column, build_table, density
from apps.core.templatetags.ui import badge_class, icon
from apps.notifications.services import mark_voicemail_read

from .. import selectors, services, voicemail
from ..db import AutofixUnavailable
from .common import parse_uuid, render_unavailable, unavailable_message

TARGET_ID = "call-results"
COLUMNS = [
    Column("when", "When", sort_field="created_at", nowrap=True),
    Column("garage", "Garage", sort_field="garage__name"),
    Column("caller", "Caller", mono=True, nowrap=True),
    Column("call", "Call", sort_field="missed", nowrap=True),
    Column("voicemail", "Voicemail", sort_field="voicemail_duration_s"),
    Column("text_back", "Text-back", nowrap=True),
]
GARAGE_COLUMNS = [column for column in COLUMNS if column.key != "garage"]
NOT_CONFIGURED = (
    "Voicemail playback is not set up here: the super admin needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN."
)
NOT_OURS = "This recording is not on Pitline's Twilio account, so it cannot be played here."
PRIVATE = "private, no-store, max-age=0"
WITHHELD = format_html('<span class="muted font-sans">{}</span>', "Withheld")
NO_VOICEMAIL = format_html('<span class="muted">{}</span>', "None")
NOT_SENT = format_html('<span class="muted">{}</span>', "Not sent")


def seconds_label(seconds) -> str:
    if seconds is None:
        return "—"
    minutes, rest = divmod(int(seconds), 60)
    return f"{minutes} min {rest:02d} s" if minutes else f"{rest} s"


def _row(csrf_input, show_garage: bool):
    step_up = stepup.enabled()

    def row(call):
        when = timezone.localtime(call.created_at)
        caller = call.caller_masked or WITHHELD
        if call.missed:
            outcome = format_html('<span class="{}">Missed</span>', badge_class("missed"))
        else:
            outcome = format_html(
                '<span class="{}">Answered</span> <span class="muted text-xs">{}</span>',
                badge_class("answered"),
                seconds_label(call.duration_s) if call.duration_s is not None else "",
            )
        if call.has_voicemail:
            action = reverse("autofix:voicemail", args=[call.pk])
            heard = format_html(
                '<div id="vm-{}" class="flex flex-wrap items-center gap-2" data-testid="voicemail-cell">'
                '<span class="tabular-nums">{}</span>'
                '<form method="post" action="{}" hx-post="{}" hx-target="#vm-{}" hx-swap="innerHTML" '
                'class="flex flex-wrap items-center gap-2" data-no-submit-overlay>{}{}'
                '<button type="submit" class="btn btn-secondary btn-sm" aria-label="Play the voicemail from {}" '
                'data-testid="play-voicemail">{} Play</button></form></div>',
                call.pk,
                seconds_label(call.voicemail_duration_s),
                action,
                action,
                call.pk,
                csrf_input,
                render_to_string("partials/step_up_inline.html", {"step_up": step_up, "id": call.pk}),
                when.strftime("%d %b %H:%M"),
                icon("play", "h-4 w-4"),
            )
        else:
            heard = NO_VOICEMAIL
        if not call.missed or call.is_platform:
            # Pitline's own line has no SMS sender, so there is never a text-back (A420).
            text_back = "—"
        elif call.text_back_status:
            label = selectors.TEXT_BACK_LABELS.get(call.text_back_status, call.text_back_status.title())
            text_back = format_html('<span class="{}">{}</span>', badge_class(call.text_back_status), label)
        else:
            text_back = NOT_SENT
        cells = [when.strftime("%a %d %b %H:%M")]
        if show_garage and call.is_platform:
            cells.append(
                format_html(
                    '<a class="text-link hover:underline" href="{}?garage={}" data-testid="platform-line">{}</a>',
                    reverse("autofix:calls"),
                    selectors.PLATFORM_LINE,
                    call.line_name,
                )
            )
        elif show_garage:
            cells.append(
                format_html(
                    '<a class="text-link hover:underline" href="{}?tab=calls">{}</a>',
                    reverse("autofix:garage", args=[call.garage_id]),
                    call.garage.name,
                )
            )
        return [*cells, caller, outcome, heard, text_back]

    return row


def calls_table(request, filters: dict, *, url: str, show_garage: bool) -> dict:
    """The calls table, shared by the Calls page and the garage Calls tab. Raises AutofixUnavailable."""
    csrf_input = format_html(
        '<input type="hidden" name="csrfmiddlewaretoken" value="{}">', get_token(request)
    )
    return build_table(
        request,
        selectors.calls(filters),
        COLUMNS if show_garage else GARAGE_COLUMNS,
        _row(csrf_input, show_garage),
        caption="Calls to garages, newest first. Callers are masked",
        target_id=TARGET_ID,
        url=url,
        default_sort="when",
        default_dir="desc",
        tiebreak=("id",),
        per_page=25,
        empty_message="No calls match these filters.",
    )


def is_table_request(request) -> bool:
    htmx = getattr(request, "htmx", None)
    return bool(htmx) and not htmx.history_restore_request and htmx.target == TARGET_ID


@role_required(SUPPORT)
@require_GET
@never_cache
def calls(request):
    filters = selectors.clean_call_filters(request.GET)
    try:
        table = calls_table(request, filters, url=reverse("autofix:calls"), show_garage=True)
        garages = selectors.call_garages()
    except AutofixUnavailable as error:
        return render_unavailable(request, error, "Calls")
    if is_table_request(request):
        return render(request, "partials/data_table.html", {"table": table})
    return render(
        request,
        "autofix/calls.html",
        {
            "table": table,
            "filters": filters,
            "garages": garages,
            "sort": request.GET.get("sort", ""),
            "dir": request.GET.get("dir", ""),
            "density": density(request),
        },
    )


def garage_calls(request, garage) -> dict:
    """Context for the garage Calls tab: this garage's calls, with the missed and voicemail filters."""
    if not can_support(request.user):
        raise PermissionDenied
    params = request.GET.copy()
    params["tab"] = "calls"
    request.GET = params  # the table's sort and page links keep the tab
    filters = {**selectors.clean_call_filters(params), "garage": str(garage.pk)}
    url = reverse("autofix:garage", args=[garage.pk])
    try:
        table = calls_table(request, filters, url=url, show_garage=False)
    except AutofixUnavailable as error:
        return {"tab_error": unavailable_message(error)}
    return {"calls_table": table, "call_filters": filters, "density": density(request)}


@role_required(SUPPORT)
@require_POST
@never_cache
def voicemail_player(request, pk):
    """Step 1: a fresh authenticator code, then a player for this voicemail (ticket in its source)."""
    pk = parse_uuid(pk)
    if not stepup.check(request.user, request.POST.get(stepup.FIELD)):
        return _partial(request, "autofix/tabs/_step_up_refused.html", {"message": stepup.INVALID})
    try:
        found = selectors.voicemail(pk)
    except AutofixUnavailable as error:
        return _partial(
            request, "autofix/tabs/_step_up_refused.html", {"message": unavailable_message(error)}
        )
    if found is None:
        raise Http404
    call, link = found
    if not voicemail.is_configured():
        return _partial(request, "autofix/tabs/_step_up_refused.html", {"message": NOT_CONFIGURED})
    if not voicemail.own_recording(link):
        return _partial(request, "autofix/tabs/_step_up_refused.html", {"message": NOT_OURS})
    source = reverse("autofix:voicemail_audio", args=[call.pk])
    source = f"{source}?{urlencode({'ticket': voicemail.issue_ticket(request.user, call.pk)})}"
    return _partial(
        request,
        "autofix/_voicemail_player.html",
        {"call": call, "source": source, "seconds": seconds_label(call.voicemail_duration_s)},
    )


@role_required(SUPPORT)
@require_GET
@never_cache
def voicemail_audio(request, pk):
    """Step 2: the recording, fetched from Twilio with the account's credentials. Audited per playback."""
    pk = parse_uuid(pk)
    if not voicemail.ticket_ok(request.GET.get("ticket"), request.user, pk):
        return _audio_error(403, "ticket_required")
    try:
        found = selectors.voicemail(pk)
    except AutofixUnavailable:
        return _audio_error(503, "unavailable")
    if found is None:
        return _audio_error(404, "not_found")
    call, link = found
    try:
        recording = voicemail.fetch(link)
    except voicemail.FetchError as error:
        return _audio_error(error.status, error.code)
    services.record_voicemail_played(request, call)
    mark_voicemail_read(request.user, call.pk)
    response = StreamingHttpResponse(recording.chunks(), content_type=recording.content_type)
    if recording.length and recording.length.isdigit():
        response["Content-Length"] = recording.length
    response["Content-Disposition"] = 'inline; filename="voicemail.mp3"'
    response["Cache-Control"] = PRIVATE
    return response


def _partial(request, template: str, context: dict):
    response = render(request, template, context)
    response["Cache-Control"] = PRIVATE
    return response


def _audio_error(status: int, code: str):
    response = JsonResponse({"code": code}, status=status)
    response["Cache-Control"] = PRIVATE
    return response
