import hmac
import ipaddress
import logging
import re
import time
import uuid

from django.conf import settings
from django.db import connection
from django.http import HttpResponseNotFound, JsonResponse

from .logging import request_id_var

access_logger = logging.getLogger("superadmin.access")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
# One-time set-password links carry a token in the path; never write it to the logs.
_SECRET_PATH_RE = re.compile(r"^((?:/[a-z0-9-]+)?/account/set-password/)[^/]+/[^/]+/?$")
HEALTH_PATH = "/healthz/"
# Headers only the Autofix proxy (src/proxy.ts) may set. It strips any copies a browser sends.
# A header name, not a secret.
PROXY_SECRET_META = "HTTP_X_AUTOFIX_SUPERADMIN_PROXY"  # noqa: S105  # nosec B105
PROXY_CLIENT_IP_META = "HTTP_X_AUTOFIX_SUPERADMIN_CLIENT_IP"
PROXY_HOST_META = "HTTP_X_AUTOFIX_SUPERADMIN_HOST"
_HOST_RE = re.compile(r"^[a-z0-9.-]+(:[0-9]{1,5})?$")


def loggable_path(path: str) -> str:
    return _SECRET_PATH_RE.sub(r"\1[redacted]/", path)


class ProxyGateMiddleware:
    """Path mode: answer only requests that came through the Autofix proxy.

    With ``SUPERADMIN_PROXY_SECRET`` set, a request must carry it in ``X-Autofix-Superadmin-Proxy``
    (compared in constant time) or it gets a bare 404 that says nothing about the app. Platform
    probes to /healthz/ are the one exception. Behind the gate, and only there, the proxy's own
    headers are trusted for the client IP (sign-in lockouts, audit) and the public host (CSRF origin
    checks, absolute URLs). The secret is removed from the request before anything can log it.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        secret = getattr(settings, "SUPERADMIN_PROXY_SECRET", "")
        supplied = request.META.pop(PROXY_SECRET_META, "")
        client = request.META.pop(PROXY_CLIENT_IP_META, "")
        host = request.META.pop(PROXY_HOST_META, "")
        request.proxied_client_ip = ""
        if not secret:
            return self.get_response(request)
        if not hmac.compare_digest(supplied.encode(), secret.encode()):
            if request.path_info == HEALTH_PATH:
                return self.get_response(request)
            logging.getLogger(__name__).warning("proxy_gate_refused")
            return HttpResponseNotFound(b"Not found", content_type="text/plain")
        try:
            request.proxied_client_ip = str(ipaddress.ip_address(client.strip()))
        except ValueError:
            request.proxied_client_ip = ""
        host = host.strip().lower()
        if host and _HOST_RE.match(host):
            request.META["HTTP_HOST"] = host
            request.META.pop("HTTP_X_FORWARDED_HOST", None)
        return self.get_response(request)


class HealthCheckMiddleware:
    """Answer platform probes before host validation; probes use the container IP as Host."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path_info == HEALTH_PATH:
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
                return JsonResponse({"status": "ok"})
            except Exception:  # noqa: BLE001 - any database failure means unhealthy
                logging.getLogger(__name__).exception("Health check failed")
                return JsonResponse({"status": "unavailable"}, status=503)
        return self.get_response(request)


class RequestIDMiddleware:
    """Attach a request ID to logs and responses, and emit one structured access log line."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-ID", "")
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex
        request.request_id = request_id
        token = request_id_var.set(request_id)
        started = time.monotonic()
        try:
            response = self.get_response(request)
            response["X-Request-ID"] = request_id
            user = getattr(request, "user", None)
            access_logger.info(
                "request",
                extra={
                    "method": request.method,
                    "path": loggable_path(request.path),
                    "status": response.status_code,
                    "duration_ms": round((time.monotonic() - started) * 1000, 1),
                    "user_id": user.pk if user is not None and user.is_authenticated else None,
                    "htmx": request.headers.get("HX-Request") == "true",
                },
            )
            return response
        finally:
            request_id_var.reset(token)


class SecurityHeadersMiddleware:
    """Headers Django does not set itself."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        )
        response.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        response.setdefault("X-Robots-Tag", "noindex, nofollow")
        # Nothing here may sit in a shared cache (the proxy's CDN included), signed in or not.
        response.setdefault("Cache-Control", "private, no-store")
        return response
