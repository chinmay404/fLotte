/* Transitous is the third departure-service fallback. It speaks MOTIS, not
   HAFAS, so vbbGet hands its requests to a translator that returns responses
   already in the shape transitFor / transitScan / the search box read — the
   consumers never learn a third dialect exists. These tests pin the dialect
   translation against real api.transitous.org response shapes (captured
   2026-09-20) and the request mapping, and prove the host chain reaches it.
   Run: node transitous.test.mjs                                             */
import { fn, engineSrc, sandbox, harness } from './testkit.mjs';

const { ok, eq, done } = harness('transitous.test.mjs');

let calls = [];
let responder = null;

const sb = sandbox(
  ['vbbGet', 'transitousGet', 'parseQuery', 'decodePolyline',
   'motisJourneys', 'motisReachable', 'motisLocations', 'fetchT'],
  {
    VBB_HOSTS: ['https://vbb.test', 'https://bvg.test', 'https://transitous.test'],
    vbbHost: null, vbbLimited: true,
    fetch: (url, o) => { calls.push(url); return responder(url, o); },
    AbortController, setTimeout, clearTimeout, Date, encodeURIComponent,
    decodeURIComponent, Error,
  }, engineSrc());

const res = (status, body) => Promise.resolve({
  ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body),
});

/* ---- the polyline decoder, both precisions ---- */
{
  eq(sb.decodePolyline('_p~iF~ps|U_ulLnnqC', 5),
     [[38.5, -120.2], [40.7, -120.95]],
     'decodes the canonical precision-5 example');
  eq(sb.decodePolyline('AA', 7), [[1e-7, 1e-7]],
     'honours precision 7 (MOTIS default)');
}

/* ---- journeys: MOTIS itineraries become HAFAS-shaped journeys ---- */
{
  const motis = { itineraries: [{ startTime: 'T1', endTime: 'T2', legs: [
    { mode: 'WALK', startTime: '2026-09-20T10:51:00Z',
      scheduledStartTime: '2026-09-20T10:51:00Z', endTime: '2026-09-20T10:55:00Z',
      distance: 100, from: { name: 'START', lat: 52.52, lon: 13.405, track: null },
      to: { name: 'Spandauer Str.', lat: 52.5204, lon: 13.4055 },
      legGeometry: { points: 'AA', precision: 7 } },
    { mode: 'TRAM', routeShortName: 'M6', headsign: 'Mitte, Am Kupfergraben',
      routeColor: 'BE1414', routeTextColor: 'FFFFFF',
      startTime: '2026-09-20T10:56:30Z', scheduledStartTime: '2026-09-20T10:55:00Z',
      endTime: '2026-09-20T10:58:00Z',
      from: { name: 'Spandauer Str.', lat: 52.5204, lon: 13.4055, track: 'Pos. 3' },
      to: { name: 'S Hackescher Markt', lat: 52.5225, lon: 13.4031 } },
  ] }] };
  const out = sb.motisJourneys(motis);
  eq(out.journeys.length, 1, 'one itinerary, one journey');
  const [walk, tram] = out.journeys[0].legs;
  ok(walk.walking === true && tram.walking === false, 'WALK mode maps to the walking flag');
  eq(tram.line, { name: 'M6', color: { bg: '#BE1414', fg: '#FFFFFF' } },
     'line name and #-prefixed colours');
  ok(walk.line === null, 'a walk has no line');
  eq(tram.departureDelay, 90, 'delay derived from scheduled vs real start, in seconds');
  ok(walk.departureDelay === null, 'an on-time leg has no delay, not zero');
  eq(tram.departurePlatform, 'Pos. 3', 'platform comes from from.track');
  eq(tram.direction, 'Mitte, Am Kupfergraben', 'headsign becomes direction');
  eq(walk.departure, '2026-09-20T10:51:00Z', 'leg departure/arrival are the times');
  eq(tram.destination, { name: 'S Hackescher Markt',
     location: { latitude: 52.5225, longitude: 13.4031 } },
     'destination carries the location transitFor reads endLat/endLon from');
  eq(walk.polyline.features.map(f => f.geometry.coordinates), [[1e-7, 1e-7]],
     'shape is GeoJSON-style [lon,lat], like HAFAS polylines');
  ok(tram.polyline === null, 'a leg without geometry has no polyline');
}

/* ---- reachable: one-to-all buckets by minute, engine-compatible ---- */
{
  const motis = { one: {}, all: [
    { place: { name: 'A', stopId: 's1', lat: 52.52, lon: 13.41 }, duration: 12 },
    { place: { name: 'B', stopId: 's2', lat: 52.53, lon: 13.42 }, duration: 12 },
    { place: { name: 'C', stopId: 's3', lat: 52.54, lon: 13.43 }, duration: 3 },
    { place: { name: 'no coords' }, duration: 5 },
  ] };
  const out = sb.motisReachable(motis);
  const twelve = out.reachable.filter(b => b.duration === 12)[0];
  eq(out.reachable.length, 2, 'stops group into minute buckets, coordless ones dropped');
  eq(twelve.stations.length, 2, 'both 12-minute stops share a bucket');
  eq(twelve.stations[0].location, { latitude: 52.52, longitude: 13.41 },
     'stations carry location.latitude/longitude for transitCandidates');
  const cands = sb.FlotteEngine.transitCandidates(out.reachable,
    [{ i: 7, lat: 52.5401, lon: 13.4301 }], { cutoffSec: 1200, maxKm: 0.5, k: 3, exclude: [] });
  eq(cands.length, 1, 'the engine consumes the translated buckets unchanged');
}

