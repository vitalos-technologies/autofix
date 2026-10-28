"""Reusable data table: column description, sorting, pagination and density.

A view describes its columns with ``Column`` and calls ``build_table``; the result is rendered by
``templates/partials/data_table.html``. Sort fields are whitelisted from the column list, so
``?sort=`` can never reach the ORM unchecked.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from urllib.parse import urlencode

from django import template
from django.core.paginator import EmptyPage, PageNotAnInteger, Paginator

register = template.Library()

PER_PAGE = 50
DENSITIES = ("comfortable", "compact")
DEFAULT_DENSITY = "comfortable"


@dataclass(frozen=True)
class Column:
    """One table column. ``sort_field`` is the ORM ordering field when the column is sortable."""

    key: str
    label: str
    sort_field: str = ""
    numeric: bool = False
    mono: bool = False
    nowrap: bool = False

    @property
    def sortable(self) -> bool:
        return bool(self.sort_field)


def query_string(request, **updates) -> str:
    """Current query string with ``updates`` applied (None removes a key)."""
    params = request.GET.copy()
    for key, value in updates.items():
        if value is None:
            params.pop(key, None)
        else:
            params[key] = value
    encoded = urlencode([(k, v) for k in params for v in params.getlist(k) if v != ""])
    return f"?{encoded}" if encoded else "?"


def resolve_sort(request, columns: Iterable[Column], default: str, default_dir: str = "desc"):
    """Return (column key, direction, ordering expression) from the request, falling back safely."""
    by_key = {column.key: column for column in columns if column.sortable}
    key = request.GET.get("sort", "")
    if key not in by_key:
        key = default if default in by_key else ""
    direction = request.GET.get("dir", default_dir)
    if direction not in ("asc", "desc"):
        direction = default_dir
    if not key:
        return "", direction, None
    field = by_key[key].sort_field
    return key, direction, f"-{field}" if direction == "desc" else field


def density(request) -> str:
    value = request.GET.get("density", DEFAULT_DENSITY)
    return value if value in DENSITIES else DEFAULT_DENSITY


def build_table(
    request,
    queryset,
    columns: list[Column],
    row: Callable,
    *,
    caption: str,
    target_id: str,
    url: str,
    default_sort: str = "",
    default_dir: str = "desc",
    tiebreak: tuple[str, ...] = ("-id",),
    per_page: int = PER_PAGE,
    empty_message: str = "Nothing to show.",
    error: str = "",
) -> dict:
    """Sort, paginate and describe ``queryset`` for the data_table partial.

    ``row(obj)`` returns one cell value (string) per column, in column order.
    ``url`` is the path the sort, page and density links point at.
    """
    key, direction, ordering = resolve_sort(request, columns, default_sort, default_dir)
    if ordering:
        queryset = queryset.order_by(ordering, *tiebreak)
    paginator = Paginator(queryset, per_page)
    try:
        page = paginator.page(request.GET.get("page", 1))
    except PageNotAnInteger:
        page = paginator.page(1)
    except EmptyPage:
        page = paginator.page(paginator.num_pages)

    headers = []
    for column in columns:
        aria = ""
        link = ""
        next_dir = "asc"
        if column.sortable:
            active = column.key == key
            if active:
                aria = "ascending" if direction == "asc" else "descending"
                next_dir = "desc" if direction == "asc" else "asc"
            link = url + query_string(request, sort=column.key, dir=next_dir, page=None)
        headers.append({"column": column, "aria_sort": aria, "url": link, "direction": direction})

    rows = [list(zip(columns, row(obj), strict=True)) for obj in page.object_list] if not error else []
    total = paginator.count
    current = density(request)
    return {
        "caption": caption,
        "target_id": target_id,
        "headers": headers,
        "rows": rows,
        "page": page,
        "total": total,
        "first": page.start_index() if total else 0,
        "last": page.end_index() if total else 0,
        "prev_url": url + query_string(request, page=page.previous_page_number())
        if page.has_previous()
        else "",
        "next_url": url + query_string(request, page=page.next_page_number()) if page.has_next() else "",
        "density": current,
        "density_urls": [
            (name, url + query_string(request, density=name, page=None), name == current)
            for name in DENSITIES
        ],
        "empty_message": empty_message,
        "error": error,
    }
