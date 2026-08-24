/* The precomputed station matrix. After hop 1 every node in the round's matrix
   is one of the known stations, so that matrix ships in the payload and the
   visiting order stops depending on a live routing service — which has now
   failed twice.  Run: node offline.test.mjs                                   */
import { fn, chunk, engineSrc, i18nSrc, sandbox, payload, harness, TEMPLATE } from './testkit.mjs';

const { ok, eq, done } = harness('offline');

/* pack a matrix the way matrix.py does: little-endian uint16, row-major */
const pack = (grid) => {
  const n = grid.length;
  const b = new Uint8Array(n * n * 2);
  let k = 0;
  for (const row of grid) for (const v of row) { b[k++] = v & 255; b[k++] = v >> 8; }
  return Buffer.from(b).toString('base64');
};

const GRID = [
  [0, 600, 1200],
  [660, 0, 900],
  [1300, 880, 0],
];
const UNREACH = [[0, 65535], [65535, 0]];

const mk = (matrix) => sandbox(['matrixFor', 'matrixSec'],
  { PAYLOAD: { matrix }, matCache: {}, atob, Uint16Array },
  chunk(/var MATRIX = PAYLOAD\.matrix \|\| null;[\s\S]*?\n\}\n/, 'matrix decode'));

/* ---- decoding ---- */
{
  const sb = mk({ n: 3, bicycle: pack(GRID) });
  const t = sb.matrixFor('bicycle');
  ok(t instanceof Uint16Array, 'decodes to a typed array');
  eq(t.length, 9, 'with one entry per ordered pair');
  eq([...t], GRID.flat(), 'and the bytes round-trip exactly');
  ok(sb.matrixFor('bicycle') === t, 'decoded once, then cached');
  eq(sb.matrixFor('pedestrian'), null, 'a profile that was not shipped is null');
}

/* ---- lookups ---- */
{
  const sb = mk({ n: 3, bicycle: pack(GRID) });
  eq(sb.matrixSec('bicycle', 0, 1), 600, 'reads a pair');
  eq(sb.matrixSec('bicycle', 1, 0), 660, 'and it is directional, not symmetric');
  eq(sb.matrixSec('bicycle', 2, 2), 0, 'a station to itself is free');
  eq(sb.matrixSec('bicycle', 0, 9), null, 'an index past the matrix is null, not garbage');
  eq(sb.matrixSec('bicycle', -1, 0), null, 'and so is a negative one');
  eq(sb.matrixSec('bicycle', null, 0), null, 'a missing index is null');
  eq(sb.matrixSec('walking', 0, 1), null, 'an unknown costing is null');
}

/* ---- the unreachable sentinel must not become a 65535-second leg ---- */
{
  const sb = mk({ n: 2, bicycle: pack(UNREACH) });
  eq(sb.matrixSec('bicycle', 0, 1), null,
    '65535 means unreachable and reads as null, never as an 18-hour ride');
}

/* ---- no matrix at all, and corrupt data, must not throw ---- */
{
  eq(mk(null).matrixFor('bicycle'), null, 'no shipped matrix is simply null');
  eq(mk({ n: 3, bicycle: '!!!not base64!!!' }).matrixFor('bicycle'), null,
    'corrupt base64 degrades to null rather than throwing');
}

/* ---- ensureTour prefers it, and only when every node is a station ---- */
{
  const body = fn('ensureTour');
  ok(/var idx = \[here\(\)\.i == null \? null : here\(\)\.i\]/.test(body),
    'node 0 is checked for being a station');
  ok(/offline = true/.test(body), 'and the plan records that it needed no network');
  ok(/if\(\(!mat \|\| !offline\) && pts\.length <= TOUR_MAX \+ 1\)/.test(body),
    'the live call is the fallback now, not the first choice');
  // per-cell, not all-or-nothing: on the first plan node 0 is her start point,
  // but every station-to-station cell is still in the shipped matrix
  ok(/row\.push\(null\); holes\+\+/.test(body),
    'a pair the matrix lacks becomes a hole, not an invented number');
  ok(/if\(filled > holes\)/.test(body),
    'the matrix is used when it supplies the bulk of the cells');
  ok(/mat\[i\]\[j\] == null\)\{ estimated = true; mat\[i\]\[j\] = est\(i, j\)/.test(body),
    'and the remaining holes are filled by estimate and labelled as such');
}

