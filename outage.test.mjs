/* When the departure service is down the app must SAY so. VBB answers 503 with
   no CORS headers and holds the socket ~30s, which the browser reports as a CORS
   error and the app used to render as "No transit route found" — sending a
   mechanic walking past a working tram.  Run: node outage.test.mjs            */
import { fn, sandbox, harness, TEMPLATE } from './testkit.mjs';

const { ok, done } = harness('outage');

let calls = [];
let responder = null;

const sb = sandbox(
  ['esc', 'safeColor', 'mins', 'km', 'clock', 'inMin', 'sleep', 'here', 'fetchT',
   'transitFor', 'transitSec', 'timeFor', 'bestMode', 'stripHTML', 'hintHTML',
   'depHTML', 'mv', 'thumbOK', 'optHTML'],
  {
    VBB: 'https://vbb.test', ALTS: 3, VBB_TIMEOUT: 50,
    IC: { walk: '<ICON-walk>', bike: '<ICON-bike>', tram: '<ICON-tram>', right: '<ICON-right>' },
    LOCATIONS: [{ location_name: 'Manege gGmbH', street: 'Rixdorfer Str. 1',
                  district: ['Neukölln'], lat: 52.403, lon: 13.525,
                  items: [{ id: 1, name: 'Alex', type: ['Rikscha'], thumbnail: null }] }],
    colorOf: () => '#7FC600', tourNext: () => null,
    depBaseMs: () => Date.parse('2026-08-17T10:00:00Z'), baseFuture: () => false,
    trip: [{ lat: 52.408, lon: 13.537, label: 'My location', i: null, sec: 0 }],
    defects: new Set(), repaired: new Set(), badThumb: {},
    mission: false, tour: null, ANIM: false, BOARD_ANIM: false,
    expanded: null, modePref: 'best',
    // a real fetch honours the abort signal; so must this one
    fetch: (url, o) => { calls.push(url); return responder(url, o); },
    AbortController, setTimeout, clearTimeout, Date,
  });

const res = (status, body) => Promise.resolve({
  ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body),
});
const card = transit => {
  sb.expanded = 0;
  return sb.optHTML({ i: 0, walk: { sec: 720, km: 0.9 }, bike: { sec: 300, km: 1.1 },
                      transit, selJ: 0 }, 0);
};

/* ---- a genuine "no route" answer ---- */
{
  responder = () => res(200, { journeys: [] });
  calls = [];
  const r = await sb.transitFor(sb.LOCATIONS[0]);
  ok(r.err === 'no route' && r.kind === 'none', 'empty journeys => kind "none"', r);
  ok(calls.length === 1, 'a definite answer is not retried', calls.length);
  const h = card(r);
  ok(h.includes('No transit route found'), 'card says no route was found');
  ok(!h.includes('Could not reach'), 'card does not blame the service');
}

/* ---- 503: the real outage from the console log ---- */
{
  responder = () => res(503, {});
  calls = [];
  const r = await sb.transitFor(sb.LOCATIONS[0]);
  ok(r.kind === 'down', '503 => kind "down", NOT "none"', r);
  ok(r.err !== 'no route', '503 is never reported as "no route"', r.err);
  ok(calls.length === 3, '503 is retried three times', calls.length);
  const h = card(r);
  ok(h.includes('Could not reach the departure service'), 'card names the service failure');
  ok(h.includes('<b>not</b> a "no route" answer'),
    'card explicitly denies it is a no-route answer');
  ok(!h.includes('No transit route found'), 'card never claims no route exists');
  ok(h.includes('Walk and bike times are'), 'card says the road times still stand');
  ok(h.includes('data-refresh="0"'), 'card offers a retry');
}

/* ---- a thrown fetch: what the browser actually did (CORS on a 503) ---- */
{
  responder = () => Promise.reject(new TypeError('Load failed'));
  calls = [];
  const r = await sb.transitFor(sb.LOCATIONS[0]);
  ok(r.kind === 'down', 'a thrown fetch => kind "down"', r);
  ok(calls.length === 3, 'a thrown fetch is retried three times', calls.length);
  ok(card(r).includes('Could not reach the departure service'),
    'a CORS failure reads as a service failure, not an absence');
}

/* ---- a hang must abort, not wait for the server ---- */
{
  responder = (url, o) => new Promise((_, rej) => {
    if (!o || !o.signal) return;                     // no signal => a real hang
    o.signal.addEventListener('abort',
      () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  });
  calls = [];
  const t0 = Date.now();
  const r = await sb.transitFor(sb.LOCATIONS[0]);
  ok(r.kind === 'down', 'a hanging request ends as "down"', r);
  ok(Date.now() - t0 < 5000, 'the request aborts on the timeout instead of hanging');
  ok(calls.length === 3, 'each abort counts as a try', calls.length);
  ok(/AbortController/.test(fn('fetchT')), 'fetchT uses an AbortController');
  ok(!/[^T]\bfetch\(/.test(TEMPLATE.replace(/return fetch\(url, o\)/, '')),
    'every network call in the app goes through fetchT');
}

/* ---- a 4xx is our problem, not an absence of routes ---- */
{
  responder = () => res(400, {});
  const r = await sb.transitFor(sb.LOCATIONS[0]);
  ok(r.kind === 'down' && /400/.test(r.err), '400 => "down", carries the status', r);
  ok(!card(r).includes('No transit route found'), '400 is not reported as no route');
}

/* ---- success still parses ---- */
{
  responder = () => res(200, { journeys: [{ legs: [
    { departure: '2026-08-17T10:05:00Z', arrival: '2026-08-17T10:20:00Z',
      line: { name: 'M1', color: { bg: '#BE1414', fg: '#fff' } },
      origin: { name: 'A' },
      destination: { name: 'B', location: { latitude: 1, longitude: 2 } },
      direction: 'Hackescher Markt' }] }] });
  const r = await sb.transitFor(sb.LOCATIONS[0]);
  ok(r.journeys && r.journeys.length === 1, 'a good answer still parses', r.err);
  ok(!r.kind, 'a good answer carries no failure kind');
  ok(card(r).includes('Departures'), 'card shows the departures board');
}

/* ---- the outage is not re-proved station by station ---- */
{
  const loop = (TEMPLATE.match(/var downStreak = 0;[\s\S]*?\n  \}/) || [''])[0];
  ok(/downStreak >= 2/.test(loop), 'nextHop short-circuits after two down stations');
  ok(/kind === 'down'\) \? downStreak \+ 1 : 0/.test(loop),
    'the streak resets on any station that answers');
  ok(/kind:'down'\}/.test(loop), 'skipped stations are marked down, not left pending');
  ok(/scanInfo && !scanInfo\.ok/.test(TEMPLATE),
    'a failed transit scan is surfaced, not silently dropped');
}

/* ---- dead thumbnails are not re-requested every repaint ---- */
{
  sb.badThumb = {};
  ok(sb.thumbOK('http://x/a.jpg'), 'an unseen thumbnail is emitted');
  sb.badThumb['http://x/a.jpg'] = true;
  ok(!sb.thumbOK('http://x/a.jpg'), 'a known-dead thumbnail is skipped');
  ok(!sb.thumbOK(null) && !sb.thumbOK(''), 'a missing thumbnail is skipped');
  ok(/naturalWidth === 0/.test(fn('wireThumbs')),
    'wireThumbs catches a failure that beat the listener');
  ok(!/onerror=/.test(TEMPLATE), 'no inline onerror attributes remain');
  ok(/data-thumb/.test(fn('tipHTML')), 'map tooltips use the shared thumbnail cache');
}

done();
