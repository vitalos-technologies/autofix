"""Changes to Autofix, and the audited actions around Autofix data. Views call these, never the DB.

Every change goes through a platform SQL function (``db.call_platform_function``), which re-checks
the platform admin, validates the input and writes Autofix's own audit logs. Here we add what the
super admin owns: the role check, a verified second factor, a linked platform admin, a reason, and
our own append-only audit event. Nothing writes to Autofix tables directly, and nothing here touches
bookings (bookings are created only through Autofix's ``create_booking()``).
"""

import re
import uuid
from dataclasses import dataclass

from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError
from django.utils import timezone

from apps.accounts.roles import can_change_autofix, can_handle_enquiries, can_support
from apps.audit.services import record

from . import db
from . import plans as plan_rules
from .models import ENQUIRY_STATUSES, GARAGE_STATUSES, Call, Garage, GarageDomain, Job, PlatformEnquiry
from .redact import clean_reason

REASON_HELP = "Give a reason of 5 to 500 characters. It is logged and shown to the garage's owners."
FRIENDLY_ERRORS = {
    "PLATFORM_ADMIN_REQUIRED": "Autofix did not accept your linked platform admin. Check the link in Settings → Users.",
    "INVALID_REASON": REASON_HELP,
    "GARAGE_NOT_FOUND": "That garage could not be found.",
    "NOTHING_TO_CHANGE": "Choose a different plan or status.",
    "INVALID_PLAN": "Choose a plan.",
    "INVALID_STATUS": "Choose a status.",
    "DOMAIN_NOT_FOUND": "That domain could not be found.",
    "DOMAIN_NOT_CHECKABLE": "Only custom domains waiting for DNS or verification can be re-checked.",
    "NOT_CONFIGURED": "Autofix data is not connected.",
    "ENQUIRY_NOT_FOUND": "That enquiry could not be found.",
    "INVALID_NOTES": "Notes can be up to 5,000 characters.",
}
NOTES_MAX = 5000


@dataclass(frozen=True)
class Outcome:
    ok: bool
    message: str
    detail: dict | None = None


def _require_writer(request, allowed=can_change_autofix) -> uuid.UUID:
    """SuperAdmin (or whoever ``allowed`` admits), verified with TOTP in this session, linked to an
    Autofix platform admin."""
    user = request.user
    if not allowed(user):
        raise PermissionDenied
    is_verified = getattr(user, "is_verified", None)
    if not (is_verified and is_verified()):
        raise PermissionDenied
    if not user.autofix_admin_id:
        raise ValidationError(
            "Your account is not linked to an Autofix platform admin, so Autofix is read-only for you. "
            "A SuperAdmin can link it in Settings → Users."
        )
    return user.autofix_admin_id


def _reason(value) -> str:
    reason = clean_reason(value)
    if reason is None:
        raise ValidationError(REASON_HELP)
    return reason


def _friendly(error: db.PlatformError) -> str:
    return FRIENDLY_ERRORS.get(error.code, "Autofix refused the change. Nothing was changed.")


def _update_garage(garage: Garage, plan: str | None, status: str | None, reason: str, actor):
    """``platform_update_garage`` with the D17 plan name, or its old name if the database predates D17."""
    args = [str(garage.pk), plan, status, reason]
    try:
        return db.call_platform_function("platform_update_garage", args, actor_id=actor)
    except db.PlatformError as error:
        if error.code != "INVALID_PLAN" or plan not in plan_rules.LEGACY:
            raise
    args[1] = plan_rules.LEGACY[plan]
    return db.call_platform_function("platform_update_garage", args, actor_id=actor)


