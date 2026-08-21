/* Tests for the pure routing engine embedded in template.html.
   The engine lives between ENGINE-START / ENGINE-END markers so it can be
   extracted and run here without a DOM.  Run:  node engine.test.mjs  */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
const m = html.match(/\/\*ENGINE-START\*\/([\s\S]*?)\/\*ENGINE-END\*\//);
if (!m) { console.error('FAIL: no ENGINE-START/ENGINE-END block in template.html'); process.exit(1); }
const sandbox = {};
runInNewContext(m[1] + '\nthis.Engine = FlotteEngine;', sandbox);
const E = sandbox.Engine;

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name, detail == null ? '' : JSON.stringify(detail)); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }

/* deterministic PRNG so failures reproduce */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randMatrix(n, rnd) {          // (n+1)x(n+1), node 0 = start, asymmetric
  const mat = [];
  for (let i = 0; i <= n; i++) {
    mat.push([]);
    for (let j = 0; j <= n; j++) mat[i].push(i === j ? 0 : 60 + Math.floor(rnd() * 3000));
  }
  return mat;
}
function pathCost(mat, order) {
  let c = 0, prev = 0;
  for (const nxt of order) { c += mat[prev][nxt]; prev = nxt; }
  return c;
}
function bruteBest(mat, n) {           // exact optimum by enumeration, n <= 8
  const nodes = Array.from({ length: n }, (_, k) => k + 1);
  let best = Infinity;
  (function perm(rest, order) {
    if (!rest.length) { best = Math.min(best, pathCost(mat, order)); return; }
    for (let k = 0; k < rest.length; k++)
      perm(rest.slice(0, k).concat(rest.slice(k + 1)), order.concat(rest[k]));
  })(nodes, []);
  return best;
}
function nnCost(mat, n) {              // greedy nearest-next, the behaviour being replaced
  const left = new Set(Array.from({ length: n }, (_, k) => k + 1));
  let cur = 0, c = 0;
  while (left.size) {
    let best = null;
    for (const j of left) if (best === null || mat[cur][j] < mat[cur][best]) best = j;
    c += mat[cur][best]; left.delete(best); cur = best;
  }
  return c;
}

/* ---- tourOrder ---- */
eq(E.tourOrder([[0]]), [], 'tourOrder: empty');
eq(E.tourOrder([[0, 5], [5, 0]]), [1], 'tourOrder: single');

{ // hand-built: optimal open path is 0->2->1->3 (cost 1+1+1), greedy takes 0->1 first (2+...)
  const mat = [
    [0, 2, 1, 9],
    [9, 0, 9, 1],
    [9, 1, 0, 9],
    [9, 9, 9, 0]];
  eq(E.tourOrder(mat), [2, 1, 3], 'tourOrder: beats greedy on crafted matrix');
}

{ // exactness: Held-Karp must equal brute force on every small random instance
  let allExact = true, bad = null;
  for (let seed = 1; seed <= 120; seed++) {
    const rnd = mulberry32(seed);
    const n = 2 + Math.floor(rnd() * 6);          // 2..7
    const mat = randMatrix(n, rnd);
    const order = E.tourOrder(mat);
    const isPerm = order.length === n && new Set(order).size === n &&
      order.every(x => x >= 1 && x <= n);
    if (!isPerm || pathCost(mat, order) !== bruteBest(mat, n)) {
      allExact = false; bad = { seed, n, order }; break;
    }
  }
  ok(allExact, 'tourOrder: exact vs brute force, 120 random instances', bad);
}

{ // large n falls back to heuristic: still a valid permutation, never worse than greedy
  let allGood = true, bad = null;
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = mulberry32(1000 + seed);
    const n = 13 + Math.floor(rnd() * 12);        // 13..24
    const mat = randMatrix(n, rnd);
    const order = E.tourOrder(mat);
    const isPerm = order.length === n && new Set(order).size === n;
    if (!isPerm || pathCost(mat, order) > nnCost(mat, n)) {
      allGood = false; bad = { seed, n, cost: pathCost(mat, order), nn: nnCost(mat, n) }; break;
    }
  }
  ok(allGood, 'tourOrder: heuristic n>12 is a permutation and <= greedy', bad);
}

