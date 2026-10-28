from django.contrib.auth.signals import user_logged_in, user_logged_out, user_login_failed
from django.dispatch import receiver

from .services import record


@receiver(user_logged_in)
def on_sign_in(sender, request, user, **kwargs):
    record("auth.sign_in", request=request, actor=user, entity=user, summary="Signed in")


@receiver(user_logged_out)
def on_sign_out(sender, request, user, **kwargs):
    if user is not None:
        record("auth.sign_out", request=request, actor=user, entity=user, summary="Signed out")


@receiver(user_login_failed)
def on_sign_in_failed(sender, credentials, request=None, **kwargs):
    # The attempted email is kept for investigation; the password never reaches this signal.
    attempted = str((credentials or {}).get("email") or (credentials or {}).get("username") or "")[:254]
    record("auth.sign_in_failed", request=request, summary="Failed sign-in", attempted_email=attempted)