/* ---- locations: geocode results become search suggestions ---- */
{
  const motis = [
    { type: 'STOP', name: 'S+U Alexanderplatz', lat: 52.5215, lon: 13.4112 },
    { type: 'ADDRESS', name: 'Alexanderstr. 1', lat: 52.52, lon: 13.42 },
    { type: 'PLACE', name: 'Alexa', lat: 52.51, lon: 13.41 },
  ];
  const out = sb.motisLocations(motis, 2);
  eq(out.length, 2, 'the results cap is applied');
  eq(out[0], { type: 'stop', name: 'S+U Alexanderplatz',
               location: { latitude: 52.5215, longitude: 13.4112 } },
     'STOP maps to the lowercase type the search box branches on');
  eq(out[1].type, 'location', 'everything else is a plain location');
}

/* ---- request mapping: HAFAS paths become MOTIS URLs ---- */
{
  responder = () => res(200, { itineraries: [] });
  calls = [];
  await sb.transitousGet('https://transitous.test',
    '/journeys?from.latitude=52.52&from.longitude=13.405&from.address=Start' +
    '&to.latitude=52.45&to.longitude=13.32&to.address=Stop&results=3' +
    '&stopovers=false&polylines=true&departure=2026-09-20T11%3A00%3A00.000Z', 50);
  ok(calls[0].startsWith('https://transitous.test/api/v1/plan?fromPlace=52.52,13.405&toPlace=52.45,13.32'),
     'journeys become /plan with fromPlace/toPlace', calls[0]);
  ok(calls[0].includes('numItineraries=3'), 'results becomes numItineraries');
  ok(calls[0].includes('time=2026-09-20T11%3A00%3A00.000Z'), 'departure becomes time');

  /* MOTIS treats the count as a floor and can return more; the wrapper treats
     it as a ceiling. The card must not show more alternatives on a fallback. */
  calls = [];
  responder = () => res(200, { itineraries: [1,2,3,4,5,6,7,8].map(() => ({ legs: [] })) });
  const capped = await sb.transitousGet('https://transitous.test',
    '/journeys?from.latitude=1&from.longitude=2&to.latitude=3&to.longitude=4&results=3', 50);
  eq((await capped.json()).journeys.length, 3, 'eight itineraries are capped to the three asked for');

  calls = [];
  responder = () => res(200, { one: {}, all: [] });
  await sb.transitousGet('https://transitous.test',
    '/stops/reachable-from?latitude=52.52&longitude=13.405&address=Start' +
    '&maxDuration=30&maxTransfers=2', 50);
  ok(calls[0].startsWith('https://transitous.test/api/experimental/one-to-all?one=52.52,13.405'),
     'reachable-from becomes one-to-all', calls[0]);
  ok(calls[0].includes('maxTravelTime=30') && calls[0].includes('maxTransfers=2'),
     'maxDuration and maxTransfers ride along');

  calls = [];
  responder = () => res(200, []);
  await sb.transitousGet('https://transitous.test',
    '/locations?query=Alexanderplatz%20Bhf&results=5&addresses=true&poi=true&stops=true', 50);
  ok(calls[0].startsWith('https://transitous.test/api/v1/geocode?text=Alexanderplatz%20Bhf'),
     'locations becomes geocode with the query intact', calls[0]);

  calls = [];
  responder = () => res(503, {});
  const r = await sb.transitousGet('https://transitous.test', '/journeys?from.latitude=1&from.longitude=2&to.latitude=3&to.longitude=4', 50);
  eq(r.status, 503, 'a failing MOTIS response passes its status through untranslated');
}

/* ---- the host chain: both HAFAS hosts dead, Transitous answers ---- */
{
  responder = (url) => url.indexOf('transitous.test') !== -1
    ? res(200, { itineraries: [] })
    : Promise.reject(new Error('down'));
  calls = [];
  sb.vbbHost = null; sb.vbbLimited = true;
  const r = await sb.vbbGet('/journeys?from.latitude=52.52&from.longitude=13.405&to.latitude=52.45&to.longitude=13.32&results=3', 50);
  ok(r.ok, 'vbbGet falls through both dead HAFAS hosts to Transitous');
  eq((await r.json()).journeys, [], 'and the answer is already HAFAS-shaped');
  eq(sb.vbbHost, 'https://transitous.test', 'the answering host is latched');
  eq(sb.vbbLimited, false, 'Transitous covers the whole region — not Berlin-limited');
}

setTimeout(done, 50);
