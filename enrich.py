"""Merge the two fLotte cb_map views into one enriched location dataset.

/standorte/        (map 10460) decodes bike type + features
/standorte/bezirke/ (map 10146) decodes district, region, project

Both maps return the SAME 250 locations; only their category decoders differ.
Run:  PYTHONUTF8=1 uv run --with requests enrich.py
"""
import json
import re
import sys
from collections import Counter, defaultdict

import requests

PAGES = {
    "standorte": "https://flotte-berlin.de/lastenrad-ausleihen/standorte/",
    "bezirke": "https://flotte-berlin.de/lastenrad-ausleihen/standorte/bezirke/",
}
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
# standorte's category groups ship with an empty "name"; bezirke's are named.
GROUP_KEYS = {
    "g1614154314348-789248": "type",
    "g1699291310052-802989": "drive",
    "g1699291327202-54299": "features",
}
GROUP_NAMES = {
    "Bezirke": "district",
    "Regionen Berlin & Umland": "region",
    "Projekte": "project",
}
OUT = "flotte_locations.json"
TEMPLATE = "template.html"
HTML_OUT = "index.html"

session = requests.Session()


def fetch_map(page_url):
    """Return (settings, rows). nonce / map id / ajax url all come from the page."""
    page = session.get(page_url, headers=HEADERS)
    html = page.text
    match = re.search(r"cb_map\.settings\s*=\s*(\{.*?\});", html, re.S)
    if not match:
        # Distinguish "the site changed" from "this network is blocked":
        # the same request works from a residential IP but hosting firewalls
        # may serve datacenter IPs (e.g. GitHub Actions) a challenge page.
        snippet = re.sub(r"\s+", " ", html[:400])
        raise SystemExit(
            f"No cb_map.settings block on {page_url} "
            f"(HTTP {page.status_code}, {len(html)} bytes). Start of response:\n{snippet}")
    settings = json.loads(match.group(1))
    response = session.post(
        settings["data_url"],
        headers=HEADERS,
        data={
            "action": "cb_map_locations",
            "nonce": settings["nonce"],
            "cb_map_id": str(settings["cb_map_id"]),
        },
    )
    rows = response.json()
    if not isinstance(rows, list):
        raise SystemExit(f"Expected a list from {page_url}, got {type(rows).__name__}: {rows!r:.200}")
    return settings, rows


def build_decoder(*settings_list):
    """cat_id -> (group, label, color), merged across every map's filter definitions."""
    decoder = {}
    for settings in settings_list:
        for key, group in settings.get("filter_cb_item_categories", {}).items():
            name = GROUP_NAMES.get(group.get("name", ""), "") or GROUP_KEYS.get(key, f"group_{key[:6]}")
            for element in group.get("elements", []):
                label = re.sub(r"<[^>]+>", "", element["markup"]).strip()
                decoder[element["cat_id"]] = (name, label, element.get("color") or "")
    return decoder


def district_colors(decoder):
    """The page ships fLotte's own district colours; they drive the whole palette."""
    return {label: color for group, label, color in decoder.values()
            if group == "district" and color}


def enrich(rows, decoder):
    """Resolve each item's `terms` into named groups; lift district/region to the location."""
    out = []
    for row in rows:
        items = []
        for item in row.get("items", []) or []:
            groups = defaultdict(list)
            unknown = []
            for term in item.get("terms", []):
                if term in decoder:
                    group, label, _color = decoder[term]
                    groups[group].append(label)
                else:
                    unknown.append(term)
            items.append(
                {
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "short_desc": item.get("short_desc"),
                    "link": item.get("link"),
                    "thumbnail": item.get("thumbnail"),
                    "status": item.get("status"),
                    "type": groups.get("type", []),
                    "drive": groups.get("drive", []),
                    "features": groups.get("features", []),
                    "project": groups.get("project", []),
                    "district": groups.get("district", []),
                    "region": groups.get("region", []),
                    "timeframes": item.get("timeframes", []),
                    "unknown_terms": unknown,
                }
            )
        address = row.get("address") or {}
        out.append(
            {
                "location_name": row.get("location_name"),
                "lat": row.get("lat"),
                "lon": row.get("lon"),
                "street": address.get("street"),
                "zip": address.get("zip"),
                "city": address.get("city"),
                "closed_days": row.get("closed_days"),
                "district": sorted({d for i in items for d in i["district"]}),
                "region": sorted({r for i in items for r in i["region"]}),
                "items": items,
            }
        )
    return out


