"""Step-up: a fresh authenticator code with every sensitive action (DECISIONS D18, A412).

The super admin is served under ``autofix.vitalos.co.uk/superadmin``, the same origin as the Autofix
app. A signed-in session alone is therefore not enough for anything that changes Autofix or shows
personal data: each such request also carries a new TOTP code. Script running on the origin cannot
produce one, and django-otp refuses a code it has already accepted (``last_t``) and throttles failures.

On with ``AUTOFIX_STEP_UP`` (production default). Codes are checked last, only once the rest of the
form is valid, so a typo in the reason does not burn a code.
"""

from django import forms
from django.conf import settings
from django.core.exceptions import ValidationError

from . import otp

FIELD = "step_up_code"
HELP = "A new 6-digit code from your authenticator app. Each code works once."
INVALID = "That authenticator code was not accepted. Wait for a new code and try again."


def enabled() -> bool:
    return bool(getattr(settings, "AUTOFIX_STEP_UP", False))


def check(user, code) -> bool:
    """True when step-up is off, or ``code`` is a fresh code from one of ``user``'s devices."""
    if not enabled():
        return True
    if user is None or not user.is_authenticated:
        return False
    return otp.verify(user, str(code or "")) is not None


def code_field() -> forms.CharField:
    return forms.CharField(
        label="Authenticator code",
        min_length=6,
        max_length=7,
        help_text=HELP,
        widget=forms.TextInput(
            attrs={"autocomplete": "one-time-code", "inputmode": "numeric", "pattern": "[0-9 ]{6,7}"}
        ),
    )


class StepUpMixin:
    """Adds the code field when step-up is on and checks it against ``user``.

    List it after ``StyledFormMixin`` so the added field is styled too.
    """

    def __init__(self, *args, user=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.step_up_user = user
        if enabled():
            self.fields[FIELD] = code_field()

    def clean(self):
        cleaned = super().clean()
        if enabled() and not self.errors:
            if not check(self.step_up_user, cleaned.get(FIELD)):
                raise ValidationError({FIELD: INVALID})
        cleaned.pop(FIELD, None)
        return cleaned
