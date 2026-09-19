"""Plain station/bike dump from the fLotte cb_map — the quick "what is out
there right now" view, kept separate from enrich.py.

enrich.py merges two cb_map views into the full dataset the app ships. This
one answers a simpler question and is meant to be safe to run on a loop: one
map, no decoding, no merging, no touching index.html. It writes

    data.json   the raw rows exactly as the endpoint returns them
    data.md     the same thing as a human-readable dump

The nonce is the reason the earlier version of this file stopped working: it
referenced a `fresh_nonce` that had to be pasted in by hand, and a cb_map
nonce expires. It is now read from the page on every run, the same way
enrich.py does it, so the script can be scheduled and left alone.

Run:  PYTHONUTF8=1 uv run --with requests scrapper.py
      PYTHONUTF8=1 uv run --with requests scrapper.py --quiet   (no per-station print)
"""
import json
import re
import sys

import requests

PAGE = "https://flotte-berlin.de/lastenrad-ausleihen/standorte/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
JSON_OUT = "data.json"
MD_OUT = "data.md"

session = requests.Session()


def fetch_locations():
    """Return the raw location rows. Nonce and map id come from the page itself."""
    page = session.get(PAGE, headers=HEADERS)
    match = re.search(r"cb_map\.settings\s*=\s*(\{.*?\});", page.text, re.S)
    if not match:
        # Same distinction enrich.py makes: a changed site and a blocked
        # datacenter IP both yield "no settings", and they need different fixes.
        snippet = re.sub(r"\s+", " ", page.text[:400])
        raise SystemExit(
            f"No cb_map.settings block on {PAGE} "
            f"(HTTP {page.status_code}, {len(page.text)} bytes). Start of response:\n{snippet}")
    settings = json.loads(match.group(1))

    ajax_url = settings["data_url"]
    payload = {
        "action": "cb_map_locations",
        "nonce": settings["nonce"],
        "cb_map_id": str(settings["cb_map_id"]),
    }

    print("Downloading location data...\n")
    response = session.post(ajax_url, data=payload, headers=HEADERS)
    map_data = response.json()
    if not isinstance(map_data, list):
        raise SystemExit(
            f"Expected a list of stations, got {type(map_data).__name__}: {map_data!r:.200}")
    return map_data


def render(map_data, quiet=False):
    """The human dump. Returns it as text so data.md is exactly what you saw."""
    out = [f"Successfully fetched {len(map_data)} stations!\n"]

    for station in map_data:
        # Get the station details
        loc_name = station.get('location_name', 'Unknown')
        lat = station.get('lat')
        lon = station.get('lon')
        street = station.get('address', {}).get('street', 'Unknown Street')

        # Get a list of the bike names at this station
        bikes = [bike.get('name') for bike in station.get('items', [])]
        bike_names = ", ".join(bikes)

        # Print it out nicely
        out.append(f"🚲 {loc_name}")
        out.append(f"📍 {street} ({lat}, {lon})")
        out.append(f"📦 Bikes: {bike_names}")
        out.append("-" * 40)

    text = "\n".join(out)
    if not quiet:
        print(text)
    return text


def main():
    quiet = "--quiet" in sys.argv[1:]
    map_data = fetch_locations()
    print(f"Successfully fetched {len(map_data)} stations!\n")

    # json.dump, not print(): the previous data.json was a Python repr with
    # single quotes, which no JSON parser will read.
    with open(JSON_OUT, "w", encoding="utf-8") as fh:
        json.dump(map_data, fh, ensure_ascii=False, indent=1)
    with open(MD_OUT, "w", encoding="utf-8") as fh:
        fh.write(render(map_data, quiet) + "\n")

    bikes = sum(len(s.get("items", [])) for s in map_data)
    print(f"\nwrote {JSON_OUT} and {MD_OUT} — {len(map_data)} stations, {bikes} bikes")


if __name__ == "__main__":
    sys.exit(main())
