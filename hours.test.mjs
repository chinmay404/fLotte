/* Opening hours: the payload must carry them, the app must convert them into
   solver windows correctly, and "not published" must never read as "closed".
   Run: node hours.test.mjs                                                    */
import { fn, engineSrc, sandbox, payload, harness } from './testkit.mjs';

const { ok, eq, done } = harness('hours');
const P = payload();

/* ---- the data actually landed in the payload ---- */
{
  const withSched = P.locations.filter(l => l.hours);
  const withText = P.locations.filter(l => l.hours_text);
  ok('hours' in P.locations[0], 'stations carry an hours field');
  ok(withSched.length > 200, `${withSched.length}/${P.locations.length} stations have a schedule`,
    withSched.length);
  ok(withText.length >= withSched.length,
    'every schedule keeps the German text it came from, for display');
  const bad = withSched.filter(l => Object.keys(l.hours).some(d => !/^[1-7]$/.test(d)));
  ok(bad.length === 0, 'weekday keys are 1..7 only', bad.slice(0, 2).map(l => l.hours));
  const spans = withSched.flatMap(l => Object.values(l.hours).flat());
  ok(spans.every(s => Array.isArray(s) && s.length === 2 && s[0] < s[1]),
    'every span is [open, close] with open before close');
  ok(spans.every(s => s[0] >= 0 && s[1] <= 24 * 60),
    'every span is inside a single day in minutes');
}

/* ---- window conversion ---- */
const MON = Date.parse('2026-08-17T09:00:00');          // a Monday, 09:00 local
const sb = sandbox(
  ['hoursToday', 'windowsFor', 'windowsCover', 'hoursLabel', 'hhmmOf', 'hasHours'],
  { LOCATIONS: [], Date, FlotteEngine: null }, engineSrc());
sb.FlotteEngine = sb.FlotteEngine || null;
// re-expose the engine the way the app sees it
const eng = sandbox([], {}, engineSrc());
sb.FlotteEngine = eng.FlotteEngine;

const open10to16 = { hours: { '1': [[600, 960]] } };     // Mon 10:00-16:00
const noData = { hours: null };
const shutMon = { hours: { '2': [[600, 960]] } };        // Tue only

{
  eq(sb.hoursToday(open10to16, MON), [[600, 960]], 'Monday schedule found for a Monday');
  eq(sb.hoursToday(shutMon, MON), [], 'a schedule that omits today means closed today');
  eq(sb.hoursToday(noData, MON), null, 'no published hours reads as null, not as closed');

  // 09:00 departure -> the 10:00 door is 3600s away, closing 25200s away
  eq(sb.windowsFor(open10to16, MON), [[3600, 25200]],
    'windows are seconds from the departure moment');
  eq(sb.windowsFor(shutMon, MON), [], 'closed today yields no windows (solver drops it)');
  eq(sb.windowsFor(noData, MON), null, 'unknown hours yield null (solver treats as open)');

  // a door that has already shut today is not offered
  const past = { hours: { '1': [[420, 480]] } };          // 07:00-08:00, gone by 09:00
  eq(sb.windowsFor(past, MON), [], 'a window that already closed is discarded');
  // one still open now keeps a negative opening, which just means "already open"
  const nowOpen = { hours: { '1': [[480, 1080]] } };      // 08:00-18:00
  eq(sb.windowsFor(nowOpen, MON), [[-3600, 32400]],
    'an already-open door keeps a negative open time');
}

/* ---- would she actually get in? ---- */
{
  ok(sb.windowsCover(open10to16, MON, 3600), 'arriving exactly at opening gets in');
  ok(sb.windowsCover(open10to16, MON, 0), 'arriving early is fine — she waits');
  ok(!sb.windowsCover(open10to16, MON, 25201), 'arriving after closing does not');
  ok(sb.windowsCover(noData, MON, 9e9),
    'unknown hours never cry wolf, however late the arrival');
  ok(!sb.windowsCover(shutMon, MON, 60), 'closed today is never coverable');
}

/* ---- labels ---- */
{
  eq(sb.hoursLabel(open10to16, MON), '10:00–16:00', 'label reads as a time range');
  eq(sb.hoursLabel(shutMon, MON), 'closed today', 'label says closed today');
  eq(sb.hoursLabel(noData, MON), null, 'label is null when nothing is published');
  eq(sb.hoursLabel({ hours: { '1': [[540, 780], [840, 1080]] } }, MON),
    '09:00–13:00, 14:00–18:00', 'split shifts are both shown');
  ok(sb.hasHours([open10to16, noData]), 'hasHours: true when any station publishes');
  ok(!sb.hasHours([noData, noData]), 'hasHours: false when none do');
}

/* ---- the solver is actually wired to windows ---- */
{
  const body = fn('ensureTour');
  ok(/tourOrderTW\(mat, win\)/.test(body), 'ensureTour solves with time windows');
  ok(/hasHours\(rem\)/.test(body), 'and only when some remaining station publishes hours');
  ok(/dropped:/.test(body), 'the plan records the stops the hours put out of reach');
  ok(/arriveAt/.test(body), 'and when she is expected at each one');
  ok(/subWin/.test(body), 'the deviation prices also respect the windows');
}

/* ---- and the card says it ---- */
{
  const body = fn('optHTML');
  ok(/hoursLabel\(loc, depBaseMs\(\)\)/.test(body), 'the card shows the hours for today');
  ok(/hours not published/.test(body), 'the card says so when nothing is published');
  ok(/shut by the time you arrive/.test(body),
    'the card warns when the door shuts before arrival');
}

done();
