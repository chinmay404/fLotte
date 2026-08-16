"""Rebuild index.html from template.html without touching the network.

The payload (locations + district colours) is recovered from the existing
index.html, so the site is only re-scraped when you actually want fresh data
(enrich.py --html). Run:  uv run build.py    (stdlib only)
"""
import re
import sys

TEMPLATE = "template.html"
PAGE = "index.html"

def main():
    with open(PAGE, encoding="utf-8") as fh:
        page = fh.read()
    m = re.search(
        r'<script id="payload" type="application/json">(.*?)</script>',
        page, re.S)
    if not m or not m.group(1).strip().startswith("{"):
        raise SystemExit(f"No inlined payload found in {PAGE} — "
                         "run enrich.py --html once to fetch data.")
    payload = m.group(1)

    with open(TEMPLATE, encoding="utf-8") as fh:
        template = fh.read()
    if "__DATA__" not in template:
        raise SystemExit(f"{TEMPLATE} has no __DATA__ placeholder.")

    with open(PAGE, "w", encoding="utf-8") as fh:
        fh.write(template.replace("__DATA__", payload))
    print(f"Rebuilt {PAGE} ({len(payload)/1024:.0f} KB payload reused)")

if __name__ == "__main__":
    sys.exit(main())
