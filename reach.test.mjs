/* Stations beyond a profile's reach.

   Valhalla's public server does not answer "no route" for a target that is too
   far — it rejects the WHOLE matrix with HTTP 400, error 154. Measured
   2026-09-20: 30 km on foot, 60 km by bike, 150 km by car. Berlin's stations
   span 41 km, so from an edge like Staaken 19 of the 248 are unwalkable, and
   one of them in a request loses every other answer in it. That is what put
   "Road routing is down" on screen while Valhalla was healthy — and it hits a
   five-stop repair round just as hard as a 248-station browse: a request with
   four targets, one of them 32 km away, is refused outright.

   Two rules, pinned here: never ask about a target a straight line already
   puts beyond the cap (the road is never shorter than the straight line, so
   the refusal is certain), and never report a refusal as an outage — 4xx means
   this question was unanswerable, 5xx and network failures mean the service is
   down and the honest straight-line banner belongs on screen.
   Run: node reach.test.mjs                                                   */
import { sandbox, harness, chunk, engineSrc } from './testkit.mjs';

const { ok, eq, done } = harness('reach.test.mjs');

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeFetch(log, reply) {
  return (url, opts) => {
    log.push(JSON.parse(opts.body));
    return Promise.resolve(reply());
  };
}
const okRes = (cells) => ({ ok: true, status: 200,
  json: async () => ({ sources_to_targets: cells }) });

function mk(log, reply) {
  return sandbox(['matrix', 'matrixChunk', 'matrixPatch', 'roadSlot', 'roadRelease', 'withinReach'], {
    MATRIX: null, matrixSec: () => null,
    here: () => ({ lat: 52.535, lon: 13.155, i: null }),   // Staaken, far west
    beelineKm: () => 1,
    VALHALLA: 'https://valhalla.test/sources_to_targets',
    ROAD_TIMEOUT: 15000,
    fetchT: makeFetch(log, reply),
    T: (k, v) => k + (v ? ' ' + JSON.stringify(v) : ''),
    Error,
  }, engineSrc() +
     '\n' + chunk(/var ROAD_MAX_INFLIGHT = \d+;\nvar roadInflight = 0, roadQueue = \[\];/, 'road gate') +
     '\n' + chunk(/var MATRIX_CELL_CAP = \d+;\nvar MATRIX_BATCH = [^;]+;/, 'MATRIX_BATCH') +
     '\n' + chunk(/var ROAD_MAX_KM = \{[^}]*\};/, 'ROAD_MAX_KM'));
}

/* Real Berlin geography — the distances are the point of these tests. */
const NEAR1 = { _i: 0, lat: 52.540, lon: 13.170 };   //  ~1 km from Staaken
const NEAR2 = { _i: 1, lat: 52.520, lon: 13.200 };   //  ~3 km
const EAST  = { _i: 2, lat: 52.445, lon: 13.575 };   // ~30 km — Köpenick
const HH    = { _i: 3, lat: 53.551, lon: 9.994 };    // ~255 km — Hamburg

/* ---- the caps are the ones the server actually enforces ---- */
{
  const sb = mk([], () => okRes([[]]));
  eq(sb.ROAD_MAX_KM.pedestrian, 30, 'walking is capped at 30 km');
  eq(sb.ROAD_MAX_KM.bicycle, 60, 'cycling at 60 km');
  eq(sb.ROAD_MAX_KM.auto, 150, 'driving at 150 km');
}

/* ---- a target beyond the cap is never put in the request ---- */
{
  const log = [];
  const sb = mk(log, () => okRes([[{ time: 600, distance: 1.2 }, { time: 1800, distance: 3.4 }]]));
  const rows = await sb.matrix('pedestrian', [NEAR1, NEAR2, EAST, HH]);
  await tick();
  eq(log.length, 1, 'one request went out');
  eq(log[0].targets.length, 2, 'carrying only the two walkable targets');
  eq(log[0].targets.map((t) => t.lon), [13.17, 13.2], 'the far ones were left out');
  eq(rows.length, 4, 'but the answer still lines up with every target asked for');
  eq(rows[0].sec, 600, 'the near ones carry their real times');
  eq(rows[1].sec, 1800, 'in input order, not request order');
  ok(rows[2] === null, 'Köpenick is null on foot — no route, not a guess');
  ok(rows[3] === null, 'and so is Hamburg');
}

