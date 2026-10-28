import logging
import re
import time
import uuid

from django.db import connection
from django.http import JsonResponse

from .logging import request_id_var

access_logger = logging.getLogger("superadmin.access")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
# One-time set-password links carry a token in the path; never write it to the logs.
_SECRET_PATH_RE = re.compile(r"^(/account/set-password/)[^/]+/[^/]+/?$")


def loggable_path(path: str) -> str:
    return _SECRET_PATH_RE.sub(r"\1[redacted]/", path)


class HealthCheckMiddleware:
    """Answer platform probes before host validation; probes use the container IP as Host."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == "/healthz/":
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
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            response.setdefault("Cache-Control", "private, no-store")
        return response
