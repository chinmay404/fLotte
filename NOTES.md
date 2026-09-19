# Open questions and known weight

Findings from a review on 2026-09-19. **Nothing here has been removed** — this
is the record, so a later decision is made on evidence rather than rediscovered.
Numbers are measured, not estimated; the command that produced each is given
where it is short enough to rerun.

## 1. The offline matrix is most of the download

The page is **323 KB gzipped. 239 KB of that is `payload.matrix`.** Without it
the page is 84 KB. It exists so the round survives a Valhalla outage.

The **pedestrian half is the weakest part of that trade**:

| | bicycle | pedestrian |
|---|---|---|
| median station-to-station | 58 min | **188 min** |
| p90 | 97 min | 353 min |
| cells ≤ 30 min | 14.5% | **2.1%** |

160 KB raw / ~120 KB gzipped encodes walks with a median of over three hours.
It is only ever read when `roundCosting()` returns `'pedestrian'` — a mechanic
doing a *walking* repair round across Berlin.

Options, measured:

- as shipped — 323 KB gzipped
- bike matrix only — 203 KB (−120 KB)
- no matrix at all — 84 KB (−239 KB)

A third option nobody has costed yet: keep only each station's k nearest
neighbours. A real round hops between *nearby* stations, and at k=30 that is
roughly 30 KB instead of 320 KB. It needs a change to `matrix.py`'s packing and
to `matrixSec`, which is why it is a note and not a patch.

**Car note:** there is no `auto` profile in the shipped matrix, so a car round
always needs the network. `matrixFor('auto')` returns null and it falls through
to live routing on its own — correct, but it means car is the one mode with no
outage story. Harvesting a third profile would add another ~160 KB, which is
the wrong direction; the k-nearest idea above would make it affordable.

## 2. `altTotals` costs a tour solve per station, with a cliff at 13

`ensureTour` prices every alternative first stop by running a full solve for
each one, to render the "whole round from here: 47 min, +6 vs plan" hint. On
the timed path (89% of stations publish hours, so this is the normal path):

```
n=12   61 ms
n=13  123 ms     <- 13 exact Held-Karp sub-solves
n=14  3.5 ms     <- the heuristic takes over
n=20  9.0 ms
```

A 13-stop round is **~35× slower than a 14-stop one**, and it recomputes every
hop. The cause is that `tourOrder`'s `n <= 12` exact/heuristic threshold is
applied to each *sub-problem*: at n=13 every one of the 13 sub-problems is
size 12 and lands on the exact solver.

This is a real fix (threshold the sub-solves, or cap `altTotals` to the stops
actually on screen) and is independent of whether the feature stays. It was
left alone only because the brief was to note rather than change.

## 3. Two solver families, one of them provably redundant

`heldKarp` + `heuristic` (travel-only) and `heldKarpTW` + `heuristicTW`
(time-windowed). `feasibleAt(t, null)` returns `t` unchanged, so the TW family
is a strict generalisation: with no windows, "earliest finish" *is* "least
travel".

Checked, not assumed — 400 random matrices, `tourOrder(mat)` vs
`tourOrderTW(mat, null)`: **400/400 identical cost, nothing ever dropped.**

So `heldKarp`, `heuristic` and `tourOrder` (~110 lines plus their tests) could
be replaced by `tourOrderTW(mat, null)`. The cost is that TW is ~1.8× slower
per solve, which interacts badly with `altTotals` above — fix that first.

## 4. Transit is the largest feature and owns the longest latency

`PRODUCT.md` calls transit secondary, but it is the biggest thing in the app:
two hosts with failover, `transitScan`, journey alternatives, line badges,
~170 references. It is also serial by necessity — `GAP = 1100ms` between VBB
calls, five stations plus a scan ≈ **6–7 seconds** to fill the transit column.

Against "success = the user taps at most twice between opening the app and
moving", a secondary feature owning the longest latency is worth questioning.
The code already defends itself (skipped under Walk/Bike, `downStreak` bail-out
after two failures), which is itself a sign of how much trouble it causes.

## 5. Two routing engines for one capability

