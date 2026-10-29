"""Autofix test rows. The ORM refuses to write Autofix models, so rows go in with plain INSERTs."""

import uuid
from datetime import timedelta

from django.db import connections
from django.utils import timezone

from apps.autofix import models as m

# The Twilio account the tests configure (settings.TWILIO_ACCOUNT_SID in test_calls.py).
TWILIO_ACCOUNT = "AC" + "0" * 31 + "1"

DEFAULTS = {
    m.Garage: lambda f: {
        "slug": f"garage-{uuid.uuid4().hex[:6]}",
        "name": "Test Garage",
        "plan": "trial",
        "status": "active",
        "timezone": "Europe/London",
        "mot_enabled": False,
        "accent": "#155fba",
        "booking_prefix": "TG",
        "updated_at": f.now,
    },
    m.GarageMember: lambda f: {"user_id": uuid.uuid4(), "role": "owner", "display_name": "Owner"},
    m.GarageInvite: lambda f: {
        "role": "manager",
        "email_masked": "m•••@example.test",
        "expires_at": f.now + timedelta(days=7),
        "sent_count": 1,
    },
    m.PlatformAdmin: lambda f: {"display_name": "Platform Admin", "email": "pa@vitalos.example"},
    m.Customer: lambda f: {
        "name": "Olivia Bennett",
        "phone_masked": "•••101",
        "email_masked": "o•••@example.test",
        "preferred_contact": "phone",
        "channel": "sms",
        "reminder_consent": True,
    },
    m.Vehicle: lambda f: {"registration_masked": "AB•••", "make": "Ford", "model": "Fiesta"},
    m.Service: lambda f: {
        "name": "Full service",
        "duration_min": 90,
        "online_enabled": True,
        "is_mot": False,
    },
    m.Resource: lambda f: {"name": "Bay 1", "kind": "bay", "active": True},
    m.Booking: lambda f: {
        "reference": f"TG-{uuid.uuid4().hex[:6].upper()}",
        "starts_at": f.now + timedelta(days=1),
        "ends_at": f.now + timedelta(days=1, hours=1),
        "status": "confirmed",
        "source": "online",
        "location_mode": "workshop",
    },
    m.GarageDomain: lambda f: {
        "hostname": f"book.{uuid.uuid4().hex[:6]}.example",
        "kind": "custom",
        "status": "active",
        "updated_at": f.now,
    },
    m.Job: lambda f: {
        "kind": "reminders.send",
        "status": "queued",
        "attempts": 0,
        "max_attempts": 5,
        "run_at": f.now,
        "updated_at": f.now,
    },
    m.ReminderSend: lambda f: {
        "kind": "mot",
        "channel": "sms",
        "status": "scheduled",
        "send_at": f.now,
        "updated_at": f.now,
    },
    m.Message: lambda f: {
        "channel": "sms",
        "direction": "outbound",
        "provider": "twilio",
        "status": "delivered",
        "updated_at": f.now,
    },
    m.Call: lambda f: {"status": "completed", "missed": False, "has_voicemail": False},
    m.CallVoicemail: lambda f: {
        "voicemail_url": f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT}/Recordings/RE{uuid.uuid4().hex}"
    },
    m.GarageAgreement: lambda f: {
        "kind": "dpa",
        "version": "2026-10",
        "text_hash": "a" * 64,
        "accepted_by_name": "Owner",
        "accepted_by_role": "owner",
        "accepted_at": f.now,
    },
    m.PlatformAuditEntry: lambda f: {
        "actor_name": "Platform Admin",
        "action": "platform.garage_status_changed",
        "entity_type": "garage",
        "entity_id": "x",
        "detail": {"from": "active", "to": "suspended"},
    },
    m.PlatformImpersonation: lambda f: {
        "admin_user_id": uuid.uuid4(),
        "admin_name": "Platform Admin",
        "reason": "Customer asked for help",
        "started_at": f.now,
        "expires_at": f.now + timedelta(minutes=30),
    },
}


