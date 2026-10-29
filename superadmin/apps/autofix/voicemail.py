"""Voicemail playback for Vitalos staff: the super admin's side of Pitline's voicemail proxy.

Pitline stores each voicemail as a Twilio recording link (``calls.voicemail_url``, via
``recordVoicemail``). Twilio recordings need the account's credentials, so, exactly as the garage
app's ``/api/admin/calls/{id}/voicemail`` (``src/lib/calls/voicemail.ts``) does:

- the browser never gets the Twilio link or the credentials: the MP3 is fetched here and streamed back
  privately (``Cache-Control: private, no-store``);
- a link is used only if it passes ``isTwilioRecordingUrl`` (``src/lib/calls/twiml.ts``) **and** belongs
  to the configured account, so the credentials only ever go to our own account's recordings;
- a redirect may not leave https, and the credentials are dropped if it leaves api.twilio.com.

Playback is two steps, so a fresh authenticator code guards it like every other personal-data view:
an audited POST with the step-up code returns a player whose source carries a short-lived ``ticket``
signed for that person and that call; the stream checks the ticket and audits each playback.
"""

import base64
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing

# Same pattern as TWILIO_RECORDING_URL in src/lib/calls/twiml.ts.
TWILIO_RECORDING_URL = re.compile(
    r"^https://api\.twilio\.com/2010-04-01/Accounts/AC[0-9a-fA-F]{32}/Recordings/RE[0-9a-fA-F]{32}$"
)
TICKET_SALT = "autofix.voicemail"
TICKET_MAX_AGE = 10 * 60
FETCH_TIMEOUT = 10
CHUNK = 64 * 1024


def is_twilio_recording_url(value) -> bool:
    return isinstance(value, str) and TWILIO_RECORDING_URL.fullmatch(value) is not None


def is_configured() -> bool:
    return bool(settings.TWILIO_ACCOUNT_SID and settings.TWILIO_AUTH_TOKEN)


def own_recording(url) -> bool:
    """A recording link we may send the account's credentials to: valid, and this account's own."""
    prefix = f"https://api.twilio.com/2010-04-01/Accounts/{settings.TWILIO_ACCOUNT_SID}/Recordings/"
    return is_twilio_recording_url(url) and bool(settings.TWILIO_ACCOUNT_SID) and url.startswith(prefix)


# --- Tickets -----------------------------------------------------------------------------------


def issue_ticket(user, call_id) -> str:
    return signing.dumps({"u": user.pk, "c": str(call_id)}, salt=TICKET_SALT, compress=True)


def ticket_ok(ticket, user, call_id) -> bool:
    """True for a ticket this person was issued for this call in the last ten minutes."""
    try:
        data = signing.loads(ticket or "", salt=TICKET_SALT, max_age=TICKET_MAX_AGE)
    except signing.BadSignature:
        return False
    return isinstance(data, dict) and data.get("u") == user.pk and data.get("c") == str(call_id)


# --- Fetch -------------------------------------------------------------------------------------


class FetchError(Exception):
    """The recording could not be fetched. ``status`` is what the proxy answers (404, 502 or 503)."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


class _SafeRedirects(urllib.request.HTTPRedirectHandler):
    """Follow Twilio's redirect to the media, but only over https, and without our credentials off-site."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != "https":
            raise urllib.error.HTTPError(newurl, code, "Refused a redirect away from https", headers, fp)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and target.hostname != urlsplit(req.full_url).hostname:
            new.remove_header("Authorization")
        return new


_opener = urllib.request.build_opener(_SafeRedirects)


@dataclass
class Recording:
    stream: object
    content_type: str
    length: str | None

    def chunks(self):
        try:
            while chunk := self.stream.read(CHUNK):
                yield chunk
        finally:
            self.stream.close()


def fetch(url: str) -> Recording:
    """Open this account's recording as MP3. Raises ``FetchError``; never logs the link or credentials."""
    if not is_configured():
        raise FetchError(503, "not_configured")
    if not own_recording(url):
        raise FetchError(404, "not_found")
    pair = f"{settings.TWILIO_ACCOUNT_SID}:{settings.TWILIO_AUTH_TOKEN}".encode()
    # https only: own_recording() checked the link above.
    request = urllib.request.Request(  # noqa: S310  # nosec B310
        f"{url}.mp3",
        headers={"Authorization": f"Basic {base64.b64encode(pair).decode()}", "Accept": "audio/mpeg"},
    )
    try:
        response = _opener.open(request, timeout=FETCH_TIMEOUT)  # noqa: S310  # nosec B310
    except urllib.error.HTTPError as error:
        error.close()
        if error.code == 404:
            raise FetchError(404, "not_found") from None
        raise FetchError(502, "upstream_unavailable") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise FetchError(502, "upstream_unavailable") from None
    return Recording(response, "audio/mpeg", response.headers.get("Content-Length"))
