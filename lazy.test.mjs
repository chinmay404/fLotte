/* Browsing asks for nothing until she opens a station.

   Ranking all 248 stations by real road time cost nine requests to decide the
   five rows shown, and it is the only call that reaches the far side of the
   city — which is where every public-server limit lives. Browsing now orders
   by straight line (instant, offline) and fetches real times for the one
   station she taps. A round is untouched: its pool IS the flagged stations
   and the visiting order needs all of their times up front.
   Run: node lazy.test.mjs                                                    */
import { fn, chunk as chunkOf, engineSrc, i18nSrc, sandbox, harness } from './testkit.mjs';

const { ok, eq, done } = harness('lazy.test.mjs');

/* ---- nextHop: the browse branch never touches the road matrix ---- */
{
  const body = fn('nextHop');
  const browse = body.slice(body.indexOf('}else{', body.indexOf('if(mission){')));
  ok(/if\(mission\)\{/.test(body), 'the fetch is now behind a round check');
  ok(!/matrix\('pedestrian', pool\)/.test(browse),
    'browsing never asks for a pedestrian matrix over the pool');
  ok(!/matrix\('bicycle', pool\)/.test(browse),
    'nor a cycling one');
  ok(/beeKm: FlotteEngine\.haversineKm/.test(browse),
    'it measures a straight line instead — no network, no server limits');
  ok(/matrix\('pedestrian', pool\)/.test(body),
    'but a round still fetches every flagged station up front');
  ok(/a\.beeKm - b\.beeKm/.test(body),
    'and the browse list is ordered by that straight line');
}

/* ---- ensureTimes: one station, on demand ---- */
{
  const asked = [];
  const sb = sandbox(['optOf', 'ensureTimes'], {
    mission: false, token: 1, timesSeq: 0, modePref: 'best', roadEstimated: false,
    LOCATIONS: [{ location_name: 'A', lat: 52.5, lon: 13.4 },
                { location_name: 'B', lat: 52.6, lon: 13.5 }],
    options: [{ i: 0, walk: null, bike: null, car: null, beeKm: 1.2 },
              { i: 1, walk: null, bike: null, car: null, beeKm: 4.8 }],
    here: () => ({ lat: 52.52, lon: 13.405, i: null }),
    beelineSec: () => 999, beelineKm: () => 9.9,
    matrix: async (costing, targets) => {
      asked.push({ costing, n: targets.length, name: targets[0].location_name });
      return [{ sec: costing === 'bicycle' ? 300 : 900, km: 1.3 }];
    },
    paint: () => {}, drawTrip: () => {}, Promise, Error,
  });

  await sb.ensureTimes(1);
  eq(asked.length, 3, 'three one-target requests, one per mode shown');
  ok(asked.every((a) => a.n === 1), 'each asks about exactly one station');
  ok(asked.every((a) => a.name === 'B'), 'and only the station she opened');
  eq(asked.map((a) => a.costing).sort(), ['auto', 'bicycle', 'pedestrian'],
    'walking, cycling and driving, because Best compares all three');
  const o = sb.options[1];
  eq(o.bike.sec, 300, 'the real times land on that option');
  ok(o.timed === true, 'and it is marked fetched');
  ok(sb.options[0].walk === null, 'the stations she did not open stay untouched');

  asked.length = 0;
  await sb.ensureTimes(1);
  eq(asked.length, 0, 'opening it again asks nothing — the times are already there');
}

/* ---- a mode she cannot see is not fetched ---- */
{
  const asked = [];
  const sb = sandbox(['optOf', 'ensureTimes'], {
    mission: false, token: 1, timesSeq: 0, modePref: 'walk', roadEstimated: false,
    LOCATIONS: [{ location_name: 'A', lat: 52.5, lon: 13.4 }],
    options: [{ i: 0, walk: null, bike: null, car: null, beeKm: 1.2 }],
    here: () => ({ lat: 52.52, lon: 13.405, i: null }),
    beelineSec: () => 999, beelineKm: () => 9.9,
    matrix: async (costing) => { asked.push(costing); return [{ sec: 600, km: 1 }]; },
    paint: () => {}, drawTrip: () => {}, Promise, Error,
  });
  await sb.ensureTimes(0);
  ok(asked.indexOf('auto') === -1, 'under Walk, no car row renders, so no car request');
}

/* ---- a round never goes through this path ---- */
{
  const asked = [];
  const sb = sandbox(['optOf', 'ensureTimes'], {
    mission: true, token: 1, timesSeq: 0, modePref: 'best', roadEstimated: false,
    LOCATIONS: [{ location_name: 'A', lat: 52.5, lon: 13.4 }],
    options: [{ i: 0, walk: { sec: 600 }, bike: null, car: null }],
    here: () => ({ lat: 52.52, lon: 13.405, i: null }),
    beelineSec: () => 1, beelineKm: () => 1,
    matrix: async () => { asked.push(1); return [{ sec: 1, km: 1 }]; },
    paint: () => {}, drawTrip: () => {}, Promise, Error,
  });
  await sb.ensureTimes(0);
  eq(asked.length, 0, 'a round already has its times — tapping fetches nothing');
}

/* ---- the road being down still degrades honestly, per station ---- */
{
  const sb = sandbox(['optOf', 'ensureTimes'], {
    mission: false, token: 1, timesSeq: 0, modePref: 'bike', roadEstimated: false,
    LOCATIONS: [{ location_name: 'A', lat: 52.5, lon: 13.4 }],
    options: [{ i: 0, walk: null, bike: null, car: null, beeKm: 2 }],
    here: () => ({ lat: 52.52, lon: 13.405, i: null }),
    beelineSec: () => 720, beelineKm: () => 2.6,
    matrix: async () => { throw new Error('roadNet'); },
    paint: () => {}, drawTrip: () => {}, Promise, Error,
  });
  await sb.ensureTimes(0);
  eq(sb.options[0].bike.sec, 720, 'a failed fetch falls back to an estimate');
  ok(sb.roadEstimated === true, 'and flags it, so the card says it is an estimate');
}

/* ---- the card shows the distance that ranked it, until the time arrives ---- */
{
  const sb = sandbox(
    ['esc', 'safeColor', 'lineColor', 'mins', 'km', 'clock', 'inMin', 'timeFor',
     'bestMode', 'transitSec', 'stripHTML', 'hintHTML', 'depHTML', 'mv', 'thumbOK',
     'isAdhoc', 'hoursToday', 'windowsFor', 'windowsCover', 'hoursLabel', 'hhmmOf',
     'optHTML'],
    {
      IC: { walk: '<W>', bike: '<B>', tram: '<T>', right: '<R>', clock: '<C>', car: '<CAR>' },
      LOCATIONS: [{ location_name: 'Kulturzentrum Staaken', street: 'Sandstr. 41',
                    district: ['Spandau'], lat: 52.535, lon: 13.155,
                    items: [{ id: 1, name: 'Ada', type: ['Cargo Bike'], thumbnail: null }] }],
      colorOf: () => '#7FC600', tourNext: () => null,
      depBaseMs: () => Date.parse('2026-09-20T10:00:00Z'), baseFuture: () => false,
      trip: [{ lat: 52.52, lon: 13.405, label: 'Start', i: null, sec: 0 }],
      defects: new Set(), repaired: new Set(), badThumb: {},
      mission: false, tour: null, ANIM: false, BOARD_ANIM: false,
      expanded: null, modePref: 'best', Date,
    }, engineSrc() + '\n' + i18nSrc() + '\n' +
       chunkOf(/var LINE_COLORS = \[[\s\S]*?\];/, 'palette'));

  const pending = sb.optHTML({ i: 0, walk: null, bike: null, car: null,
                               transit: null, selJ: 0, beeKm: 4.2 }, 0);
  ok(/opt-time num dist/.test(pending), 'an un-opened card marks its number as a distance');
  ok(/4\.2 km|4,2 km/.test(pending), 'and shows the straight-line distance', pending.slice(0, 400));

  const working = sb.optHTML({ i: 0, walk: null, bike: null, car: null,
                               transit: null, selJ: 0, beeKm: 4.2, timing: true }, 0);
  ok(/…/.test(working), 'while fetching it shows progress rather than a stale distance');

  const done_ = sb.optHTML({ i: 0, walk: { sec: 1800, km: 2.3 }, bike: { sec: 600, km: 2.4 },
                             car: null, transit: null, selJ: 0, beeKm: 4.2, timed: true }, 0);
  ok(!/opt-time num dist/.test(done_), 'once fetched the distance gives way to the time');
  ok(/10 min/.test(done_), 'which is the real cycling time', done_.slice(0, 400));
}

setTimeout(done, 50);