The shipped matrix is harvested from **OSRM** (`matrix.py`,
`routing.openstreetmap.de`); live routing is **Valhalla**. Station-to-station
legs come from OSRM, the first hop from Valhalla, so one plan can mix two
engines' numbers. `ensureTour` deliberately keeps a cell the shipped matrix
filled rather than overwriting it from a patch response, so they never mix
*within a single leg* — but they still mix within a round. Re-harvesting
against Valhalla's `sources_to_targets` would settle it.

## 6. Repo weight and orphans

- **~3.4 MB of PNG screenshots** are committed (`mob-*.png`, `smoke.png`).
  Tracked files total 5.8 MB. `.gitignore` covers only `__pycache__`, `*.pyc`,
  `.DS_Store`, so nothing stops the next batch.
- `mobile.mjs` is a real mobile smoke test that **nothing runs** — not in
  `test.mjs`, not in the workflow. Either wire it into CI or accept it as a
  manual tool; leaving it unrun is the worst of the three.
- `smoke.mjs` is likewise manual-only. `template.html` keeps a `__flotte` test
  hook for it, so the hook is shipped to production for a test that CI never
  runs.
- `formatter.py` is unreferenced by anything in the repo.

## 7. Fixed in passing, recorded here

- **`scrapper.py` did not parse** — it was a fragment whose session/nonce setup
  was missing, referencing an undefined `fresh_nonce`. A cb_map nonce expires,
  which is why it went stale. It now reads the nonce from the page on each run
  (the way `enrich.py` does), so it is safe to schedule. Verified live: 248
  stations, 265 bikes.
- **`data.json` was a Python `repr`**, not JSON — single quotes, unreadable by
  any JSON parser. It was `print(map_data)` where `json.dump` was meant.
  `scrapper.py` now writes both `data.json` and `data.md` properly.
- **The peek bar was the only untranslated copy in the app** — a hardcoded
  `{walk:' walking', bike:' by bike', transit:' by transit'}`. It now goes
  through `T()` as `pkWalk`/`pkBike`/`pkCar`/`pkTransit`, covered by
  `lang.test.mjs`'s parity checks.
- **`hours.py` was silently losing four stations' schedules.** Three German
  forms it could not parse: a dot as the minute separator (`Mo+Di 11.00 -
  17.00`), a `von` between the days and the clock (`Mo - Fr von 9-15 Uhr`),
  and `Täglich`, which names all seven days without naming one. Each cost the
  station its whole schedule, so the app showed "hours unknown" for a door
  fLotte publishes concrete times for. Parser extended; re-parsed all 257
  entries that carry text: **5 gained a schedule, 0 lost, 0 changed.** Station
  coverage 220 → 224 of 248. The independent JS verifier in `hours.test.mjs`
  needed the same two rules — it was deriving 0:00 from "11.00" — and now
  confirms all 210 exact schedules. The four are pinned by name in that suite.
- **Valhalla 429s above ~9 concurrent requests** (measured: 9 parallel all
  pass, 12 returns five 429s). Browse fired one batch per profile per 100
  stations, so adding car took it from 6 to 9 — one longer station list from
  the ceiling. There is now a shared in-flight gate, `ROAD_MAX_INFLIGHT = 8`.

## 8. Car mode: what it does not do

Valhalla's `auto` costing returns **driving time only — no parking**. For a
trip whose whole point is arriving at a cargo bike, the last five minutes of
circling for a space are real and are not counted. No fudge factor was added,
because inventing one is exactly the "fake certainty" `PRODUCT.md` rules out;
but it means car times are optimistic in a way walk and bike times are not.

The straight-line fallback (`ROAD_SPD.auto = 150` s/km ≈ 24 km/h) is
door-to-door and so is *slower* than live Valhalla auto, which is the right
direction but makes the estimated and routed numbers disagree by more for car
than for the other modes.

Measured from Alexanderplatz to the first 12 stations: median walk 75 min,
bike 23 min, car 16 min — car is ~1.4× the bike, which is an honest inner-city
Berlin result and worth keeping visible.
