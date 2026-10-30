"""Calls: the cross-garage list, the garage tab, voicemail playback (proxy, tickets, audit) and alerts."""

import io
import urllib.error
from datetime import timedelta
from unittest import mock

import pytest
from django.core.management import call_command
from django.urls import reverse

from apps.audit.models import AuditEvent
from apps.autofix import models as m
from apps.autofix import selectors, voicemail
from apps.notifications.models import Notification, NotificationPreference

from .conftest import HX
from .factories import TWILIO_ACCOUNT

MP3 = b"ID3fake-mp3-bytes"


@pytest.fixture(autouse=True)
def twilio(settings):
    settings.TWILIO_ACCOUNT_SID = TWILIO_ACCOUNT
    settings.TWILIO_AUTH_TOKEN = "test-auth-token"


@pytest.fixture
def phone(af, seeded):
    """Hartley's calls: a missed call with a voicemail and a delivered text-back, an answered call,
    a withheld missed call with no text-back, and Demo B's voicemail."""
    hartley, demo = seeded["hartley"], seeded["demo"]
    text_back = af.make(m.Message, garage=hartley, status="delivered")
    voicemail_call = af.call(
        hartley,
        voicemail_s=42,
        caller_masked="07••• •••123",
        text_back_message_id=text_back.pk,
        created_at=af.now - timedelta(minutes=5),
    )
    answered = af.call(
        hartley, caller_masked="07••• •••456", duration_s=130, created_at=af.now - timedelta(hours=2)
    )
    withheld = af.call(hartley, missed=True, created_at=af.now - timedelta(hours=3))
    other = af.call(demo, voicemail_s=9, caller_masked="01••• •••789", created_at=af.now - timedelta(days=3))
    return {"voicemail": voicemail_call, "answered": answered, "withheld": withheld, "other": other}


class FakeUpstream:
    def __init__(self, body=MP3):
        self._body = io.BytesIO(body)
        self.headers = {"Content-Length": str(len(body))}
        self.closed = False

    def read(self, size=-1):
        return self._body.read(size)

    def close(self):
        self.closed = True


@pytest.fixture
def upstream():
    with mock.patch.object(voicemail._opener, "open") as opened:
        opened.side_effect = lambda request, timeout: FakeUpstream()
        yield opened


def player(client, call, **data):
    return client.post(reverse("autofix:voicemail", args=[call.pk]), data, **HX)


def audio_url(response) -> str:
    html = response.content.decode()
    start = html.index('src="') + 5
    return html[start : html.index('"', start)].replace("&amp;", "&")


# --- The list ----------------------------------------------------------------------------------


def test_calls_list_shows_every_garage_newest_first(client_for, support, phone):
    html = client_for(support).get(reverse("autofix:calls")).content.decode()
    assert html.index("07••• •••123") < html.index("07••• •••456") < html.index("01••• •••789")
    assert "Hartley Road Motors" in html and "Demo Garage B" in html
    assert "Withheld" in html and "Missed" in html and "Answered" in html
    assert "42 s" in html and "2 min 10 s" in html and "Delivered" in html and "Not sent" in html
    assert 'data-nav="calls"' in html and 'aria-current="page" data-nav="calls"' in html


def test_calls_list_never_carries_a_recording_link_or_raw_number(client_for, superadmin, phone):
    html = client_for(superadmin).get(reverse("autofix:calls")).content.decode()
    assert "api.twilio.com" not in html and "Recordings" not in html and TWILIO_ACCOUNT not in html
    assert "+447700900123" not in html


@pytest.mark.parametrize(
    ("query", "shown", "hidden"),
    [
        ("missed=1", ["07••• •••123", "Withheld"], ["07••• •••456"]),
        ("voicemail=1", ["07••• •••123", "01••• •••789"], ["07••• •••456", "Withheld"]),
    ],
)
def test_calls_list_filters(client_for, support, phone, query, shown, hidden):
    html = client_for(support).get(f"{reverse('autofix:calls')}?{query}").content.decode()
    for text in shown:
        assert text in html
    for text in hidden:
        assert text not in html.split('data-testid="data-table"')[1]


