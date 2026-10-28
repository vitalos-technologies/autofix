from django.urls import path

from . import views

app_name = "notifications"

urlpatterns = [
    path("", views.notification_list, name="list"),
    path("attention/", views.attention, name="attention"),
    path("badge/", views.badge, name="badge"),
    path("<int:pk>/open/", views.open_notification, name="open"),
    path("read-all/", views.read_all, name="read_all"),
    path("preferences/", views.preferences_view, name="preferences"),
]
