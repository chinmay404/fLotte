/* When the road router is down the app must degrade, not die. Valhalla is a
   free public service with no uptime guarantee; it has returned 502 and 504
   during this project. Everything except the travel times still works, so the
   list must still appear — labelled.  Run: node fallback.test.mjs            */
import { fn, chunk, engineSrc, i18nSrc, sandbox, harness, TEMPLATE } from './testkit.mjs';

const { ok, eq, done } = harness('fallback');

// pull the real constants out of the source rather than restating them here
const sb = sandbox(['beelineKm', 'beelineSec'], {},
  engineSrc() + '\n' + i18nSrc() + '\n'
  + chunk(/var DETOUR = [\s\S]*?ROAD_SPD = \{[^}]*\};/, 'road constants'));

/* ---- the estimator ---- */
{
  // Spittelmarkt -> Hermannstr., ~4.1 km straight line
  const a = [52.5075, 13.4040], b = [52.4801, 13.4402];
  const km = sb.beelineKm(...a, ...b);
  ok(km > 3.5 && km < 6, 'a plausible city distance', km);

  const raw = sb.FlotteEngine.haversineKm(...a, ...b);
  ok(km > raw, 'the estimate is LONGER than the crow flies, never shorter', { km, raw });
  ok(Math.abs(km / raw - 1.3) < 0.001, 'by the stated 1.3 detour factor', km / raw);

  const bike = sb.beelineSec(...a, ...b, 'bicycle');
  const foot = sb.beelineSec(...a, ...b, 'pedestrian');
  ok(foot > bike, 'walking takes longer than cycling', { foot, bike });
  ok(bike / 60 > 10 && bike / 60 < 30, `~${Math.round(bike / 60)} min by bike is plausible`);
  ok(foot / 60 > 50 && foot / 60 < 110, `~${Math.round(foot / 60)} min on foot is plausible`);
  eq(sb.beelineSec(...a, ...a, 'bicycle'), 0, 'zero distance costs no time');
  // an unknown costing must not produce NaN and poison the solver
  ok(Number.isFinite(sb.beelineSec(...a, ...b, 'nonsense')),
    'an unknown costing still yields a number');
}

/* ---- nextHop degrades rather than emptying the screen ---- */
{
  const body = fn('nextHop');
  ok(/roadEstimated = true/.test(body), 'a road failure is recorded, not fatal');
  ok(!/busy = false; paint\(e\.message\);\s*\n\s*return;/.test(body),
    'it no longer bails out and shows only an error');
  ok(/beelineSec\(f\.lat, f\.lon, l\.lat, l\.lon, 'pedestrian'\)/.test(body),
    'walk times fall back to straight lines');
  ok(/beelineSec\(f\.lat, f\.lon, l\.lat, l\.lon, 'bicycle'\)/.test(body),
    'and so do bike times');
  ok(/roadEstimated = false/.test(body), 'and the flag resets on a good hop');
}

/* ---- one estimator, so the list and the tour cannot disagree ---- */
{
  const tour = fn('ensureTour');
  ok(/beelineSec\(pts\[a\]/.test(tour), 'ensureTour uses the same estimator');
  ok(!/spd = costing === 'pedestrian'/.test(tour),
    'and no longer keeps its own copy of the speeds');
  ok(/estimated/.test(tour), 'while still labelling the plan as estimated');
}

/* ---- and it is said out loud ---- */
{
  ok(/roadEstimated && options\.length/.test(TEMPLATE), 'a banner appears when times are guessed');
  ok(/id="roadretry"/.test(TEMPLATE), 'with a way to retry');
  const tbl = sandbox([], {}, chunk(/var STR = \{[\s\S]*?\n\};/, 'STR'));
  for (const k of ['roadEst', 'roadNet', 'roadTimeout'])
    ok(tbl.STR.en[k] && tbl.STR.de[k], `"${k}" exists in both languages`);
  ok(/straight-line/.test(tbl.STR.en.roadEst),
    'the banner says plainly that these are not real routes');
  ok(!/connection/i.test(tbl.STR.en.roadNet),
    'and an unreachable service does not blame her connection');
}

done();
