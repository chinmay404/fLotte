/* Opening hours: the payload must carry them, the app must convert them into
   solver windows correctly, and "not published" must never read as "closed".
   Run: node hours.test.mjs                                                    */
import { fn, engineSrc, i18nSrc, sandbox, payload, harness } from './testkit.mjs';

const { ok, eq, done } = harness('hours');
const P = payload();

/* ---- the data actually landed in the payload ---- */
{
  const withSched = P.locations.filter(l => l.hours);
  const withText = P.locations.filter(l => l.hours_text);
  ok('hours' in P.locations[0], 'stations carry an hours field');
  ok(withSched.length > 200, `${withSched.length}/${P.locations.length} stations have a schedule`,
    withSched.length);
  ok(P.locations.every(l => !l.hours || typeof l.hours_exact === 'boolean'),
    'every schedule records whether the parse was exact');
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

/* ---- the parse must be FAITHFUL, not merely non-empty ----
   Counting "produced a schedule" hid a real bug: the day-list separators
   +, / and u. were unhandled, so "Di + Do 10:00-16:00" parsed as Thursday
   only. A dropped day reads as CLOSED, which silently skips real work.
   This re-derives days and times straight from the German and demands the
   stored schedule account for all of them. */
{
  const DAY = { mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6, so: 7 };
  const TAIL = /[,.;]?\s*\(?\s*(?:außer|ausser)\s+an\s+(?:gesetzl\w*\.?\s*)?Feiertagen\)?/i;
  const parts = txt => {
    const m = TAIL.exec(txt);
    const body = m ? txt.slice(0, m.index) : txt;
    const times = new Set();
    for (const [, a, b] of body.matchAll(/(\d{1,2})(?::(\d{2}))?\s*[-–]/g))
      times.add(+a * 60 + (+b || 0));
    for (const [, a, b] of body.matchAll(/[-–]\s*(\d{1,2})(?::(\d{2}))?/g))
      times.add(+a * 60 + (+b || 0));
    const days = new Set();
    for (const [, a, b] of body.matchAll(/(Mo|Di|Mi|Do|Fr|Sa|So)\s*[-–]\s*(Mo|Di|Mi|Do|Fr|Sa|So)/g)) {
      const x = DAY[a.toLowerCase()], y = DAY[b.toLowerCase()];
      const seq = y >= x ? Array.from({length: y - x + 1}, (_, k) => x + k)
                         : [...Array.from({length: 8 - x}, (_, k) => x + k),
                            ...Array.from({length: y}, (_, k) => k + 1)];
      seq.forEach(d => days.add(d));
    }
    const rest = body.replace(/(Mo|Di|Mi|Do|Fr|Sa|So)\s*[-–]\s*(Mo|Di|Mi|Do|Fr|Sa|So)/g, ' ');
    for (const [, d] of rest.matchAll(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b/g)) days.add(DAY[d.toLowerCase()]);
    return { times, days };
  };
  const exact = P.locations.filter(l => l.hours && l.hours_exact);
  let faithful = 0;
  const bad = [];
  for (const l of exact) {
    const { times, days } = parts(l.hours_text);
    const got = new Set(Object.values(l.hours).flat().flat());
    const gotDays = new Set(Object.keys(l.hours).map(Number));
    const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
    if (same(times, got) && same(days, gotDays)) faithful++;
    else bad.push(l.location_name);
  }
  ok(exact.length > 200, `${exact.length} stations claim an exact schedule`, exact.length);
  eq(bad, [], 'every schedule marked exact really does account for its German text');
  ok(faithful === exact.length, `all ${faithful} exact schedules verified`, { faithful });

  // the separators that were silently dropping days
  const seps = P.locations.filter(l => l.hours_text &&
    /(Mo|Di|Mi|Do|Fr|Sa|So)\s*(?:\+|\/|u\.)\s*(Mo|Di|Mi|Do|Fr|Sa|So)/.test(l.hours_text));
  ok(seps.length > 0, `${seps.length} stations use +, / or u. between days`, seps.length);
  ok(seps.filter(l => l.hours).every(l => Object.keys(l.hours).length >= 2),
    'and every one of them kept more than a single day');

  // a day that is only "by arrangement" must never read as closed
  const oe = P.locations.filter(l => l.hours &&
    Object.values(l.hours).some(sp => sp.some(w => w[0] === 0 && w[1] === 1440)));
  ok(oe.length > 0, `${oe.length} stations have an open-ended day (by arrangement)`, oe.length);
  ok(oe.every(l => l.hours_exact === false),
    'an open-ended day marks the parse inexact, so the card shows the German');
}

/* ---- window conversion ---- */
const MON = Date.parse('2026-08-17T09:00:00');          // a Monday, 09:00 local
const sb = sandbox(
  ['hoursToday', 'windowsFor', 'windowsCover', 'hoursLabel', 'hhmmOf', 'hasHours'],
  { LOCATIONS: [], Date, FlotteEngine: null }, engineSrc() + '\n' + i18nSrc());
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
  ok(/T\('hoursNone'\)/.test(body), 'the card says so when nothing is published');
  ok(/T\('hoursTooLate'\)/.test(body),
    'the card warns when the door shuts before arrival');
  ok(/hours_exact === false[\s\S]{0,200}hoursRaw/.test(body),
    'an inexact parse shows the original German, not a tidy summary');
}

done();
