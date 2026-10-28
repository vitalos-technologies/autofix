from urllib.parse import urlencode

from django.http import HttpResponse, HttpResponseRedirect
from django.urls import reverse

from .otp import confirmed_devices, otp_required

EXEMPT_PREFIXES = ("/login/", "/logout/", "/account/2fa/", "/static/", "/healthz/")


class OTPEnforcementMiddleware:
    """Send authenticated users who still owe a second factor to verification or enrolment."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = request.user
        if (
            user.is_authenticated
            and not request.path.startswith(EXEMPT_PREFIXES)
            and not user.is_verified()
            and otp_required(user)
        ):
            name = "accounts:otp_verify" if confirmed_devices(user).exists() else "accounts:otp_setup"
            target = f"{reverse(name)}?{urlencode({'next': request.get_full_path()})}"
            if request.headers.get("HX-Request") == "true":
                response = HttpResponse(status=204)
                response["HX-Redirect"] = target
                return response
            return HttpResponseRedirect(target)
        return self.get_response(request)
