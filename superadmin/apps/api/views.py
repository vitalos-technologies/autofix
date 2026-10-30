from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import viewsets
from rest_framework.decorators import api_view
from rest_framework.exceptions import APIException
from rest_framework.response import Response

from apps.autofix import plans, selectors
from apps.autofix.db import AutofixUnavailable, reads
from apps.autofix.models import Garage, GarageDomain, Job

from . import serializers


class Unavailable(APIException):
    status_code = 503
    default_detail = "Pitline data could not be read."
    default_code = "autofix_unavailable"


class AutofixViewSet(viewsets.ReadOnlyModelViewSet):
    """Read-only listing over the ``autofix`` alias. Database failures answer 503."""

    filters: tuple[str, ...] = ()

    def get_queryset(self):
        queryset = self.queryset.model.objects.all()
        for name in self.filters:
            value = self.request.query_params.get(name)
            if value:
                queryset = queryset.filter(**{name: value})
        return queryset.order_by(*self.ordering)

    def list(self, request, *args, **kwargs):
        try:
            return reads(super().list)(request, *args, **kwargs)
        except AutofixUnavailable as exc:
            raise Unavailable from exc

    def retrieve(self, request, *args, **kwargs):
        try:
            return reads(super().retrieve)(request, *args, **kwargs)
        except AutofixUnavailable as exc:
            raise Unavailable from exc


def _filter_params(*names):
    return [OpenApiParameter(name, str, description=f"Filter by {name}.") for name in names]


@extend_schema_view(
    list=extend_schema(parameters=_filter_params("plan (essentials, pro or trial)", "status"))
)
class GarageViewSet(AutofixViewSet):
    queryset = Garage.objects.all()
    serializer_class = serializers.GarageSerializer
    ordering = ("name", "id")
    filters = ("status",)

    def get_queryset(self):
        queryset = super().get_queryset()
        plan_q = plans.filter_q(self.request.query_params.get("plan", ""))
        return queryset.filter(plan_q) if plan_q is not None else queryset


@extend_schema_view(list=extend_schema(parameters=_filter_params("status", "kind")))
class GarageDomainViewSet(AutofixViewSet):
    queryset = GarageDomain.objects.all()
    serializer_class = serializers.GarageDomainSerializer
    ordering = ("hostname", "id")
    filters = ("status", "kind")

    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


@extend_schema_view(list=extend_schema(parameters=_filter_params("status", "kind")))
class JobViewSet(AutofixViewSet):
    queryset = Job.objects.all()
    serializer_class = serializers.JobSerializer
    ordering = ("-created_at", "id")
    filters = ("status", "kind")


@extend_schema(responses=serializers.CountsSerializer)
@api_view(["GET"])
def counts(request):
    """Garage counts by status, plans of garages not cancelled, and subscription states (ADR-044)."""
    try:
        data = {
            "tenants": selectors.garage_counts(),
            "plans": selectors.plan_counts(),
            "subscriptions": selectors.subscription_counts(),
        }
    except AutofixUnavailable as exc:
        raise Unavailable from exc
    return Response(data)
