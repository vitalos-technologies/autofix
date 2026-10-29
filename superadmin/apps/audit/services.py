"""Write audit events. Every caller goes through ``record`` so the shape stays consistent."""

import logging

from apps.core.http import client_ip

from .models import AuditEvent

logger = logging.getLogger(__name__)

# Action names: "<area>.<verb>". Listed here so the Activity filter and tests share one vocabulary.
ACTIONS = {
    "auth.sign_in": "Signed in",
    "auth.sign_in_failed": "Failed sign-in",
    "auth.sign_out": "Signed out",
    "auth.mfa_enrolled": "Enrolled an authenticator",
    "auth.mfa_reset": "Removed their authenticator",
    "auth.password_changed": "Changed their password",
    "auth.password_set": "Set a password from a one-time link",
    "auth.setup_link_issued": "Issued a one-time set-password link",
    "users.created": "Created a user",
    "users.role_changed": "Changed a role",
    "users.activated": "Reactivated a user",
    "users.deactivated": "Deactivated a user",
    "users.owner_set": "Set the primary owner",
    "users.autofix_link_changed": "Changed a user's Autofix platform admin link",
    "audit.exported": "Exported the audit trail",
    "audit.autofix_exported": "Exported the Autofix platform log",
    # Autofix. Summaries name garages and ids, never customers, registrations or contact details.
    "autofix.garage_updated": "Changed a garage's plan or status",
    "autofix.garage_update_refused": "Tried to change a garage (refused by Autofix)",
    "autofix.garages_exported": "Exported garages",
    "autofix.job_retried": "Retried a failed job",
    "autofix.domain_check_requested": "Asked Autofix to re-check a domain",
    "autofix.view_as_support": "Handed off to View as support",
    "autofix.personal_data_viewed": "Viewed customer details on a garage's bookings",
    "autofix.voicemail_played": "Played a garage's voicemail",
}


def record(
    action, *, request=None, actor=None, entity=None, entity_type="", entity_id="", summary="", **metadata
):
    """Append one event. Never raises into the caller: a failed audit write is logged loudly."""
    if actor is None and request is not None and getattr(request, "user", None) is not None:
        actor = request.user if request.user.is_authenticated else None
    if entity is not None:
        entity_type = entity_type or entity._meta.label_lower
        entity_id = entity_id or str(entity.pk)
    ip = client_ip(request) if request is not None else None
    agent = (request.headers.get("User-Agent", "") if request is not None else "")[:300]
    try:
        return AuditEvent.objects.create(
            actor=actor,
            actor_email=getattr(actor, "email", ""),
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            summary=summary[:300],
            metadata=metadata,
            ip=ip or None,
            user_agent=agent,
        )
    except Exception:  # noqa: BLE001 - auditing must not break the action, but must be visible
        logger.exception("Audit write failed", extra={"action": action})
        return None


def previous_sign_in(user):
    """The sign-in before the current one (shown in the user menu), or None."""
    events = AuditEvent.objects.filter(actor=user, action="auth.sign_in").only("created_at", "ip")[:2]
    events = list(events)
    return events[1] if len(events) > 1 else None