def test_calls_list_filters_by_garage_and_drops_bad_ids(client_for, support, seeded, phone):
    client = client_for(support)
    url = reverse("autofix:calls")
    html = client.get(f"{url}?garage={seeded['demo'].pk}").content.decode()
    table = html.split('data-testid="data-table"')[1]
    assert "01••• •••789" in table and "07••• •••123" not in table
    assert client.get(f"{url}?garage=not-a-uuid").status_code == 200


def test_calls_htmx_filter_returns_only_the_table(client_for, support, phone):
    response = client_for(support).get(
        reverse("autofix:calls") + "?missed=1", HTTP_HX_REQUEST="true", HTTP_HX_TARGET="call-results"
    )
    html = response.content.decode()
    assert response.status_code == 200 and "<html" not in html and 'id="call-results"' in html


def test_calls_sort_is_whitelisted(client_for, support, phone):
    assert client_for(support).get(reverse("autofix:calls") + "?sort=caller_masked").status_code == 200


def test_finance_cannot_see_calls(client_for, finance, seeded, phone):
    client = client_for(finance)
    assert client.get(reverse("autofix:calls")).status_code == 403
    assert 'data-nav="calls"' not in client.get(reverse("core:overview")).content.decode()


def test_calls_page_says_when_autofix_is_down(client_for, support, settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    response = client_for(support).get(reverse("autofix:calls"))
    assert response.status_code == 503 and b"not connected" in response.content


def test_text_back_status_comes_from_the_message(phone):
    rows = {call.pk: call for call in selectors.calls({})}
    assert rows[phone["voicemail"].pk].text_back_status == "delivered"
    assert rows[phone["withheld"].pk].text_back_status is None


# --- The garage tab ----------------------------------------------------------------------------


def test_garage_calls_tab_shows_only_that_garage(client_for, support, seeded, phone):
    client = client_for(support)
    garage = seeded["hartley"]
    page = client.get(reverse("autofix:garage", args=[garage.pk]) + "?tab=calls").content.decode()
    assert 'data-testid="tab-calls"' in page and "07••• •••123" in page and "01••• •••789" not in page
    partial = client.get(reverse("autofix:garage_tab", args=[garage.pk, "calls"]), **HX).content.decode()
    assert "<html" not in partial and "07••• •••456" in partial
    # Sort and page links stay on the garage page and keep the tab.
    assert f"/garages/{garage.pk}/?" in partial and "tab=calls" in partial


def test_garage_calls_tab_filters_through_htmx(client_for, support, seeded, phone):
    garage = seeded["hartley"]
    response = client_for(support).get(
        reverse("autofix:garage", args=[garage.pk]) + "?tab=calls&voicemail=1",
        HTTP_HX_REQUEST="true",
        HTTP_HX_TARGET="call-results",
    )
    html = response.content.decode()
    assert "<html" not in html and "07••• •••123" in html and "07••• •••456" not in html


def test_finance_has_no_calls_tab(client_for, finance, seeded, phone):
    client = client_for(finance)
    garage = seeded["hartley"]
    page = client.get(reverse("autofix:garage", args=[garage.pk]) + "?tab=calls").content.decode()
    assert 'data-tab="calls"' not in page and 'data-testid="tab-overview"' in page
    assert client.get(reverse("autofix:garage_tab", args=[garage.pk, "calls"])).status_code == 403


# --- Playback ----------------------------------------------------------------------------------


def test_play_returns_a_player_with_a_ticket_not_a_twilio_link(client_for, support, phone):
    response = player(client_for(support), phone["voicemail"])
    html = response.content.decode()
    assert response.status_code == 200 and 'data-testid="voicemail-player"' in html
    assert "api.twilio.com" not in html and TWILIO_ACCOUNT not in html
    assert audio_url(response).startswith(reverse("autofix:voicemail_audio", args=[phone["voicemail"].pk]))
    assert response["Cache-Control"].startswith("private, no-store")
    # Opening the player is not a playback.
    assert not AuditEvent.objects.filter(action="autofix.voicemail_played").exists()


def test_audio_streams_through_the_proxy_with_credentials_and_is_audited(
    client_for, support, phone, upstream
):
    client = client_for(support)
    call = phone["voicemail"]
    response = client.get(audio_url(player(client, call)))
    assert response.status_code == 200 and b"".join(response.streaming_content) == MP3
    assert response["Content-Type"] == "audio/mpeg" and response["Cache-Control"].startswith(
        "private, no-store"
    )
    request = upstream.call_args.args[0]
    link = m.CallVoicemail.objects.get(pk=call.pk).voicemail_url
    assert request.full_url == f"{link}.mp3" and request.get_header("Authorization").startswith("Basic ")
    event = AuditEvent.objects.get(action="autofix.voicemail_played")
    assert event.entity_type == "autofix.call" and event.entity_id == str(call.pk)
    assert event.actor == support and "Hartley Road Motors" in event.summary
    # No caller number, masked or full. ("07" alone would also match the time in the summary, e.g. 22:07.)
    assert "•••" not in event.summary and "+44" not in event.summary
    assert "twilio" not in str(event.metadata).lower()
    client.get(audio_url(player(client, call)))
    assert AuditEvent.objects.filter(action="autofix.voicemail_played").count() == 2


def test_audio_needs_a_ticket_for_this_person_and_call(client_for, support, superadmin, phone, upstream):
    call, other = phone["voicemail"], phone["other"]
    url = reverse("autofix:voicemail_audio", args=[call.pk])
    support_client = client_for(support)
    assert support_client.get(url).status_code == 403
    assert support_client.get(f"{url}?ticket=forged").status_code == 403
    theirs = audio_url(player(support_client, call))
    assert client_for(superadmin).get(theirs).status_code == 403
    other_call = audio_url(player(support_client, other)).split("?")[1]
    assert support_client.get(f"{url}?{other_call}").status_code == 403
    upstream.assert_not_called()
    assert not AuditEvent.objects.filter(action="autofix.voicemail_played").exists()


def test_ticket_expires(support, phone):
    call = phone["voicemail"]
    ticket = voicemail.issue_ticket(support, call.pk)
    assert voicemail.ticket_ok(ticket, support, call.pk)
    with mock.patch("django.core.signing.time.time", return_value=10**10):
        assert not voicemail.ticket_ok(ticket, support, call.pk)


def test_finance_cannot_play(client_for, finance, support, phone, upstream):
    call = phone["voicemail"]
    client = client_for(finance)
    assert player(client, call).status_code == 403
    ticket = voicemail.issue_ticket(finance, call.pk)
    url = reverse("autofix:voicemail_audio", args=[call.pk])
    assert client.get(f"{url}?ticket={ticket}").status_code == 403
    upstream.assert_not_called()


def test_play_without_a_voicemail_is_404(client_for, support, phone):
    assert player(client_for(support), phone["answered"]).status_code == 404
    assert client_for(support).post("/calls/not-a-uuid/voicemail/").status_code == 404


def test_play_needs_post(client_for, support, phone):
    assert (
        client_for(support).get(reverse("autofix:voicemail", args=[phone["voicemail"].pk])).status_code == 405
    )


@pytest.mark.parametrize(
    "link",
    [
        # Another Twilio account: our credentials never go there.
        f"https://api.twilio.com/2010-04-01/Accounts/AC{'2' * 32}/Recordings/RE{'a' * 32}",
        # Not a recording resource.
        f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT}/Calls/CA{'a' * 32}",
        f"https://evil.example/2010-04-01/Accounts/{TWILIO_ACCOUNT}/Recordings/RE{'a' * 32}",
        f"http://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT}/Recordings/RE{'a' * 32}",
        f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT}/Recordings/RE{'a' * 32}?x=1",
    ],
)
def test_only_our_own_recordings_are_fetched(client_for, support, af, seeded, upstream, link):
    call = af.call(seeded["hartley"], voicemail_s=5, voicemail_url=link)
    client = client_for(support)
    response = player(client, call)
    assert (
        "not on Pitline" in response.content.decode() and "voicemail-player" not in response.content.decode()
    )
    ticket = voicemail.issue_ticket(support, call.pk)
    audio = client.get(f"{reverse('autofix:voicemail_audio', args=[call.pk])}?ticket={ticket}")
    assert audio.status_code == 404
    upstream.assert_not_called()


