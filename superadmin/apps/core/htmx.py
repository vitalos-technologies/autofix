"""Response helpers for the HTMX modal/panel pattern, with full-page fallbacks."""

import json

from django.contrib import messages
from django.http import HttpResponse, HttpResponseRedirect


def _triggers(close: bool, message: str | None) -> str:
    triggers: dict = {"vsa-changed": True}
    if close:
        triggers["vsa-close-modal"] = True
    if message:
        triggers["vsa-toast"] = {"message": message}
    return json.dumps(triggers)


def close_modal_response(request, fallback_url: str, message: str | None = None):
    """Close the modal and refresh listening panels (HTMX), or redirect (plain form post)."""
    return changed_response(request, fallback_url, message, close=True)


def changed_response(request, fallback_url: str, message: str | None = None, close: bool = False):
    if getattr(request, "htmx", False):
        response = HttpResponse(status=204)
        response["HX-Trigger"] = _triggers(close, message)
        return response
    if message:
        messages.success(request, message)
    return HttpResponseRedirect(fallback_url)
