"""One-time set-password tokens: valid for 30 minutes and only until the password changes."""

from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.utils.http import base36_to_int

SET_PASSWORD_TIMEOUT_SECONDS = 30 * 60


class SetPasswordTokenGenerator(PasswordResetTokenGenerator):
    # A distinct salt, so these tokens cannot be confused with any other Django token.
    key_salt = "autofix.superadmin.SetPasswordTokenGenerator"

    def check_token(self, user, token):
        if not super().check_token(user, token):
            return False
        try:
            timestamp = base36_to_int(token.split("-")[0])
        except ValueError:
            return False
        return (self._num_seconds(self._now()) - timestamp) <= SET_PASSWORD_TIMEOUT_SECONDS


set_password_token = SetPasswordTokenGenerator()
