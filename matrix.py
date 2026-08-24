"""Precomputed station-to-station travel times, so the round survives an outage.

After the first hop every node in the round's matrix is one of the 250 known
stations (ensureTour builds it from here() + the remaining stations, and here()
is a station once she has set off). So the matrix the visiting order needs is a
fixed 250x250 — it can be computed once, offline, and shipped in the payload.
Only the very first hop then needs a live routing call, and that is the part a
straight-line estimate approximates best.

Source is the FOSSGIS OSRM behind osm.org, which runs a SEPARATE instance per
profile. Note the demo server at router.project-osrm.org does NOT: it serves one
car profile and silently ignores the profile in the URL, so bike times come back
as car times, roughly twice too fast. verify() below refuses data that looks
like that.

Usage:
    python3 matrix.py --harvest    # -> flotte_matrix.json  (~50 calls, a few min)
    python3 matrix.py --check      # sanity report, no network
    python3 matrix.py --apply      # pack into index.html's payload

Stdlib only.
"""
import base64
import json
import re
import struct
import sys
import time
import urllib.error
import urllib.request

HOST = "https://routing.openstreetmap.de"
PROFILES = {"bicycle": "routed-bike", "pedestrian": "routed-foot"}
BLOCK = 50            # OSRM caps a table at 100 coordinates, so 50 + 50
GAP = 1.2             # seconds between calls; this is a donated community service
UNREACHABLE = 65535   # uint16 sentinel
OUT = "flotte_matrix.json"
PAGE = "index.html"
UA = "fLotte-repair-round/1.0 (offline station matrix; contact via flotte-berlin.de)"


def stations():
    with open(PAGE, encoding="utf-8") as fh:
        page = fh.read()
    m = re.search(r'<script id="payload" type="application/json">(.*?)</script>', page, re.S)
    return json.loads(m.group(1))["locations"]


def _table(profile, coords, src_idx, dst_idx):
    path = ";".join(f"{lon:.5f},{lat:.5f}" for lat, lon in coords)
    q = ("annotations=duration"
         f"&sources={';'.join(map(str, src_idx))}"
         f"&destinations={';'.join(map(str, dst_idx))}")
    url = f"{HOST}/{PROFILES[profile]}/table/v1/driving/{path}?{q}"
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as fh:
                return json.loads(fh.read().decode("utf-8"))["durations"]
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt < 3:
                time.sleep(4)
                continue
            raise


def harvest():
    locs = stations()
    n = len(locs)
    pts = [(l["lat"], l["lon"]) for l in locs]
    blocks = [list(range(i, min(i + BLOCK, n))) for i in range(0, n, BLOCK)]
    out = {}
    for profile in PROFILES:
        grid = [[UNREACHABLE] * n for _ in range(n)]
        done = 0
        for a in blocks:
            for b in blocks:
                if a is b:
                    coords = [pts[i] for i in a]
                    dur = _table(profile, coords, range(len(a)), range(len(a)))
                else:
                    coords = [pts[i] for i in a] + [pts[i] for i in b]
                    dur = _table(profile, coords,
                                 range(len(a)), range(len(a), len(a) + len(b)))
                for r, i in enumerate(a):
                    for c, j in enumerate(b):
                        v = dur[r][c]
                        grid[i][j] = UNREACHABLE if v is None else min(int(round(v)), UNREACHABLE - 1)
                done += 1
                print(f"  {profile}: block {done}/{len(blocks)**2}", flush=True)
                time.sleep(GAP)
        out[profile] = grid
    payload = {"n": n, "names": [l["location_name"] for l in locs], "grid": out}
    verify(payload)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    print(f"wrote {OUT}")


def verify(payload):
    """Refuse data that looks like one profile served twice."""
    bike = payload["grid"]["bicycle"]
    foot = payload["grid"]["pedestrian"]
    n = payload["n"]
    same = slower = pairs = 0
    # stride adapts to n: a fixed stride samples nothing on a small matrix and
    # the check would pass vacuously, which is worse than not having it
    step = max(1, n // 40)
    for i in range(0, n, step):
        for j in range(0, n, step):
            if i == j or bike[i][j] >= UNREACHABLE or foot[i][j] >= UNREACHABLE:
                continue
            pairs += 1
            if bike[i][j] == foot[i][j]:
                same += 1
            if foot[i][j] > bike[i][j]:
                slower += 1
    if not pairs:
        raise SystemExit("verify: no comparable pairs — the harvest looks empty")
    if same / pairs > 0.02:
        raise SystemExit(
            f"verify: {same}/{pairs} sampled pairs have identical bike and foot times. "
            "The source is probably serving one profile for both — refusing to ship it.")
    if slower / pairs < 0.9:
        raise SystemExit(
            f"verify: walking is slower than cycling in only {slower}/{pairs} pairs. "
            "That is not a pedestrian profile — refusing to ship it.")
    print(f"verify: ok ({pairs} pairs sampled, {slower} with walking slower)")


def _pack(grid, n):
    buf = bytearray()
    for row in grid:
        for v in row:
            buf += struct.pack("<H", v)
    return base64.b64encode(bytes(buf)).decode("ascii")


def apply_to_payload():
    with open(OUT, encoding="utf-8") as fh:
        m = json.load(fh)
    verify(m)
    n = m["n"]
    with open(PAGE, encoding="utf-8") as fh:
        page = fh.read()
    match = re.search(r'(<script id="payload" type="application/json">)(.*?)(</script>)',
                      page, re.S)
    data = json.loads(match.group(2))
    if len(data["locations"]) != n:
        raise SystemExit(f"station count changed ({len(data['locations'])} vs {n}) — re-harvest")
    for i, name in enumerate(m["names"]):
        if data["locations"][i]["location_name"] != name:
            raise SystemExit(f"station {i} changed name — the matrix rows would be wrong; re-harvest")
    data["matrix"] = {"n": n,
                      "bicycle": _pack(m["grid"]["bicycle"], n),
                      "pedestrian": _pack(m["grid"]["pedestrian"], n)}
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(PAGE, "w", encoding="utf-8") as fh:
        fh.write(page[:match.start(2)] + body + page[match.end(2):])
    print(f"{PAGE} payload updated ({len(body)/1024:.0f} KB)")


def check():
    with open(OUT, encoding="utf-8") as fh:
        m = json.load(fh)
    verify(m)
    n = m["n"]
    for profile, grid in m["grid"].items():
        vals = [grid[i][j] for i in range(n) for j in range(n)
                if i != j and grid[i][j] < UNREACHABLE]
        bad = sum(1 for i in range(n) for j in range(n)
                  if i != j and grid[i][j] >= UNREACHABLE)
        vals.sort()
        print(f"  {profile:11s} median {vals[len(vals)//2]/60:5.1f} min · "
              f"max {vals[-1]/60:5.1f} min · unreachable {bad}")


if __name__ == "__main__":
    args = set(sys.argv[1:])
    if "--harvest" in args:
        harvest()
    elif "--apply" in args:
        apply_to_payload()
    elif "--check" in args:
        check()
    else:
        raise SystemExit(__doc__)