def change_plan_status(request, garage: Garage, *, plan: str | None, status: str, reason) -> Outcome:
    """Plan and/or status through ``platform_update_garage`` (one audit entry per change in Autofix)."""
    actor = _require_writer(request)
    reason = _reason(reason)
    statuses = dict(GARAGE_STATUSES)
    # plan=None keeps the plan as it is (bulk status changes never touch plans or trials).
    if (plan is not None and plan not in plan_rules.LABELS) or status not in statuses:
        raise ValidationError("Choose a plan and a status.")
    new_plan = None if plan is None or plan_rules.same_plan(garage, plan) else plan
    new_status = status if status != garage.status else None
    if new_plan is None and new_status is None:
        raise ValidationError(FRIENDLY_ERRORS["NOTHING_TO_CHANGE"])
    try:
        result = _update_garage(garage, new_plan, new_status, reason, actor)
    except db.PlatformError as error:
        record(
            "autofix.garage_update_refused",
            request=request,
            entity_type="autofix.garage",
            entity_id=str(garage.pk),
            summary=f"{garage.name}: refused ({error.code})",
            code=error.code,
        )
        return Outcome(False, _friendly(error))
    changes = []
    if new_plan:
        changes.append(f"plan {garage.plan_label} → {plan_rules.LABELS[new_plan]}")
    if new_status:
        changes.append(f"status {statuses[garage.status]} → {statuses[new_status]}")
    record(
        "autofix.garage_updated",
        request=request,
        entity_type="autofix.garage",
        entity_id=str(garage.pk),
        summary=f"{garage.name}: {', '.join(changes)}",
        reason=reason,
        plan=new_plan,
        status=new_status,
        autofix_admin=str(actor),
    )
    return Outcome(True, f"Saved: {', '.join(changes)}. The change is in the garage's audit log.", result)


def retry_job(request, job: Job, reason) -> Outcome:
    actor = _require_writer(request)
    reason = _reason(reason)
    if job.status != "failed":
        return Outcome(False, "Only failed jobs can be retried. It may have been retried already.")
    try:
        retried = db.call_platform_function("platform_retry_job", [str(job.pk), reason], actor_id=actor)
    except db.PlatformError as error:
        return Outcome(False, _friendly(error))
    if not retried:
        return Outcome(False, "Only failed jobs can be retried. It may have been retried already.")
    record(
        "autofix.job_retried",
        request=request,
        entity_type="autofix.job",
        entity_id=str(job.pk),
        summary=f"{job.kind} queued again",
        reason=reason,
        kind=job.kind,
        autofix_admin=str(actor),
    )
    return Outcome(True, "Queued again with fresh attempts.")


def request_domain_check(request, domain: GarageDomain, reason) -> Outcome:
    actor = _require_writer(request)
    reason = _reason(reason)
    if not domain.checkable:
        return Outcome(False, FRIENDLY_ERRORS["DOMAIN_NOT_CHECKABLE"])
    try:
        result = db.call_platform_function(
            "platform_request_domains_check", [str(domain.pk), reason], actor_id=actor
        )
    except db.PlatformError as error:
        return Outcome(False, _friendly(error))
    record(
        "autofix.domain_check_requested",
        request=request,
        entity_type="autofix.garage_domain",
        entity_id=str(domain.pk),
        summary=f"{domain.hostname} ({domain.garage.name})",
        reason=reason,
        autofix_admin=str(actor),
    )
    return Outcome(True, "Re-check queued. Autofix checks the domain within 5 minutes.", result)


def view_as_support(request, garage: Garage, reason) -> str:
    """The audited hand-off to Autofix's own read-only impersonation. Returns where to go.

    The session itself starts in Autofix (/admin/garages/<id>), under the admin's own Autofix sign-in
    and MFA, where Autofix records it again. Nothing is passed but the garage's id: no token, no
    session, no personal data (ADR-044 "Open" pattern).
    """
    if not can_support(request.user):
        raise PermissionDenied
    reason = _reason(reason)
    destination = f"{settings.AUTOFIX_APP_URL}/admin/garages/{garage.pk}"
    record(
        "autofix.view_as_support",
        request=request,
        entity_type="autofix.garage",
        entity_id=str(garage.pk),
        summary=f"{garage.name}",
        reason=reason,
        destination=destination,
    )
    return destination


