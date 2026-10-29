from django.urls import path

from .views import calls, enquiries, garages, operations

app_name = "autofix"

urlpatterns = [
    path("garages/", garages.garage_list, name="garages"),
    path("garages/export.csv", garages.garage_export, name="garages_export"),
    path("garages/bulk/", garages.garage_bulk, name="garages_bulk"),
    path("garages/<str:pk>/", garages.garage_detail, name="garage"),
    path("garages/<str:pk>/tab/<slug:tab>/", garages.garage_tab, name="garage_tab"),
    path("garages/<str:pk>/plan/", garages.garage_plan, name="garage_plan"),
    path("garages/<str:pk>/view-as-support/", garages.view_as_support, name="view_as_support"),
    path("garages/<str:pk>/bookings/people/", garages.booking_people, name="booking_people"),
    path("calls/", calls.calls, name="calls"),
    path("calls/<str:pk>/voicemail/", calls.voicemail_player, name="voicemail"),
    path("calls/<str:pk>/voicemail.mp3", calls.voicemail_audio, name="voicemail_audio"),
    path("enquiries/", enquiries.enquiry_list, name="enquiries"),
    path("enquiries/<str:pk>/", enquiries.enquiry_detail, name="enquiry"),
    path("enquiries/<str:pk>/update/", enquiries.enquiry_update, name="enquiry_update"),
    path("jobs/", operations.jobs, name="jobs"),
    path("jobs/<str:pk>/retry/", operations.job_retry, name="job_retry"),
    path("messaging/", operations.messaging, name="messaging"),
    path("domains/", operations.domains, name="domains"),
    path("domains/<str:pk>/recheck/", operations.domain_recheck, name="domain_recheck"),
    path("signups/", operations.signups, name="signups"),
    path("activity/", operations.activity, name="activity"),
    path("team/", operations.team, name="team"),
    path("audit/autofix/", operations.platform_audit, name="platform_audit"),
    path("audit/autofix/export.csv", operations.platform_audit_export, name="platform_audit_export"),
]
