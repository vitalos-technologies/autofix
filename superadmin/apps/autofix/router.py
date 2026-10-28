"""Database router: Autofix models read from the ``autofix`` alias and are never migrated or written.

- Reads of ``autofix`` models go to the ``autofix`` alias; everything else to ``default``.
- ``db_for_write`` refuses ``autofix`` models outright (the models refuse too, and the database role
  holds SELECT only). Platform writes are SQL function calls in ``apps.autofix.db``, not ORM writes.
- ``allow_migrate`` is False for the ``autofix`` alias (no app is ever migrated there) and for the
  ``autofix`` app on any database, so ``migrate`` can never create or alter Autofix tables.
"""

from .db import current_alias
from .models import ReadOnlyModelError

ALIAS = "autofix"
APP_LABEL = "autofix"


def _is_autofix(model) -> bool:
    meta = getattr(model, "_meta", None)
    return meta is not None and meta.app_label == APP_LABEL


class AutofixRouter:
    def db_for_read(self, model, **hints):
        return current_alias() if _is_autofix(model) else None

    def db_for_write(self, model, **hints):
        if _is_autofix(model):
            raise ReadOnlyModelError("Autofix models are read-only; use apps.autofix.services.")
        return None

    def allow_relation(self, obj1, obj2, **hints):
        first, second = _is_autofix(obj1), _is_autofix(obj2)
        if first and second:
            return True
        if first or second:
            return False
        return None

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if db == ALIAS or db.startswith(f"{ALIAS}_") or app_label == APP_LABEL:
            return False
        return None
