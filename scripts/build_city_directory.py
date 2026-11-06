"""Build frontend/public/cities.json — the full A-Z city list shown on the
Change Location screen.

Source: GeoNames city data (CC BY 4.0, https://www.geonames.org), as bundled in
the `geonamescache` pip package. Included:
  * every US city/town with population >= 10,000
  * every city outside the US with population >= 100,000

Run (from the repo root):
    pip install geonamescache
    python3 scripts/build_city_directory.py

Output is a compact JSON array of rows:
    [name, region, country, country_code, lat, lng]
`region` is the US state code (e.g. "NJ") and empty elsewhere. The app shows
"<region>, <country>" under the name, and picks the label
"<name>, <region>, <country>" — the same format users' home towns are saved in.
"""
import json
import os
import sys
from pathlib import Path

US_MIN_POP = 10_000
WORLD_MIN_POP = 100_000
COUNTRY_SHORT = {"US": "USA", "GB": "UK", "AE": "UAE"}
# GeoNames "populated places" that aren't towns people live in.
SKIP_WORDS = ("mall", "census designated", "(historical)")


def main(data_dir: str) -> None:
    data = Path(data_dir)
    cities = json.loads((data / "cities5000.json").read_text())
    countries = json.loads((data / "countries.json").read_text())

    rows, seen = [], set()
    for c in cities.values():
        cc = c["countrycode"]
        pop = c.get("population") or 0
        if cc == "US":
            if pop < US_MIN_POP:
                continue
        elif pop < WORLD_MIN_POP:
            continue
        name = c["name"].strip()
        if not name or any(w in name.lower() for w in SKIP_WORDS):
            continue
        region = (c.get("admin1code") or "") if cc == "US" else ""
        country = COUNTRY_SHORT.get(cc) or countries.get(cc, {}).get("name") or cc
        key = (name.lower(), region, cc)
        if key in seen:
            continue
        seen.add(key)
        rows.append([name, region, country, cc.lower(),
                     round(float(c["latitude"]), 4), round(float(c["longitude"]), 4)])

    rows.sort(key=lambda r: (r[0].lower(), r[2], r[1]))
    out = Path(__file__).resolve().parent.parent / "frontend" / "public" / "cities.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {len(rows)} cities to {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        main(sys.argv[1])
    else:
        import geonamescache  # noqa: F401
        main(os.path.join(os.path.dirname(geonamescache.__file__), "data"))
