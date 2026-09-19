/* Car as a fourth travel mode, and the in-flight gate it made necessary.

   Valhalla's public server answers 429 once too many requests are in flight
   (measured: 9 parallel pass, 12 return five 429s). Browse already fired one
   batch per profile per 100 stations — two profiles, three batches, six in
   flight — so a third profile took it to nine, one bad station refresh away
   from the ceiling. The gate caps it; these tests hold both the mode and the
   cap honest.                                                               */
import { fn, chunk, sandbox, harness, TEMPLATE } from './testkit.mjs';

const { ok, eq, done } = harness('car.test.mjs');

/* ---- timeFor / bestMode know about car ---- */
{
  const sb = sandbox(['timeFor', 'bestMode'], { transitSec: (o) => o._t ?? null });
  const o = (walk, bike, car, t) => ({
    walk: walk == null ? null : { sec: walk }, bike: bike == null ? null : { sec: bike },
    car: car == null ? null : { sec: car }, _t: t ?? null });

  eq(sb.timeFor(o(900, 600, 300), 'car'), 300, 'car time is read from o.car');
  eq(sb.timeFor(o(900, 600, null), 'car'), null, 'and is null when not fetched');
  eq(sb.timeFor(o(900, 600, 300), 'best'), 300, 'best considers the car time');
  eq(sb.timeFor(o(900, 600, null, 1200), 'best'), 600, 'and copes when car is absent');
  eq(sb.timeFor(o(null, null, null), 'best'), null, 'no mode at all stays null');

  eq(sb.bestMode(o(900, 600, 300)), 'car', 'a faster car wins Best');
  eq(sb.bestMode(o(900, 300, 600)), 'bike', 'a faster bike still wins');
  /* ties break toward the mode that needs least: the bike is the thing being
     fetched, a car has to be parked at the far end */
  eq(sb.bestMode(o(600, 600, 600)), 'bike', 'a three-way tie goes to the bike');
  eq(sb.bestMode(o(600, null, 600)), 'walk', 'walk beats car on a tie');
  eq(sb.bestMode(o(null, null, 600, 600)), 'car', 'car beats transit on a tie');
}

/* ---- one mode -> costing map, not four inlined ternaries ---- */
{
  const sb = sandbox(['costingOf'], {});
  eq(sb.costingOf('walk'), 'pedestrian', 'walk maps to the pedestrian profile');
  eq(sb.costingOf('bike'), 'bicycle', 'bike maps to the bicycle profile');
  eq(sb.costingOf('car'), 'auto', 'car maps to Valhalla\'s auto profile');
  eq(sb.costingOf('best'), 'bicycle', 'anything else falls back to bicycle');
}

/* ---- the shipped matrix has no car profile, so car must go live ---- */
{
  const sb = sandbox(['matrixFor', 'matrixSec'], {
    MATRIX: { n: 2, bicycle: 'AAAA', pedestrian: 'AAAA' }, matCache: {}, atob: (x) => x });
  eq(sb.matrixFor('auto'), null, 'there is no car matrix to read');
  eq(sb.matrixSec('auto', 0, 1), null,
    'so a car leg reports no offline answer and falls through to routing');
}

/* ---- the beeline speed is door-to-door, not a motorway figure ---- */
{
  const sb = sandbox(['beelineSec', 'beelineKm'], {
    FlotteEngine: { haversineKm: () => 5 } },
    chunk(/var DETOUR = [\d.]+;/, 'DETOUR') + '\n' +
    chunk(/var ROAD_SPD = \{[^}]*\};/, 'ROAD_SPD'));
  const carMin = sb.beelineSec(0, 0, 0, 0, 'auto') / 60;
  const bikeMin = sb.beelineSec(0, 0, 0, 0, 'bicycle') / 60;
  ok(carMin < bikeMin, 'a car beats a bike over 5km', { carMin, bikeMin });
  ok(carMin > 10 && carMin < 25,
     `${carMin.toFixed(0)} min for 6.5 road-km is urban-Berlin plausible, not motorway`);
}

/* ---- the gate never lets more than the cap run at once ---- */
{
  const src = chunk(/var ROAD_MAX_INFLIGHT = \d+;\nvar roadInflight = 0, roadQueue = \[\];/, 'gate');
  const sb = sandbox(['roadSlot', 'roadRelease'], { Promise, setTimeout }, src);
  const CAP = sb.ROAD_MAX_INFLIGHT;
  ok(CAP > 0 && CAP < 12, `the cap (${CAP}) sits under the 429 ceiling we measured at 12`);

  let live = 0, peak = 0, ran = 0;
  const job = async () => {
    await sb.roadSlot();
    live++; ran++; if (live > peak) peak = live;
    await new Promise((r) => setTimeout(r, 1));   // stand in for the request
    live--;
    sb.roadRelease();
  };
  Promise.all(Array.from({ length: 30 }, job)).then(() => {
    eq(peak, CAP, `30 queued requests never exceed ${CAP} in flight`);
    eq(ran, 30, 'and every one of them still runs');
    eq(sb.roadInflight, 0, 'the gate drains back to empty, so it cannot deadlock later');
    eq(sb.roadQueue.length, 0, 'with nothing left waiting');
    done();
  });
}
