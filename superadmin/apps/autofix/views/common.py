"""Shared view helpers for Pitline pages: the unavailable state and UUID parsing."""

import uuid

from django.http import Http404
from django.shortcuts import render

from ..db import AutofixUnavailable

UNAVAILABLE_TEXT = {
    "not_configured": "Pitline data is not connected. Set AUTOFIX_DATABASE_URL (see README).",
    "unavailable": "Pitline data could not be read just now. Try again in a minute; the System health page shows the connection.",
}


def unavailable_message(error: AutofixUnavailable) -> str:
    return UNAVAILABLE_TEXT.get(str(error), UNAVAILABLE_TEXT["unavailable"])


def render_unavailable(request, error: AutofixUnavailable, title: str, status: int = 503):
    return render(
        request,
        "autofix/unavailable.html",
        {"title": title, "message": unavailable_message(error)},
        status=status,
    )


def parse_uuid(value) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise Http404 from None