def record_personal_data_view(request, garage: Garage, what: str, rows: int) -> None:
    if not can_support(request.user):
        raise PermissionDenied
    record(
        "autofix.personal_data_viewed",
        request=request,
        entity_type="autofix.garage",
        entity_id=str(garage.pk),
        summary=f"{garage.name}: {what} ({rows} rows)",
        what=what,
        rows=rows,
    )


def record_voicemail_played(request, call: Call) -> None:
    """One audit event per playback. Names the garage and the call, never the caller."""
    if not can_support(request.user):
        raise PermissionDenied
    record(
        "autofix.voicemail_played",
        request=request,
        entity_type="autofix.call",
        entity_id=str(call.pk),
        summary=f"{call.line_name}: voicemail from {timezone.localtime(call.created_at):%d %b %Y %H:%M}",
        line="platform" if call.is_platform else str(call.garage_id),
        seconds=call.voicemail_duration_s,
    )


# --- Enquiries (contact page) ------------------------------------------------------------------

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _enquiry_ref(enquiry: PlatformEnquiry) -> str:
    """How our audit trail names an enquiry: short id and topic, never the sender's details."""
    return f"Enquiry {str(enquiry.pk)[:8]} ({enquiry.get_topic_display()})"


def clean_notes(value) -> str:
    """Line endings normalised, control characters (bar tab and newline) dropped, trimmed."""
    if not isinstance(value, str):
        return ""
    return _CONTROL.sub("", value.replace("\r\n", "\n").replace("\r", "\n")).strip()


def update_enquiry(request, enquiry: PlatformEnquiry, *, status: str, notes) -> Outcome:
    """Status and/or internal notes through ``platform_update_enquiry`` (one Autofix audit row per change).

    SuperAdmin and Support, with a verified second factor and a linked Autofix platform admin. Our own
    audit event records what changed, never the notes' text.
    """
    actor = _require_writer(request, can_handle_enquiries)
    statuses = dict(ENQUIRY_STATUSES)
    if status not in statuses:
        raise ValidationError("Choose a status.")
    cleaned = clean_notes(notes)
    if len(cleaned) > NOTES_MAX:
        raise ValidationError(FRIENDLY_ERRORS["INVALID_NOTES"])
    new_status = status if status != enquiry.status else None
    notes_changed = cleaned != (enquiry.notes or "")
    if new_status is None and not notes_changed:
        raise ValidationError("Change the status or the notes first.")
    try:
        result = db.call_platform_function(
            "platform_update_enquiry",
            [str(enquiry.pk), new_status, cleaned if notes_changed else None],
            actor_id=actor,
        )
    except db.PlatformError as error:
        record(
            "autofix.enquiry_update_refused",
            request=request,
            entity_type="autofix.platform_enquiry",
            entity_id=str(enquiry.pk),
            summary=f"{_enquiry_ref(enquiry)}: refused ({error.code})",
            code=error.code,
        )
        return Outcome(False, _friendly(error))
    changes = []
    if new_status:
        changes.append(f"status {statuses[enquiry.status]} → {statuses[new_status]}")
    if notes_changed:
        changes.append("notes cleared" if not cleaned else "notes updated")
    record(
        "autofix.enquiry_updated",
        request=request,
        entity_type="autofix.platform_enquiry",
        entity_id=str(enquiry.pk),
        summary=f"{_enquiry_ref(enquiry)}: {', '.join(changes)}",
        status=new_status,
        notes_changed=notes_changed,
        notes_length=len(cleaned),
        autofix_admin=str(actor),
    )
    return Outcome(True, f"Saved: {', '.join(changes)}.", result)


def record_enquiry_view(request, enquiry: PlatformEnquiry) -> None:
    """Each opening of an enquiry (the sender's contact details) is audited."""
    if not can_handle_enquiries(request.user):
        raise PermissionDenied
    record(
        "autofix.enquiry_viewed",
        request=request,
        entity_type="autofix.platform_enquiry",
        entity_id=str(enquiry.pk),
        summary=_enquiry_ref(enquiry),
    )
