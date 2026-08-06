#!/usr/bin/env python3
"""Build the compact daily-anomaly dataset used by the climate spiral.

Downloads the ERA5 daily global mean 2 m temperature series published by the
Copernicus Climate Change Service (C3S) through ECMWF's Climate Pulse, converts
the anomalies from the 1991-2020 reference period to the pre-industrial
1850-1900 baseline, and writes them out grouped by year.

The source endpoint sends no CORS header, so the browser cannot read it
directly -- hence this offline step and the generated file being committed.

Usage:
    python build_data.py            # download and rebuild
    python build_data.py --csv f    # rebuild from an already saved CSV
"""

from __future__ import annotations

import argparse
import calendar
import csv
import datetime as dt
import json
import sys
import urllib.request
from collections import OrderedDict
from pathlib import Path

SOURCE_URL = (
    "https://sites.ecmwf.int/data/climatepulse/data/series/"
    "era5_daily_series_2t_global.csv"
)

# C3S adds a fixed offset to express anomalies relative to the pre-industrial
# 1850-1900 period, which ERA5 does not cover. Value from the IPCC AR6 WGI
# assessment; see https://climate.copernicus.eu/temperature-qas
PREINDUSTRIAL_OFFSET_C = 0.88

# Some hosts reject the default urllib agent.
USER_AGENT = "Mozilla/5.0 (compatible; climate-spiral-build/1.0)"

PROJECT_ROOT = Path(__file__).resolve().parent
OUTPUT_PATH = PROJECT_ROOT / "data" / "era5-daily-anomaly.json"


def fetch_csv(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read().decode("utf-8")


def parse_rows(text: str) -> list[dict[str, str]]:
    """Return the CSV records, dropping the leading `#` comment block."""
    lines = [line for line in text.splitlines() if not line.startswith("#")]
    return list(csv.DictReader(lines))


def build(rows: list[dict[str, str]]) -> dict:
    years: OrderedDict[str, list[int]] = OrderedDict()
    dates: list[dt.date] = []
    last_final: str | None = None

    for row in rows:
        date = dt.date.fromisoformat(row["date"])
        # Milli-degrees as integers: the source carries three decimals, so this
        # is lossless, keeps the file small and avoids float noise in JSON.
        # Coarser rounding would misclassify days sitting just above a
        # threshold (centi-degrees drops 8 of the 2024 days above 1.5 degC).
        anomaly = round((float(row["ano_91-20"]) + PREINDUSTRIAL_OFFSET_C) * 1000)

        years.setdefault(str(date.year), []).append(anomaly)
        dates.append(date)
        if row["status"].strip().upper() == "FINAL":
            last_final = row["date"]

    check_continuity(dates)
    check_year_lengths(years)

    return {
        "meta": {
            "source": (
                "ERA5 daily global mean 2 m temperature "
                "-- Copernicus C3S / ECMWF Climate Pulse"
            ),
            "sourceUrl": SOURCE_URL,
            "baseline": (
                "1850-1900 (pre-industrial), via the C3S +0.88 degC offset "
                "from the 1991-2020 reference period"
            ),
            "preindustrialOffsetC": PREINDUSTRIAL_OFFSET_C,
            "units": "milli-degrees Celsius (value / 1000 = degC)",
            "firstDate": dates[0].isoformat(),
            "lastDate": dates[-1].isoformat(),
            "lastFinalDate": last_final,
            "dayCount": len(dates),
            "generated": dt.datetime.now(dt.timezone.utc)
            .replace(microsecond=0)
            .isoformat(),
        },
        "years": years,
    }


def check_continuity(dates: list[dt.date]) -> None:
    """Every calendar day must be present exactly once, in order."""
    for previous, current in zip(dates, dates[1:]):
        if current - previous != dt.timedelta(days=1):
            raise SystemExit(f"date gap or duplicate between {previous} and {current}")


def check_year_lengths(years: dict[str, list[int]]) -> None:
    """Full years must hold 365 or 366 values so each loop closes cleanly."""
    labels = list(years)
    for label in labels[:-1]:  # the final year is legitimately partial
        expected = 366 if calendar.isleap(int(label)) else 365
        if len(years[label]) != expected:
            raise SystemExit(
                f"year {label} has {len(years[label])} days, expected {expected}"
            )


def days_above(years: dict[str, list[int]], label: str, threshold_c: float) -> int:
    return sum(1 for value in years.get(label, []) if value / 1000 > threshold_c)


def first_crossing(dataset: dict, threshold_c: float) -> str | None:
    start = dt.date.fromisoformat(dataset["meta"]["firstDate"])
    offset = 0
    for values in dataset["years"].values():
        for position, value in enumerate(values):
            if value / 1000 > threshold_c:
                return (start + dt.timedelta(days=offset + position)).isoformat()
        offset += len(values)
    return None


def verify(dataset: dict) -> None:
    """Regression checks against figures published by C3S and warming.watch.

    These pin the whole chain -- source column, offset, rounding -- to numbers
    that were independently stated, so a silent upstream change gets caught.
    """
    years = dataset["years"]
    expectations = [
        ("days above 1.5 degC in 1940", days_above(years, "1940", 1.5), 0),
        ("days above 1.5 degC in 2024", days_above(years, "2024", 1.5), 281),
        ("first day above 1.5 degC", first_crossing(dataset, 1.5), "2015-10-05"),
    ]

    failures = [
        f"  {label}: got {actual!r}, expected {expected!r}"
        for label, actual, expected in expectations
        if actual != expected
    ]
    if failures:
        raise SystemExit("regression checks failed:\n" + "\n".join(failures))

    for label, actual, _ in expectations:
        print(f"  ok  {label}: {actual}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, help="read this CSV instead of downloading")
    parser.add_argument("--out", type=Path, default=OUTPUT_PATH, help="output path")
    args = parser.parse_args()

    if args.csv:
        print(f"reading {args.csv}")
        text = args.csv.read_text(encoding="utf-8")
    else:
        print(f"downloading {SOURCE_URL}")
        text = fetch_csv(SOURCE_URL)

    dataset = build(parse_rows(text))

    print("verifying:")
    verify(dataset)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    # Separators without spaces keep the payload tight; the arrays dominate.
    args.out.write_text(
        json.dumps(dataset, separators=(",", ":")) + "\n", encoding="utf-8"
    )

    meta = dataset["meta"]
    size_kb = args.out.stat().st_size / 1024
    print(
        f"wrote {args.out.relative_to(PROJECT_ROOT)} "
        f"({size_kb:.0f} KB, {meta['dayCount']} days, "
        f"{meta['firstDate']} to {meta['lastDate']})"
    )


if __name__ == "__main__":
    sys.exit(main())