def test_recording_url_check_matches_the_app(settings):
    good = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT}/Recordings/RE{'0' * 32}"
    assert voicemail.is_twilio_recording_url(good) and voicemail.own_recording(good)
    assert not voicemail.is_twilio_recording_url(good + "\n")
    assert not voicemail.is_twilio_recording_url(None)
    settings.TWILIO_ACCOUNT_SID = ""
    assert not voicemail.own_recording(good)


def test_playback_says_when_twilio_is_not_configured(client_for, support, phone, settings, upstream):
    settings.TWILIO_AUTH_TOKEN = ""
    client = client_for(support)
    call = phone["voicemail"]
    assert "not set up" in player(client, call).content.decode()
    ticket = voicemail.issue_ticket(support, call.pk)
    response = client.get(f"{reverse('autofix:voicemail_audio', args=[call.pk])}?ticket={ticket}")
    assert response.status_code == 503 and response.json() == {"code": "not_configured"}
    upstream.assert_not_called()


@pytest.mark.parametrize(("status", "expected"), [(404, 404), (401, 502), (500, 502)])
def test_upstream_errors_are_not_audited(client_for, support, phone, upstream, status, expected):
    upstream.side_effect = urllib.error.HTTPError("https://api.twilio.com/x", status, "no", {}, io.BytesIO())
    client = client_for(support)
    response = client.get(audio_url(player(client, phone["voicemail"])))
    assert response.status_code == expected
    assert not AuditEvent.objects.filter(action="autofix.voicemail_played").exists()