class AutofixFactory:
    def __init__(self):
        self.now = timezone.now()
        self._audit_id = 0

    def make(self, model, **values):
        row = DEFAULTS[model](self)
        row.update(values)
        pk = model._meta.pk
        if pk.attname not in row:
            if isinstance(pk, type(m.Garage._meta.pk)):
                row[pk.attname] = uuid.uuid4()
            else:
                self._audit_id += 1
                row[pk.attname] = self._audit_id
        if "created_at" not in row and any(f.attname == "created_at" for f in model._meta.concrete_fields):
            row["created_at"] = self.now
        connection = connections["autofix"]
        fields = []
        for field in model._meta.concrete_fields:
            key = field.attname
            if key in row:
                fields.append((field, row[key]))
            elif key.endswith("_id") and key[:-3] in row:
                related = row[key[:-3]]
                fields.append((field, related.pk if related is not None else None))
        columns = ", ".join(connection.ops.quote_name(field.column) for field, _ in fields)
        placeholders = ", ".join(["%s"] * len(fields))
        params = [field.get_db_prep_save(value, connection) for field, value in fields]
        sql = f"INSERT INTO {connection.ops.quote_name(model._meta.db_table)} ({columns}) VALUES ({placeholders})"
        with connection.cursor() as cursor:
            cursor.execute(sql, params)
        return model.objects.get(pk=row[pk.attname])

    def garage(self, **values):
        return self.make(m.Garage, **values)

    def call(self, garage, voicemail_s=None, voicemail_url=None, **values):
        """A call; with ``voicemail_s`` it has a voicemail and its recording link (as the views show it)."""
        if voicemail_s is not None:
            values.update(
                has_voicemail=True, voicemail_duration_s=voicemail_s, missed=values.get("missed", True)
            )
        call = self.make(m.Call, garage=garage, **values)
        if voicemail_s is not None:
            link = {"voicemail_url": voicemail_url} if voicemail_url else {}
            self.make(m.CallVoicemail, id=call.pk, garage=garage, **link)
        return call

    def scenario(self):
        now = self.now
        hartley = self.garage(name="Hartley Road Motors", slug="hartley-road", plan="growth", status="active")
        demo = self.garage(
            name="Demo Garage B",
            slug="demo-b",
            plan="trial",
            status="onboarding",
            created_at=now - timedelta(hours=72),
        )
        owner = self.make(m.GarageMember, garage=hartley, display_name="Sam Owner")
        self.make(m.GarageMember, garage=hartley, role="manager", display_name="Mia Manager")
        self.make(m.GarageInvite, garage=hartley)
        customer = self.make(m.Customer, garage=hartley)
        vehicle = self.make(m.Vehicle, garage=hartley, customer=customer)
        service = self.make(m.Service, garage=hartley)
        resource = self.make(m.Resource, garage=hartley)
        send = self.make(
            m.ReminderSend,
            garage=hartley,
            status="delivered",
            sent_at=now.replace(hour=10, minute=0) if now.weekday() < 6 else now,
        )
        booking = self.make(
            m.Booking,
            garage=hartley,
            customer=customer,
            vehicle=vehicle,
            service=service,
            resource=resource,
            reminder_send_id=send.pk,
        )
        self.make(
            m.Booking,
            garage=hartley,
            customer=customer,
            vehicle=vehicle,
            service=service,
            resource=resource,
            created_at=now - timedelta(days=10),
            status="collected",
        )
        self.make(
            m.GarageDomain, garage=hartley, hostname="hartley-road.autofix.vitalos.co.uk", kind="subdomain"
        )
        pending = self.make(
            m.GarageDomain, garage=hartley, hostname="book.hartleyroad.example", status="verifying"
        )
        failed = self.make(
            m.GarageDomain,
            garage=demo,
            hostname="book.demob.example",
            status="failed",
            error="CNAME not found",
        )
        failed_job = self.make(
            m.Job,
            kind="reminders.send",
            garage=hartley,
            status="failed",
            attempts=5,
            finished_at=now - timedelta(minutes=5),
            last_error="Twilio refused +447700900123 for AB12 CDE (owner@example.test)",
        )
        self.make(m.Message, garage=hartley, status="delivered")
        self.make(m.Message, garage=hartley, status="failed", error_code="30003")
        self.make(m.Call, garage=hartley, missed=True)
        self.make(m.GarageAgreement, garage=hartley)
        self.make(
            m.PlatformAuditEntry, target_garage=hartley, entity_id=str(hartley.pk), reason="Unpaid invoice"
        )
        self.make(m.PlatformImpersonation, garage=hartley)
        admin = self.make(m.PlatformAdmin, user_id=uuid.UUID("5a000000-0000-4000-8000-0000000000a1"))
        return {
            "hartley": hartley,
            "demo": demo,
            "owner": owner,
            "customer": customer,
            "booking": booking,
            "pending_domain": pending,
            "failed_domain": failed,
            "failed_job": failed_job,
            "admin": admin,
        }
