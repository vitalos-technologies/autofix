"""Masking for free text that leaves Pitline (job errors): ported from ``src/lib/platform/policy.ts``.

Emails, phone numbers and anything shaped like a UK registration are masked (registration privacy),
ids are kept, and the result is at most 300 characters. Job payloads are never read at all.
"""

import re

EMAIL = re.compile(r"[^\s@<>()\"',;:]+@[^\s@<>()\"',;:]+\.[a-z]{2,}", re.IGNORECASE)
PHONE = re.compile(r"(?:\+|\b0)(?:[\s().-]?\d){9,14}\b")
# Current, prefix and suffix UK formats, any case, spaces optional.
REGISTRATION = re.compile(
    r"\b(?:[A-Z]{2}\d{2}\s?[A-Z]{3}|[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z])\b", re.IGNORECASE
)
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
MAX_LENGTH = 300


def redact(value: str | None) -> str:
    if not value:
        return ""
    ids: list[str] = []

    def keep(match: re.Match) -> str:
        ids.append(match.group(0))
        return f"\x00{len(ids) - 1}\x00"

    masked = UUID.sub(keep, value)
    masked = EMAIL.sub("[email]", masked)
    masked = PHONE.sub("[phone]", masked)
    masked = REGISTRATION.sub("[reg]", masked)
    masked = re.sub(r"\x00(\d+)\x00", lambda match: ids[int(match.group(1))], masked)
    return masked if len(masked) <= MAX_LENGTH else masked[: MAX_LENGTH - 1] + "…"


def clean_reason(value) -> str | None:
    """Whitespace collapsed; None unless 5 to 500 characters remain (the database checks it too)."""
    if not isinstance(value, str):
        return None
    cleaned = " ".join(re.sub(r"[\x00-\x1f\x7f]+", " ", value).split())
    return cleaned if 5 <= len(cleaned) <= 500 else None