/* ---- tourCost ---- */
{
  const mat = [[0, 2, 1], [9, 0, 4], [9, 3, 0]];
  eq(E.tourCost(mat, [2, 1]), 4, 'tourCost: sums legs from start');
}

/* ---- haversineKm ---- */
{
  const d = E.haversineKm(52.5200, 13.4050, 52.5075, 13.4040); // ~1.39 km N-S
  ok(Math.abs(d - 1.39) < 0.05, 'haversineKm: Alexanderplatz -> Spittelmarkt ~1.4 km', d);
  ok(E.haversineKm(52.52, 13.405, 52.52, 13.405) === 0, 'haversineKm: zero distance');
}

/* ---- transitCandidates ---- */
{
  const reachable = [
    { duration: 5, stations: [{ location: { latitude: 52.5000, longitude: 13.4000 } }] },
    { duration: 20, stations: [{ location: { latitude: 52.5500, longitude: 13.5000 } }] }
  ];
  const stations = [
    { i: 7, lat: 52.5018, lon: 13.4000 },   // ~200 m from the 5-min stop
    { i: 8, lat: 52.6500, lon: 13.9000 },   // near nothing
    { i: 9, lat: 52.5527, lon: 13.5000 }    // ~300 m from the 20-min stop
  ];
  const all = E.transitCandidates(reachable, stations, { cutoffSec: 3600, maxKm: 0.5, k: 5, exclude: [] });
  eq(all.map(c => c.i), [7, 9], 'transitCandidates: ranks by bucket + walk, drops unreachable');
  ok(all[0].estSec > 300 && all[0].estSec < 500, 'transitCandidates: estimate = bucket + walk time', all[0]);

  const cut = E.transitCandidates(reachable, stations, { cutoffSec: 1000, maxKm: 0.5, k: 5, exclude: [] });
  eq(cut.map(c => c.i), [7], 'transitCandidates: cutoff removes slow estimates');

  const excl = E.transitCandidates(reachable, stations, { cutoffSec: 3600, maxKm: 0.5, k: 5, exclude: [7] });
  eq(excl.map(c => c.i), [9], 'transitCandidates: exclude list respected');

  const capped = E.transitCandidates(reachable, stations, { cutoffSec: 3600, maxKm: 0.5, k: 1, exclude: [] });
  eq(capped.length, 1, 'transitCandidates: k caps results');
}

