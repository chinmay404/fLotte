/* The live road matrix. Valhalla's public server rejects any matrix request
   of more than 100 CELLS — sources x targets — and reports it as error 150,
   "Exceeded max locations: 100", which is not what it measures: 1x100 is
   accepted and 11x11 is refused. The browse view asks from "here" to every
   eligible station — ~250 of them. So
   matrix() must split the targets into batches under the cap, fire them in
   parallel, and stitch the answers back in target order. One failed batch
   must still fail the whole call: the caller's straight-line fallback is
   all-or-nothing, and a silently half-real list would be dishonest.        */
import { sandbox, harness, chunk } from './testkit.mjs';

const { ok, eq, done } = harness('batch.test.mjs');

/* A fetch stub whose responses are resolved by hand, so a test can see how
   many requests are in flight before any of them answers. */
function makeFetch(log) {
  return (url, opts) => {
    const rec = { body: JSON.parse(opts.body) };
    rec.promise = new Promise((res) => {
      rec.answer = (cells) => res({ ok: true, json: async () => ({ sources_to_targets: [cells] }) });
      rec.fail = (status) => res({ ok: false, status });
    });
    log.push(rec);
    return rec.promise;
  };
}

/* matrixChunk now takes a slot from the shared in-flight gate before it
   fetches, so a request reaches the stub one microtask after the call rather
   than synchronously. `tick()` is that microtask — the fan-out itself is
   unchanged, and the cap assertions below still see every request at once. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function mk(log) {
  return sandbox(['matrix', 'matrixChunk', 'roadSlot', 'roadRelease'], {
    MATRIX: null, matrixSec: () => null,
    here: () => ({ lat: 52.52, lon: 13.405, i: null }),
    beelineKm: () => 1,
    VALHALLA: 'https://valhalla.test/sources_to_targets',
    ROAD_TIMEOUT: 15000,
    fetchT: makeFetch(log),
    T: (k, v) => k + (v ? ' ' + JSON.stringify(v) : ''),
    Error,
  }, chunk(/var ROAD_MAX_INFLIGHT = \d+;\nvar roadInflight = 0, roadQueue = \[\];/, 'road gate') +
     '\n' + chunk(/var MATRIX_CELL_CAP = \d+;\nvar MATRIX_BATCH = [^;]+;/, 'MATRIX_BATCH'));
}

const stations = (n) => Array.from({ length: n }, (_, i) =>
  ({ _i: i, lat: 52 + i / 1000, lon: 13 + i / 1000 }));
const cell = (sec) => ({ time: sec, distance: sec / 240 });

/* ---- a pool at exactly the cell cap stays a single request ---- */
{
  const log = [];
  const p = mk(log).matrix('bicycle', stations(100));
  await tick();
  eq(log.length, 1, '100 targets go out as one request — 1x100 is exactly the cap');
  eq(log[0].body.targets.length, 100, 'with all 100 targets in it');
  log[0].answer(stations(100).map((_, i) => cell(i)));
  p.then((rows) => eq(rows.length, 100, 'and 100 rows come back'));
}

/* ---- a big pool is batched under Valhalla's 100-location cap ---- */
{
  const log = [];
  const p = mk(log).matrix('pedestrian', stations(248));
  await tick();
  eq(log.length, 3, '248 targets fan out into 3 requests at once (parallel, not serial)');
  ok(log.every((r) => r.body.targets.length * r.body.sources.length <= 100),
     'every request stays within the 100-cell cap (sources x targets)',
     log.map((r) => r.body.sources.length + 'x' + r.body.targets.length));
  eq(log.reduce((n, r) => n + r.body.targets.length, 0), 248,
     'no target is dropped or duplicated');
  eq(log[1].body.targets[0].lat, stations(248)[log[0].body.targets.length].lat,
     'batches partition the pool in order');
  ok(log.every((r) => r.body.costing === 'pedestrian'), 'costing reaches every batch');

  /* answer out of order: the stitched rows must still follow target order */
  log[2].answer(log[2].body.targets.map(() => cell(3000)));
  log[0].answer(log[0].body.targets.map(() => cell(1000)));
  log[1].answer(log[1].body.targets.map((_, i) => (i === 0 ? null : cell(2000))));
  p.then((rows) => {
    eq(rows.length, 248, 'stitched result covers every target');
    eq(rows[0].sec, 1000, 'first batch first');
    eq(rows[log[0].body.targets.length], null, 'a cell Valhalla could not route stays null');
    eq(rows[247].sec, 3000, 'last batch last');
    eq(rows[0].km, 1000 / 240, 'distance still rides along');
  });
}

/* ---- one failed batch fails the call, so the fallback stays honest ---- */
{
  const log = [];
  const p = mk(log).matrix('bicycle', stations(150));
  await tick();
  log[0].answer(log[0].body.targets.map(() => cell(500)));
  log[1].fail(503);
  p.then(
    () => ok(false, 'a failed batch must reject the whole matrix'),
    (e) => ok(String(e.message).indexOf('roadDown') === 0,
              'and it rejects with the roadDown message', e.message));
}

setTimeout(done, 50);