/* ---- the card times use it too, from hop 2 onward ---- */
{
  const m = fn('matrix');
  ok(/MATRIX && from\.i != null/.test(m),
    'once she is standing at a station, the call is answered from the table');
  ok(/matrixSec\(costing, from\.i, targets\[t0\]\._i\)/.test(m),
    'row = where she is, column = each candidate station');
  ok(/if\(all\) return rows;/.test(m),
    'and it only short-circuits when every target was found');
  ok(/if\(sec0 == null\)\{ all = false; break; \}/.test(m),
    'one missing pair falls through to the live call rather than inventing a time');
  ok(m.indexOf('MATRIX && from.i != null') < m.indexOf('await fetchT'),
    'the table is consulted BEFORE the network, not as a fallback');
  ok(/beelineKm\(from\.lat/.test(m),
    'distance is a beeline estimate — the table stores times, not kilometres');
}

/* ---- an off-map stop has no row, so it must fall through ---- */
{
  const sb = mk({ n: 3, bicycle: pack(GRID) });
  eq(sb.matrixSec('bicycle', 5, 1), null,
    'an ad-hoc stop appended past the matrix is not in it');
}

/* ---- what actually shipped ---- */
{
  const P = payload();
  if (P.matrix) {
    eq(P.matrix.n, P.locations.length, 'the shipped matrix covers every station');
    const sb = mk(P.matrix);
    const t = sb.matrixFor('bicycle');
    eq(t.length, P.matrix.n * P.matrix.n, 'and is the right size');
    let real = 0, self = 0;
    for (let i = 0; i < P.matrix.n; i += 11)
      for (let j = 0; j < P.matrix.n; j += 11) {
        const v = sb.matrixSec('bicycle', i, j);
        if (i === j) { if (v === 0) self++; } else if (v != null) real++;
      }
    ok(real > 100, `${real} sampled pairs have a real time`, real);
    ok(self > 0, 'and the diagonal is zero');
    const bike = sb.matrixSec('bicycle', 0, 1), foot = sb.matrixSec('pedestrian', 0, 1);
    if (bike != null && foot != null)
      ok(foot > bike, 'walking is slower than cycling — not one profile served twice',
        { bike, foot });
  } else {
    ok(true, '(no matrix in the payload yet — harvest has not been applied)');
  }
}

/* ---- the shipped matrix is what the round actually uses ---- */
{
  const P = payload();
  ok(P.matrix, 'a matrix shipped in the payload');
  const sb = mk(P.matrix);
  // a real Berlin pair should imply a sane cycling speed, or the profile is wrong
  const eng = sandbox([], {}, engineSrc());
  let checked = 0, sane = 0;
  for (const [i, j] of [[0, 1], [0, 50], [10, 200], [100, 101], [7, 180]]) {
    const a = P.locations[i], b = P.locations[j];
    const km = eng.FlotteEngine.haversineKm(a.lat, a.lon, b.lat, b.lon);
    const sec = sb.matrixSec('bicycle', i, j);
    if (sec == null || km < 1) continue;
    checked++;
    const kmh = km / (sec / 3600);          // vs crow-flies, so the real road speed is higher
    if (kmh > 6 && kmh < 20) sane++;
  }
  ok(checked > 3 && sane === checked,
    `${sane}/${checked} sampled pairs imply a plausible cycling speed`, { checked, sane });
  ok(/offline: !!tour\.offline/.test(TEMPLATE),
    'the state hook reports whether the plan needed the network');
}

done();