/* ---- projectedArrivalMs ---- */
{
  const now = 1700000000000;
  const iso = ms => new Date(ms).toISOString();
  eq(E.projectedArrivalMs([{ sec: 0 }], now), now, 'projected: start only = now');
  eq(E.projectedArrivalMs([{ sec: 0 }, { mode: 'walk', sec: 600 }], now), now + 600e3,
    'projected: walk adds duration');
  eq(E.projectedArrivalMs([{ sec: 0 }, { mode: 'transit', arr: iso(now + 1800e3), rideSec: 900 }], now),
    now + 1800e3, 'projected: future transit arrival is authoritative');
  eq(E.projectedArrivalMs([{ sec: 0 }, { mode: 'transit', arr: iso(now - 3600e3), rideSec: 900 }], now),
    now + 900e3, 'projected: stale transit falls back to ride time');
  eq(E.projectedArrivalMs([
    { sec: 0 },
    { mode: 'walk', sec: 600 },
    { mode: 'transit', arr: iso(now + 2000e3), rideSec: 400 }
  ], now), now + 2000e3, 'projected: chain walk then valid transit');

  /* ---- goMs: travel already ridden is read off the clock, not re-charged ---- */
  {
    const go = now - 1500e3;                       // set off 25 min ago
    const at = { mode: 'bike', sec: 720, goMs: go, i: 7 };   // 12 min ride, arrived 13 min ago
    eq(E.projectedArrivalMs([{ sec: 0 }, at], now), now,
      'goMs: travel already finished is not re-charged to now');
    // still riding: the projected arrival is measured from when she set off
    eq(E.projectedArrivalMs([{ sec: 0 },
      { mode: 'bike', sec: 720, goMs: now - 120e3, i: 7 }], now), now - 120e3 + 720e3,
      'goMs: a ride in progress lands at goMs + duration');
    // without a goMs stamp the from-now projection still applies
    eq(E.projectedArrivalMs([{ sec: 0 }, { mode: 'bike', sec: 720, i: 7 }], now),
      now + 720e3, 'goMs: absent stamp falls back to projecting from now');
    // a later hop's own stamp supersedes the clamped cursor from the hop before
    eq(E.projectedArrivalMs([{ sec: 0 },
      { mode: 'bike', sec: 720, goMs: now - 5400e3, i: 7 },      // rode 90 min ago
      { mode: 'bike', sec: 600, goMs: now - 2400e3, i: 8 }       // rode 40 min ago
    ], now), now,
      'goMs: each committed hop re-anchors, so earlier legs do not stack up');
    // no repair-time estimate: standing at a stop with bikes open still reads
    // "you can set off now", because Done is what tells us work has finished
    eq(E.projectedArrivalMs([{ sec: 0 }, at], now), now,
      'no dwell is invented for time spent at a stop');
  }
  ok(E.projectedArrivalMs([{ sec: 0 }, { mode: 'bike', sec: 60, goMs: now - 9e8 }], now) >= now,
    'projected: never returns a moment in the past');
  eq(E.projectedArrivalMs.length, 2, 'projectedArrivalMs takes (trip, nowMs) only');
}

/* ---- feasibleAt: wait if early, refuse if shut ---- */
{
  const W = [[600, 1200]];                       // open 600s..1200s from departure
  eq(E.feasibleAt(700, W), 700, 'feasibleAt: inside the window, arrive as you are');
  eq(E.feasibleAt(100, W), 600, 'feasibleAt: early means you wait for opening');
  eq(E.feasibleAt(1201, W), null, 'feasibleAt: after closing there is no way in');
  eq(E.feasibleAt(1200, W), 1200, 'feasibleAt: bang on closing still counts');
  eq(E.feasibleAt(9e9, null), 9e9, 'feasibleAt: no published hours = always open');
  const split = [[0, 300], [900, 1500]];         // a lunch break
  eq(E.feasibleAt(400, split), 900, 'feasibleAt: falls through to the later shift');
  eq(E.feasibleAt(200, split), 200, 'feasibleAt: the earlier shift is used when open');
}

/* ---- tourOrderTW ---- */
{
  // no windows at all: it must behave like the travel-only solver
  const mat = [[0, 2, 1, 9], [9, 0, 9, 1], [9, 1, 0, 9], [9, 9, 9, 0]];
  const tw = E.tourOrderTW(mat, null);
  eq(tw.order, [2, 1, 3], 'tourOrderTW: with no hours it matches tourOrder');
  eq(tw.dropped, [], 'tourOrderTW: nothing dropped when everything is open');
  eq(tw.finish, 3, 'tourOrderTW: finish is the arrival at the last stop');

  // a window forces a different order than pure distance would pick
  //   node 1 is nearest but shuts at 5; node 2 is further but open all day
  const m2 = [[0, 10, 20], [10, 0, 10], [20, 10, 0]];
  const late = E.tourOrderTW(m2, [null, [[0, 5]], null]);
  eq(late.order, [2], 'tourOrderTW: a stop that shuts too early is left out');
  eq(late.dropped, [1], 'tourOrderTW: and is reported as dropped, not silently lost');

  // widen that window and both fit, nearest-first
  const both = E.tourOrderTW(m2, [null, [[0, 3600]], null]);
  eq(both.order, [1, 2], 'tourOrderTW: with the door open it serves both');
  eq(both.finish, 20, 'tourOrderTW: finish counts the whole chain');

  // waiting: a stop that opens late should be visited after the other
  const m3 = [[0, 10, 10], [10, 0, 10], [10, 10, 0]];
  const wait = E.tourOrderTW(m3, [null, [[1000, 2000]], [[0, 2000]]]);
  eq(wait.order, [2, 1], 'tourOrderTW: visits the open stop first and waits for the late one');
  eq(wait.finish, 1000, 'tourOrderTW: finish includes the wait');

  // serving more stops beats finishing sooner
  const m4 = [[0, 1, 1], [1, 0, 1], [1, 1, 0]];
  const more = E.tourOrderTW(m4, [null, null, null]);
  eq(more.order.length, 2, 'tourOrderTW: prefers serving every reachable stop');

  eq(E.tourOrderTW([[0]], null).order, [], 'tourOrderTW: empty round');
  eq(E.tourOrderTW([[0, 5], [5, 0]], null).order, [1], 'tourOrderTW: single stop');
  eq(E.tourOrderTW([[0, 5], [5, 0]], [null, [[0, 1]]]).dropped, [1],
    'tourOrderTW: single unreachable stop is dropped');
}

