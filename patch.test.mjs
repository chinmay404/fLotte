/* The tour road matrix. Valhalla's public server caps a request at 100 CELLS
   — sources x targets — and says so as "Exceeded max locations: 100", which
   is not what it counts: 1x100 passes, 11x11 does not. ensureTour used to
   send the whole (n+1)x(n+1) behind a 40-station guard, i.e. up to 1681
   cells, so for any round past 10 stations the request could not succeed; an
   empty catch then turned that certain 400 into a silent fall back to
   straight lines.

   Now it fills what the shipped station-to-station matrix already knows and
   asks only for the holes. Two things must hold for that to be safe: every
   request it plans has to be legal, and the plan has to cover every hole. */
import { sandbox, harness, chunk } from './testkit.mjs';

const { ok, eq, done } = harness('patch.test.mjs');
const CAP = 100;

const sb = sandbox(['matrixPatchPlan'], { Math },
                   chunk(/var MATRIX_CELL_CAP = \d+;/, 'MATRIX_CELL_CAP'));
const plan = sb.matrixPatchPlan;

const cells = (r) => r.sources.length * r.targets.length;
const covers = (reqs, holes) => {
  const seen = new Set();
  for (const r of reqs) for (const i of r.sources) for (const j of r.targets) seen.add(i + ':' + j);
  return holes.every(([i, j]) => seen.has(i + ':' + j));
};

/* ---- the cap really is cells, and the constant says so ---- */
{
  eq(sb.MATRIX_CELL_CAP, CAP, 'the cap the planner works to is 100 cells');
  ok(41 * 41 > CAP, 'the shape ensureTour used to send (41x41) was over it by ~17x');
  ok(1 * CAP <= CAP, 'while 1x100 — more locations, fewer cells — is legal');
}

/* ---- the first plan: node 0 is her start point, every station is known ---- */
{
  for (const n of [1, 5, 12, 40]) {
    const holes = Array.from({ length: n }, (_, k) => [0, k + 1]);
    const reqs = plan(holes);
    eq(reqs.length, 1, `a first plan over ${n} stations is one request`);
    eq(reqs[0].sources, [0], '  from her position alone');
    eq(reqs[0].targets.length, n, `  to all ${n} stations`);
    ok(cells(reqs[0]) <= CAP, '  and it fits the cap', cells(reqs[0]));
    ok(covers(reqs, holes), '  covering every hole');
  }
}

/* ---- no shipped matrix at all: the whole block, minus the dead column 0 ---- */
{
  const full = (n) => {
    const h = [];
    for (let i = 0; i <= n; i++) for (let j = 1; j <= n; j++) if (i !== j) h.push([i, j]);
    return h;
  };
  for (const n of [9, 12, 20]) {
    const holes = full(n), reqs = plan(holes);
    ok(reqs.every((r) => cells(r) <= CAP),
       `n=${n} with no matrix: every request legal`, reqs.map(cells));
    ok(covers(reqs, holes), `n=${n} with no matrix: every hole covered`);
    ok(reqs.length <= 6, `n=${n} stays inside the 6-request budget`, reqs.length);
  }
  // grouping rows into one rectangle is what buys that: per-row would be n+1
  eq(plan(full(9)).length, 1, 'n=9 is a single 10x9 = 90-cell request, not 10 of them');
}

/* ---- a row wider than the cap is chunked by target ---- */
{
  const holes = Array.from({ length: 250 }, (_, k) => [0, k + 1]);
  const reqs = plan(holes);
  ok(reqs.every((r) => cells(r) <= CAP), 'every chunk of a 250-wide row is legal',
     reqs.map(cells));
  ok(covers(reqs, holes), 'and together they still cover the row');
  eq(reqs.length, 3, '250 targets from one source is 3 requests');
}

/* ---- scattered holes, the real refresh case: a few stations went missing ---- */
{
  const holes = [[0, 1], [0, 2], [0, 3], [4, 7], [9, 7], [9, 12]];
  const reqs = plan(holes);
  ok(covers(reqs, holes), 'scattered holes are all covered');
  ok(reqs.every((r) => cells(r) <= CAP), 'and each request is legal');
  eq(reqs.length, 1, 'a handful of holes is one small rectangle');
}

/* ---- property: random hole sets never produce an illegal or lossy plan ---- */
{
  let seed = 20260919, bad = 0, missed = 0, dup = 0;
  const rnd = (m) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m);
  for (let t = 0; t < 400; t++) {
    const n = 1 + rnd(60), set = new Set();
    for (let k = 0, want = 1 + rnd(n * 3); k < want; k++) {
      const i = rnd(n + 1), j = 1 + rnd(n);
      if (i !== j) set.add(i + ':' + j);
    }
    const holes = [...set].map((s) => s.split(':').map(Number));
    if (!holes.length) continue;
    const reqs = plan(holes);
    if (!reqs.every((r) => cells(r) <= CAP)) bad++;
    if (!covers(reqs, holes)) missed++;
    if (reqs.some((r) => new Set(r.targets).size !== r.targets.length ||
                         new Set(r.sources).size !== r.sources.length)) dup++;
  }
  eq(bad, 0, '400 random hole sets: no request ever exceeds the cell cap');
  eq(missed, 0, '400 random hole sets: no hole is ever left unasked');
  eq(dup, 0, '400 random hole sets: no request repeats a source or a target');
}

done();
