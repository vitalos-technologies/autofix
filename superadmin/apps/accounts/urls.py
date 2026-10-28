from django.urls import path

from . import views

app_name = "accounts"

urlpatterns = [
    path("login/", views.login_view, name="login"),
    path("login/verify/", views.otp_verify, name="otp_verify"),
    path("logout/", views.logout_view, name="logout"),
    path("account/set-password/<uidb64>/<token>/", views.set_password, name="set_password"),
    path("account/", views.account, name="account"),
    path("account/2fa/setup/", views.otp_setup, name="otp_setup"),
    path("settings/", views.settings_index, name="settings"),
    path("settings/users/", views.settings_users, name="settings_users"),
    path("settings/users/new/", views.user_create, name="user_create"),
    path("settings/users/<int:pk>/edit/", views.user_edit, name="user_edit"),
    path("settings/tokens/", views.settings_tokens, name="settings_tokens"),
    path("settings/tokens/<int:pk>/revoke/", views.token_revoke, name="token_revoke"),
]