/* ---- exactness: TW solver must equal brute force on random instances ---- */
{
  function bestBrute(mat, win, n) {
    const nodes = Array.from({ length: n }, (_, k) => k + 1);
    let bestServed = -1, bestFinish = Infinity;
    (function perm(rest, order) {
      if (!rest.length) {
        const r = E.walkTW(mat, win, order);
        if (r.order.length > bestServed ||
           (r.order.length === bestServed && r.finish < bestFinish)) {
          bestServed = r.order.length; bestFinish = r.finish;
        }
        return;
      }
      for (let k = 0; k < rest.length; k++)
        perm(rest.slice(0, k).concat(rest.slice(k + 1)), order.concat(rest[k]));
    })(nodes, []);
    return { served: bestServed, finish: bestFinish };
  }
  let exact = true, bad = null;
  for (let seed = 1; seed <= 90 && exact; seed++) {
    const rnd = mulberry32(seed * 7919);
    const n = 2 + Math.floor(rnd() * 5);                 // 2..6
    const mat = randMatrix(n, rnd);
    const win = [null];
    for (let k = 1; k <= n; k++) {
      if (rnd() < 0.3) { win.push(null); continue; }     // some have no hours
      const open = Math.floor(rnd() * 3000);
      win.push([[open, open + 500 + Math.floor(rnd() * 6000)]]);
    }
    const got = E.tourOrderTW(mat, win);
    const want = bestBrute(mat, win, n);
    if (got.order.length !== want.served || got.finish !== want.finish) {
      exact = false;
      bad = { seed, n, got: { served: got.order.length, finish: got.finish }, want };
    }
  }
  ok(exact, 'tourOrderTW: exact vs brute force, 90 random windowed instances', bad);
}

/* ---- big rounds fall back to the heuristic but stay honest ---- */
{
  let sane = true, bad = null;
  for (let seed = 1; seed <= 20 && sane; seed++) {
    const rnd = mulberry32(5000 + seed);
    const n = 13 + Math.floor(rnd() * 6);
    const mat = randMatrix(n, rnd);
    const win = [null];
    for (let k = 1; k <= n; k++)
      win.push(rnd() < 0.4 ? null : [[0, 2000 + Math.floor(rnd() * 20000)]]);
    const r = E.tourOrderTW(mat, win);
    const seen = new Set(r.order);
    const replay = E.walkTW(mat, win, r.order);
    if (seen.size !== r.order.length ||
        r.order.length + r.dropped.length !== n ||
        replay.order.length !== r.order.length ||
        replay.finish !== r.finish) {
      sane = false; bad = { seed, n, order: r.order, dropped: r.dropped };
    }
  }
  ok(sane, 'tourOrderTW: heuristic returns a replayable, fully-accounted plan', bad);
}

console.log(failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