def test_unreachable_twilio_is_502(client_for, support, phone, upstream):
    upstream.side_effect = urllib.error.URLError("down")
    client = client_for(support)
    assert client.get(audio_url(player(client, phone["voicemail"]))).status_code == 502


def test_redirects_stay_on_https_and_drop_credentials_off_twilio():
    handler = voicemail._SafeRedirects()
    original = voicemail.urllib.request.Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT}/Recordings/RE{'0' * 32}.mp3",
        headers={"Authorization": "Basic secret"},
    )
    same = handler.redirect_request(original, None, 302, "Found", {}, "https://api.twilio.com/media.mp3")
    assert same.get_header("Authorization") == "Basic secret"
    away = handler.redirect_request(original, None, 302, "Found", {}, "https://media.example/rec.mp3")
    assert away.get_header("Authorization") is None
    with pytest.raises(urllib.error.HTTPError):
        handler.redirect_request(original, io.BytesIO(), 302, "Found", {}, "http://media.example/rec.mp3")


def test_step_up_is_needed_to_play(client_for, support, phone, settings, upstream):
    from .test_step_up import code_for

    settings.AUTOFIX_STEP_UP = True
    client = client_for(support)
    call = phone["voicemail"]
    page = client.get(reverse("autofix:calls")).content.decode()
    assert 'name="step_up_code"' in page
    refused = player(client, call)
    assert "not accepted" in refused.content.decode() and "voicemail-player" not in refused.content.decode()
    shown = player(client, call, step_up_code=code_for(support))
    assert 'data-testid="voicemail-player"' in shown.content.decode()


# --- New voicemail alerts ----------------------------------------------------------------------


def scan():
    call_command("notify_attention", stdout=io.StringIO())


def test_new_voicemails_notify_support_once_without_the_caller(superadmin, support, finance, phone):
    scan()
    alerts = Notification.objects.filter(kind="voicemail")
    # The voicemail from 5 minutes ago, not the one from 3 days ago.
    assert alerts.filter(recipient=support).count() == 1 and alerts.filter(recipient=superadmin).count() == 1
    assert not alerts.filter(recipient=finance).exists()
    alert = alerts.get(recipient=support)
    assert alert.title == "New voicemail at Hartley Road Motors" and "42 seconds" in alert.body
    assert "07" not in alert.title and "•" not in alert.body
    assert alert.url == f"/calls/?garage={phone['voicemail'].garage_id}&voicemail=1"
    scan()
    assert alerts.count() == 2


