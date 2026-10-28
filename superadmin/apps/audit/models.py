"""Append-only security and operations audit trail (who, what, when, from where).

Autofix keeps its own platform_audit_log (read on the Audit page). This table records what Vitalos
staff did here: sign-ins, roles, two-factor, hand-offs, personal-data views and Autofix changes.
Rows are never updated or deleted by the application.
"""

from django.conf import settings
from django.db import models
from django.utils import timezone


class AppendOnlyError(Exception):
    pass


class AuditEventQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise AppendOnlyError("Audit events are append-only.")

    def delete(self):
        raise AppendOnlyError("Audit events are append-only.")


class AuditEvent(models.Model):
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    # Kept even if the user row is later anonymised, so the trail stays readable.
    actor_email = models.EmailField(blank=True)
    action = models.CharField(max_length=64, db_index=True)
    entity_type = models.CharField(max_length=64, blank=True)
    entity_id = models.CharField(max_length=64, blank=True)
    summary = models.CharField(max_length=300, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    objects = AuditEventQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["entity_type", "entity_id"]),
            models.Index(fields=["actor", "-created_at"]),
        ]

    def __str__(self):
        return f"{self.created_at:%Y-%m-%d %H:%M} {self.actor_email or 'system'} {self.action}"

    def save(self, *args, **kwargs):
        if self.pk is not None:
            raise AppendOnlyError("Audit events are append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("Audit events are append-only.")
