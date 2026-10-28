"""CSV export helpers shared by every download (garages, audit trails)."""

import csv
import io

from django.http import HttpResponse
from django.utils import timezone

# Spreadsheet apps run a cell that starts with one of these as a formula (CSV injection).
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def escape_cell(value) -> str:
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(_FORMULA_PREFIXES) else text


def csv_response(filename_stem: str, header: list[str], rows) -> HttpResponse:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    for row in rows:
        writer.writerow([escape_cell(cell) for cell in row])
    response = HttpResponse(buffer.getvalue(), content_type="text/csv; charset=utf-8")
    stamp = timezone.localtime().strftime("%Y%m%d-%H%M")
    response["Content-Disposition"] = f'attachment; filename="{filename_stem}-{stamp}.csv"'
    response["Cache-Control"] = "no-store"
    return response