def report(locations, rows_by_map, decoder):
    """Structural invariants — the selection is what fails, not the fields."""
    print("\n" + "=" * 52)
    print("INVARIANTS")
    print("=" * 52)

    name_sets = {k: {r.get("location_name") for r in v} for k, v in rows_by_map.items()}
    a, b = name_sets["standorte"], name_sets["bezirke"]
    print(f"1. same location set across maps : {'OK' if a == b else 'MISMATCH'} "
          f"({len(a)} vs {len(b)}, {len(a ^ b)} differing)")

    items = [i for loc in locations for i in loc["items"]]
    no_district = [i["name"] for i in items if len(i["district"]) != 1]
    print(f"2. exactly one district per bike : {'OK' if not no_district else 'FAIL'} "
          f"({len(no_district)} bikes off) {no_district[:5]}")

    per_district = Counter(d for loc in locations for d in loc["district"])
    total = sum(per_district.values())
    print(f"3. district counts sum to rows   : {total} vs {len(locations)} locations "
          f"{'OK' if total == len(locations) else '<- locations span multiple districts'}")
    for district, count in per_district.most_common():
        print(f"      {district:<28} {count:>4}")

    unknown = Counter(t for i in items for t in i["unknown_terms"])
    print(f"\n   decoder covers {len(decoder)} cat_ids; "
          f"{len(unknown)} term ids appear in data but in no filter UI: "
          f"{sorted(unknown)[:12]}")
    print(f"   locations={len(locations)}  bikes={len(items)}  "
          f"unique bike ids={len({i['id'] for i in items})}")
    if len(locations) == 250:
        print("   NOTE: exactly 250 — still unproven whether this is the true total "
              "or a server-side cap.")


def write_html(locations, colors):
    """Inline the data into template.html -> a single self-contained index.html."""
    try:
        with open(TEMPLATE, encoding="utf-8") as fh:
            template = fh.read()
    except FileNotFoundError:
        raise SystemExit(f"{TEMPLATE} not found — it lives next to this script.")

    payload = json.dumps(
        {"locations": locations, "colors": colors},
        ensure_ascii=False, separators=(",", ":"),
    ).replace("<", "\\u003c")  # never let the data close the <script> tag

    if "__DATA__" not in template:
        raise SystemExit(f"{TEMPLATE} has no __DATA__ placeholder.")
    with open(HTML_OUT, "w", encoding="utf-8") as fh:
        fh.write(template.replace("__DATA__", payload))
    size = len(payload) / 1024
    print(f"Wrote {HTML_OUT} ({size:.0f} KB of data inlined, {len(colors)} district colours)")


def main():
    build_page = "--html" in sys.argv[1:]
    settings, rows = {}, {}
    for name, url in PAGES.items():
        print(f"Fetching {name} ...", flush=True)
        settings[name], rows[name] = fetch_map(url)
        print(f"  map {settings[name]['cb_map_id']} -> {len(rows[name])} locations")

    decoder = build_decoder(*settings.values())
    locations = enrich(rows["bezirke"], decoder)

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(locations, fh, ensure_ascii=False, indent=2)
    print(f"\nWrote {OUT} ({len(locations)} locations)")

    if build_page:
        write_html(locations, district_colors(decoder))
        report(locations, rows, decoder)
        return

    for loc in locations[:5]:
        district = ", ".join(loc["district"]) or "?"
        region = ", ".join(loc["region"]) or "?"
        print(f"\n🚲 {loc['location_name']}  [{district} / {region}]")
        print(f"📍 {loc['street']}, {loc['zip']} {loc['city']} ({loc['lat']}, {loc['lon']})")
        for item in loc["items"]:
            bits = " · ".join(filter(None, [
                "/".join(item["type"]),
                "/".join(item["drive"]),
                "/".join(item["project"]),
            ]))
            print(f"📦 {item['name']}: {bits}")
            if item["features"]:
                print(f"      features: {', '.join(item['features'])}")

    report(locations, rows, decoder)


if __name__ == "__main__":
    sys.exit(main())
