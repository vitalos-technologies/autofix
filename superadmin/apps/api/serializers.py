"""Read-only API shapes. Business fields only: no customers, contact details, registrations or bodies."""

from rest_framework import serializers

from apps.autofix.models import Garage, GarageDomain, Job
from apps.autofix.redact import redact


class GarageSerializer(serializers.ModelSerializer):
    plan_name = serializers.CharField(source="plan_label", read_only=True)
    plan_key = serializers.CharField(
        read_only=True, help_text="essentials, pro or trial (D17, old values mapped)"
    )

    class Meta:
        model = Garage
        fields = [
            "id",
            "slug",
            "name",
            "plan",
            "plan_key",
            "plan_name",
            "trial_ends_at",
            "status",
            "timezone",
            "mot_enabled",
            "onboarding_started_at",
            "onboarding_completed_at",
            "cancelled_at",
            "created_at",
        ]


class GarageDomainSerializer(serializers.ModelSerializer):
    garage = serializers.UUIDField(source="garage_id", read_only=True)

    class Meta:
        model = GarageDomain
        fields = ["id", "garage", "hostname", "kind", "status", "last_checked_at", "error", "created_at"]


class JobSerializer(serializers.ModelSerializer):
    garage = serializers.UUIDField(source="garage_id", read_only=True, allow_null=True)
    last_error = serializers.SerializerMethodField()

    class Meta:
        model = Job
        fields = [
            "id",
            "kind",
            "garage",
            "status",
            "attempts",
            "max_attempts",
            "run_at",
            "finished_at",
            "last_error",
            "created_at",
        ]

    def get_last_error(self, job) -> str:
        return redact(job.last_error)


class CountsSerializer(serializers.Serializer):
    tenants = serializers.DictField(child=serializers.IntegerField())
    plans = serializers.DictField(child=serializers.IntegerField())
    subscriptions = serializers.DictField(child=serializers.IntegerField())
