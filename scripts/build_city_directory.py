"""Build frontend/public/cities.json — the full A-Z city list shown on the
Change Location screen.

Source: GeoNames city data (CC BY 4.0, https://www.geonames.org), as bundled in
the `geonamescache` pip package. Included:
  * every US city/town with population >= 1,000 (low enough to catch places
    like Voorhees, NJ, whose GeoNames point counts only the village center)
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

US_MIN_POP = 1_000
WORLD_MIN_POP = 100_000
COUNTRY_SHORT = {"US": "USA", "GB": "UK", "AE": "UAE"}
# GeoNames "populated places" that aren't towns people live in.
SKIP_WORDS = ("mall", "census designated", "(historical)")
# Places whose GeoNames point is a different, smaller spot with the same name.
# GeoNames' "Voorhees, NJ" is a hamlet near New Brunswick; people mean
# Voorhees Township in Camden County.
# Spell out leading numbers so the city files under a letter in the A-Z list.
NAME_OVERRIDES = {"6th of October City": "Sixth of October City"}
COORD_OVERRIDES = {("voorhees", "NJ"): (39.8447, -74.9614)}


def main(data_dir: str) -> None:
    data = Path(data_dir)
    cities = json.loads((data / "cities1000.json").read_text())
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
        name = NAME_OVERRIDES.get(c["name"].strip(), c["name"].strip())
        if not name or any(w in name.lower() for w in SKIP_WORDS):
            continue
        region = (c.get("admin1code") or "") if cc == "US" else ""
        country = COUNTRY_SHORT.get(cc) or countries.get(cc, {}).get("name") or cc
        key = (name.lower(), region, cc)
        if key in seen:
            continue
        seen.add(key)
        lat, lng = COORD_OVERRIDES.get((name.lower(), region), (c["latitude"], c["longitude"]))
        rows.append([name, region, country, cc.lower(), round(float(lat), 4), round(float(lng), 4)])

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