/* ---- the same targets are fine on a profile that reaches further ---- */
{
  const log = [];
  const sb = mk(log, () => okRes([[{ time: 300 }, { time: 900 }, { time: 7000 }]]));
  const rows = await sb.matrix('bicycle', [NEAR1, NEAR2, EAST, HH]);
  await tick();
  eq(log[0].targets.length, 3, 'cycling reaches 60 km, so Köpenick is asked about');
  ok(rows[2] !== null && rows[2].sec === 7000, 'and it comes back with a real time');
  ok(rows[3] === null, 'Hamburg is still past the 60 km cycling cap');
}

/* ---- every target out of reach means no request at all ---- */
{
  const log = [];
  const sb = mk(log, () => okRes([[]]));
  const rows = await sb.matrix('pedestrian', [HH]);
  await tick();
  eq(log.length, 0, 'a pool with nothing in reach never touches the network');
  eq(rows, [null], 'and answers null rather than pretending');
}

/* ---- a refusal is not an outage ---- */
{
  const log = [];
  const sb = mk(log, () => ({ ok: false, status: 400,
    json: async () => ({ error_code: 154, error: 'Path distance exceeds the max distance limit' }) }));
  const rows = await sb.matrix('pedestrian', [NEAR1, NEAR2]);
  await tick();
  eq(rows, [null, null],
    'a 400 leaves those cells empty instead of failing the whole matrix');
}
{
  const sb = mk([], () => ({ ok: false, status: 503, json: async () => ({}) }));
  let threw = null;
  try { await sb.matrix('pedestrian', [NEAR1]); } catch (e) { threw = e; }
  ok(threw && String(threw.message).indexOf('roadDown') === 0,
    'a 503 still throws, so the straight-line banner is still honest', threw && threw.message);
}
{
  const sb = sandbox(['matrix', 'matrixChunk', 'matrixPatch', 'roadSlot', 'roadRelease', 'withinReach'], {
    MATRIX: null, matrixSec: () => null,
    here: () => ({ lat: 52.535, lon: 13.155, i: null }),
    beelineKm: () => 1, VALHALLA: 'https://valhalla.test/s', ROAD_TIMEOUT: 50,
    fetchT: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    T: (k) => k, Error,
  }, engineSrc() +
     '\n' + chunk(/var ROAD_MAX_INFLIGHT = \d+;\nvar roadInflight = 0, roadQueue = \[\];/, 'gate') +
     '\n' + chunk(/var MATRIX_CELL_CAP = \d+;\nvar MATRIX_BATCH = [^;]+;/, 'batch') +
     '\n' + chunk(/var ROAD_MAX_KM = \{[^}]*\};/, 'caps'));
  let threw = null;
  try { await sb.matrix('bicycle', [NEAR1]); } catch (e) { threw = e; }
  eq(threw && threw.message, 'roadTimeout', 'and a timeout is still a timeout');
}

/* ---- the round's patch path refuses the same way, and must not die of it ---- */
{
  const sb = mk([], () => ({ ok: false, status: 400, json: async () => ({ error_code: 154 }) }));
  const pts = [NEAR1, NEAR2, EAST];
  const rows = await sb.matrixPatch('pedestrian', pts, { sources: [0, 1], targets: [2] });
  eq(rows.length, 2, 'a refused patch still answers with the shape asked for');
  ok(rows.every((r) => r.length === 1 && r[0] === null),
    'filled with empty cells, so the tour estimates those legs instead of failing');
}
{
  const sb = mk([], () => ({ ok: false, status: 502, json: async () => ({}) }));
  let threw = null;
  try { await sb.matrixPatch('bicycle', [NEAR1, NEAR2], { sources: [0], targets: [1] }); }
  catch (e) { threw = e; }
  ok(threw, 'but a 502 on the patch path still throws');
}

setTimeout(done, 60);
