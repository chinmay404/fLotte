"""Station opening hours for fLotte — scrape, parse, and inject into the payload.

fLotte publishes pickup hours as free German text ("Abhol-Hinweise") on each
CommonsBooking location page. They are NOT in the cb_map AJAX feed that
enrich.py uses, nor in the WP REST meta, so they need their own pass:

    /wp-json/wp/v2/cb_location   -> every location's URL   (4 requests)
    each location page           -> div.cb-location-pickupinstructions

Usage:
    python3 hours.py --scrape        # -> flotte_hours.json  (slow, ~8 min)
    python3 hours.py --apply         # merge flotte_hours.json into index.html
    python3 hours.py --check         # parse coverage report, no network

Be polite: their host 503s under concurrency. One request at a time, 1.5s apart.
Stdlib only.
"""
import json
import re
import sys
import time
import html as _html
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
REST = "https://flotte-berlin.de/wp-json/wp/v2/cb_location"
OUT = "flotte_hours.json"
PAGE = "index.html"
GAP = 1.5           # seconds between page fetches

# ---------------------------------------------------------------- parsing

DAYS = {"mo": 1, "di": 2, "mi": 3, "do": 4, "fr": 5, "sa": 6, "so": 7}
DAY = r"(?:Mo|Di|Mi|Do|Fr|Sa|So|Feiertag\w*)"
# fLotte writes day lists with any of these, not just commas:
#   "Di + Do", "Sa+So", "Mo/Mi/Do", "Di u. Mi", "Mo und Fr"
# Missing one silently drops a day, and a dropped day reads as CLOSED, which
# would skip a station that is actually open.
SEP = r"\s*(?:,|\+|/|&|u\.|und)\s*"

# everything from the holiday clause onward is prose, not a schedule
TAIL = re.compile(r"[,.;]?\s*\(?\s*(?:außer|ausser)\s+an\s+(?:gesetzl\w*\.?\s*)?Feiertagen\)?",
                  re.I)
# real qualifiers that are not a clock time
VAGUE = re.compile(r"nach\s+(?:vorheriger\s+)?(?:individueller\s+)?(?:telefon\w*\s+)?Absprache"
                   r"|Terminvereinbarung|nach\s+Vereinbarung|vormittags|nachmittags"
                   r"|auf\s+Anfrage", re.I)
RANGE = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?")
CLAUSE = re.compile(
    rf"((?:{DAY}(?:\s*[-–]\s*{DAY})?)(?:{SEP}{DAY}(?:\s*[-–]\s*{DAY})?)*)"
    rf"\s*(?![-–]\s*{DAY})"
    r"((?:\s*\d{1,2}(?::\d{2})?\s*[-–]\s*\d{1,2}(?::\d{2})?(?:\s*(?:\||u\.|und|,)\s*)?)+)",
    re.I)


def _expand(token):
    """'Mo-Fr' -> [1,2,3,4,5];  'Sa' -> [6];  'Feiertag' -> [] (not a weekday)"""
    parts = [t for t in re.split(r"\s*[-–]\s*", token.strip()) if t]
    keys = [p[:2].lower() for p in parts]
    if not keys or keys[0] not in DAYS:          # e.g. "Feiertag" in a day list
        return []
    a = DAYS[keys[0]]
    if len(keys) == 1 or keys[1] not in DAYS:
        return [a]
    b = DAYS[keys[1]]
    return list(range(a, b + 1)) if b >= a else list(range(a, 8)) + list(range(1, b + 1))


def parse_pickup(text):
    """German pickup text -> ({weekday: [[open_min, close_min], ...]}, flags).

    weekday is 1=Monday .. 7=Sunday, minutes from midnight. A weekday absent
    from the result means closed *if* any day parsed at all; an empty schedule
    means we learned nothing and the caller must treat the station as unknown.
    """
    flags = []
    if not text or not text.strip():
        return {}, ["empty"]
    body = text
    m = TAIL.search(body)
    if m:
        body = body[:m.start()]
    if VAGUE.search(text):
        flags.append("by-arrangement")

    sched = {}
    for clause in CLAUSE.finditer(body):
        days = []
        for token in re.split(SEP, clause.group(1)):
            if token.strip():
                days += _expand(token)
        spans = [[int(a) * 60 + int(b or 0), int(c) * 60 + int(d or 0)]
                 for a, b, c, d in RANGE.findall(clause.group(2))]
        spans = [s for s in spans if s[1] > s[0]]          # drop nonsense
        for day in days:
            for span in spans:
                sched.setdefault(day, [])
                if span not in sched[day]:
                    sched[day].append(span)
    for day in sched:
        sched[day].sort()

    # A day named with no clock time, where the text says "by arrangement", is
    # NOT closed — it is unknown. Leaving it out would make the app treat it as
    # a shut door and skip real work, so give it an open-ended window and say
    # the parse is inexact. Absence of data must never read as a closed door.
    named = _days_named(body)
    missing = sorted(named - set(sched))
    if missing and VAGUE.search(body):
        for day in missing:
            sched[day] = [[0, 24 * 60]]
        flags.append("open-ended")

    leftover = re.sub(r"(?:Uhr|und|u\.)", "", CLAUSE.sub("", body), flags=re.I)
    leftover = re.sub(r"[\s,;.|()–-]+", "", leftover)
    if leftover and not VAGUE.search(body):
        flags.append("residue:" + leftover[:40])
    if not sched:
        flags.append("no-times")
    return sched, flags