def test_voicemail_alerts_can_be_turned_off(support, phone):
    NotificationPreference.objects.create(user=support, voicemails=False)
    scan()
    assert not Notification.objects.filter(recipient=support, kind="voicemail").exists()


def test_calls_badge_counts_unplayed_voicemails_and_playing_reads_them(client_for, support, phone, upstream):
    scan()
    client = client_for(support)
    badge = client.get(reverse("notifications:badge") + "?nav=calls").content.decode()
    assert 'data-testid="calls-badge"' in badge and "1" in badge and "new voicemails" in badge
    assert 'data-testid="calls-badge-slot"' in client.get(reverse("autofix:calls")).content.decode()
    client.get(audio_url(player(client, phone["voicemail"])))
    assert client.get(reverse("notifications:badge") + "?nav=calls").content.decode().strip() == ""
    assert not Notification.objects.filter(recipient=support, read_at__isnull=True, kind="voicemail").exists()


# --- Pitline's own line (A420) -----------------------------------------------------------------


@pytest.fixture
def platform_call(af, phone):
    return af.call(
        None,
        is_platform=True,
        voicemail_s=31,
        caller_masked="07••• •••777",
        created_at=af.now - timedelta(minutes=1),
    )


def test_platform_line_calls_are_listed_as_autofix_without_a_text_back(client_for, support, platform_call):
    html = client_for(support).get(reverse("autofix:calls")).content.decode()
    table = html.split('data-testid="data-table"')[1]
    row = next(row for row in table.split("<tr>") if "07••• •••777" in row).split("</tr>")[0]
    assert (
        "Pitline (platform line)" in row
        and 'data-testid="platform-line"' in row
        and "?garage=platform" in row
    )
    assert "Not sent" not in row and "Missed" in row and "31 s" in row
    # Newest first: a minute old, so before the voicemail from five minutes ago.
    assert table.index("07••• •••777") < table.index("07••• •••123")


def test_platform_line_filter(client_for, support, seeded, platform_call):
    client = client_for(support)
    html = client.get(f"{reverse('autofix:calls')}?garage=platform").content.decode()
    table = html.split('data-testid="data-table"')[1]
    assert "07••• •••777" in table and "07••• •••123" not in table and "01••• •••789" not in table
    assert '<option value="platform" selected>Pitline (platform line)</option>' in html
    by_garage = client.get(f"{reverse('autofix:calls')}?garage={seeded['hartley'].pk}").content.decode()
    assert "07••• •••777" not in by_garage.split('data-testid="data-table"')[1]


def test_garage_tabs_never_show_platform_line_calls(client_for, support, seeded, platform_call):
    garage = seeded["hartley"]
    tab = client_for(support).get(reverse("autofix:garage_tab", args=[garage.pk, "calls"]), **HX)
    assert "07••• •••777" not in tab.content.decode()
    # Messaging counts garage calls only: four at Hartley (the scenario's and three here), one at Demo B.
    assert selectors.garage_messaging(garage)["calls"]["total"] == 4
    assert selectors.messaging_summary()["calls"]["total"] == 5


def test_platform_line_voicemail_plays_and_is_audited(client_for, support, platform_call, upstream):
    client = client_for(support)
    response = client.get(audio_url(player(client, platform_call)))
    assert response.status_code == 200 and b"".join(response.streaming_content) == MP3
    event = AuditEvent.objects.get(action="autofix.voicemail_played")
    assert event.entity_id == str(platform_call.pk) and event.summary.startswith("Pitline (platform line)")
    assert event.metadata["line"] == "platform"


def test_platform_line_voicemails_raise_alerts(support, finance, platform_call):
    scan()
    alert = Notification.objects.get(recipient=support, dedupe_key=f"voicemail:{platform_call.pk}")
    assert alert.title == "New voicemail on Pitline (platform line)" and "31 seconds" in alert.body
    assert alert.url == "/calls/?garage=platform&voicemail=1"
    assert not Notification.objects.filter(recipient=finance, kind="voicemail").exists()
