"""Create and read in-app notifications. This app sends no email."""

from collections.abc import Iterable

from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import Notification, NotificationPreference


def visible_notifications(user):
    return Notification.objects.filter(recipient=user)


def preferences(user) -> NotificationPreference:
    found = NotificationPreference.objects.filter(user=user).first()
    return found or NotificationPreference(user=user)


def notify(
    recipients: Iterable,
    kind: str,
    title: str,
    body: str = "",
    url: str = "",
    exclude=None,
    dedupe_key: str = "",
) -> int:
    """Create one notification per distinct active recipient who wants ``kind``; returns how many.

    With ``dedupe_key``, a recipient who already has that alert is skipped (so a scan can run often).
    """
    created = 0
    seen: set[int] = set()
    for user in recipients:
        if user is None or not user.is_active or user.pk in seen:
            continue
        if exclude is not None and user.pk == exclude.pk:
            continue
        seen.add(user.pk)
        if not preferences(user).wants(kind):
            continue
        if dedupe_key and Notification.objects.filter(recipient=user, dedupe_key=dedupe_key).exists():
            continue
        try:
            with transaction.atomic():
                Notification.objects.create(
                    recipient=user,
                    kind=kind,
                    title=title[:200],
                    body=body,
                    url=url[:500],
                    dedupe_key=dedupe_key[:120],
                )
        except IntegrityError:  # a concurrent scan created it first
            continue
        created += 1
    return created


def unread_count(user, kind: str = "") -> int:
    if not user.is_authenticated:
        return 0
    unread = visible_notifications(user).filter(read_at__isnull=True)
    return (unread.filter(kind=kind) if kind else unread).count()


def voicemail_key(call_id) -> str:
    """The dedupe key of a call's "new voicemail" alert (one per voicemail per person)."""
    return f"voicemail:{call_id}"


def mark_voicemail_read(user, call_id) -> int:
    """Playing a voicemail reads its alert, so the Calls count only shows voicemails nobody here played."""
    return Notification.objects.filter(
        recipient=user, dedupe_key=voicemail_key(call_id), read_at__isnull=True
    ).update(read_at=timezone.now())


def mark_read(user, notification_id: int) -> Notification | None:
    notification = Notification.objects.filter(recipient=user, pk=notification_id).first()
    if notification and notification.read_at is None:
        notification.read_at = timezone.now()
        notification.save(update_fields=["read_at"])
    return notification


def mark_all_read(user) -> int:
    return Notification.objects.filter(recipient=user, read_at__isnull=True).update(read_at=timezone.now())