def _days_named(body):
    """Every weekday the text mentions, whether or not it got a time."""
    out = set()
    for a, b in re.findall(r"(Mo|Di|Mi|Do|Fr|Sa|So)\s*[-–]\s*(Mo|Di|Mi|Do|Fr|Sa|So)", body):
        x, y = DAYS[a.lower()], DAYS[b.lower()]
        out |= set(range(x, y + 1)) if y >= x else set(range(x, 8)) | set(range(1, y + 1))
    rest = re.sub(r"(Mo|Di|Mi|Do|Fr|Sa|So)\s*[-–]\s*(Mo|Di|Mi|Do|Fr|Sa|So)", " ", body)
    for tok in re.findall(r"\b(Mo|Di|Mi|Do|Fr|Sa|So)\b", rest):
        out.add(DAYS[tok.lower()])
    return out


# ---------------------------------------------------------------- scraping

PICKUP = re.compile(r'class="cb-address cb-location-pickupinstructions">(.*?)</div>', re.S)


def _clean(fragment):
    txt = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", _html.unescape(txt)).replace("Abhol-Hinweise:", "").strip()


def _get(url, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as fh:
                return fh.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            if exc.code in (503, 429) and attempt < tries - 1:
                time.sleep(4 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt < tries - 1:
                time.sleep(3)
                continue
            raise


def scrape():
    index = []
    for page in range(1, 20):
        body = _get(f"{REST}?per_page=100&page={page}&_fields=id,slug,link,title")
        rows = json.loads(body)
        if not rows:
            break
        index += rows
        if len(rows) < 100:
            break
    print(f"{len(index)} cb_location entries", flush=True)

    out = []
    for n, loc in enumerate(index, 1):
        title = _html.unescape(loc["title"]["rendered"])
        try:
            found = PICKUP.search(_get(loc["link"]))
            out.append({"slug": loc["slug"], "title": title,
                        "hours_text": _clean(found.group(1)) if found else None})
        except Exception as exc:                       # noqa: BLE001 - report, keep going
            out.append({"slug": loc["slug"], "title": title,
                        "hours_text": None, "error": str(exc)})
        if n % 25 == 0:
            print(f"  {n}/{len(index)}", flush=True)
        time.sleep(GAP)

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    got = sum(1 for r in out if r.get("hours_text"))
    bad = sum(1 for r in out if r.get("error"))
    print(f"wrote {OUT}: {len(out)} locations, {got} with hours, {bad} errors")


# ---------------------------------------------------------------- merging

def _key(name):
    s = name.lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z0-9]", "", s)


def apply_to_payload():
    with open(OUT, encoding="utf-8") as fh:
        scraped = {_key(r["title"]): r for r in json.load(fh)}
    with open(PAGE, encoding="utf-8") as fh:
        page = fh.read()
    match = re.search(r'(<script id="payload" type="application/json">)(.*?)(</script>)',
                      page, re.S)
    if not match:
        raise SystemExit(f"no payload in {PAGE}")
    data = json.loads(match.group(2))

    stats = {"schedule": 0, "arranged": 0, "none": 0, "unmatched": 0}
    for loc in data["locations"]:
        row = scraped.get(_key(loc["location_name"]))
        if row is None:
            loc["hours"], loc["hours_text"] = None, None
            stats["unmatched"] += 1
            continue
        text = row.get("hours_text")
        loc["hours_text"] = text or None
        sched, flags = parse_pickup(text)
        loc["hours"] = {str(k): v for k, v in sorted(sched.items())} if sched else None
        # an inexact parse must show her the original German, not a tidy summary
        loc["hours_exact"] = bool(sched) and not any(
            f == "open-ended" or f.startswith("residue") for f in flags)
        if sched:
            stats["schedule"] += 1
        elif "by-arrangement" in flags:
            stats["arranged"] += 1
        else:
            stats["none"] += 1

    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(PAGE, "w", encoding="utf-8") as fh:
        fh.write(page[:match.start(2)] + body + page[match.end(2):])
    total = len(data["locations"])
    print(f"{PAGE} payload updated ({len(body)/1024:.0f} KB)")
    print(f"  {stats['schedule']}/{total} stations with a weekly schedule")
    print(f"  {stats['arranged']} by arrangement · {stats['none']} no text · "
          f"{stats['unmatched']} unmatched")
    print("NOTE: template.html carries no payload; run build.py only to re-apply markup.")


def check():
    with open(OUT, encoding="utf-8") as fh:
        rows = json.load(fh)
    have = [r for r in rows if r.get("hours_text")]
    good = arranged = other = 0
    residue = []
    for r in have:
        sched, flags = parse_pickup(r["hours_text"])
        if sched:
            good += 1
            if any(f.startswith("residue") for f in flags):
                residue.append((r["title"], r["hours_text"], flags))
        elif "by-arrangement" in flags:
            arranged += 1
        else:
            other += 1
            residue.append((r["title"], r["hours_text"], flags))
    print(f"{len(rows)} locations, {len(have)} with text")
    print(f"  {good} parsed into a schedule · {arranged} by arrangement · {other} nothing")
    for title, text, flags in residue[:10]:
        print(f"  ? {title[:26]:28s} {text[:64]}  {flags}")


if __name__ == "__main__":
    args = set(sys.argv[1:])
    if "--scrape" in args:
        scrape()
    elif "--apply" in args:
        apply_to_payload()
    elif "--check" in args:
        check()
    else:
        raise SystemExit(__doc__)
