/* Repair round: the clock must follow the mechanic in real time, the visiting
   order must name the costing it was solved for, and no repair time may ever be
   invented (clicking Done is the signal).  Run: node round.test.mjs           */
import { fn, engineSrc, sandbox, harness, TEMPLATE, i18nSrc } from './testkit.mjs';

const { ok, done } = harness('round');
const NOW = Date.parse('2026-08-17T10:00:00Z');
let clockMs = NOW;

const sb = sandbox(
  ['esc', 'mins', 'km', 'clock', 'hhmm', 'here', 'visitedIdx', 'depBaseMs', 'baseFuture',
   'defectiveAt', 'defectStations', 'tourRemaining', 'roundCosting', 'costingLabel',
   'transitSec', 'timeFor', 'bestMode', 'orderModeMismatch', 'missionHTML'],
  {
    IC: { wrench: '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
              pin: '<svg viewBox="0 0 24 24"><path d="M12 2v20"/></svg>' },
    LOCATIONS: [
      { _i: 0, location_name: 'Station A', items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      { _i: 1, location_name: 'Station B', items: [{ id: 4 }, { id: 5 }] },
      { _i: 2, location_name: 'Station C', items: [{ id: 6 }] },
    ],
    defects: new Set([1, 2, 3, 4, 5, 6]), repaired: new Set(),
    mission: true, addingStop: false, tour: null, trip: [], options: [], modePref: 'bike',
    Date: class extends Date {
      constructor(...a) {
        return a.length ? new (Date.bind.apply(Date, [null, ...a]))() : new Date(clockMs);
      }
      static now() { return clockMs; }
      static parse(s) { return Date.parse(s); }
    },
  }, engineSrc() + '\n' + i18nSrc());

const at = ms => new Date(ms).toISOString().slice(11, 16);
const M = 60000;

/* ---- the clock is anchored in real time and invents nothing ---- */
sb.trip = [{ lat: 52.5, lon: 13.4, label: 'Depot', i: null, sec: 0 }];
ok(sb.depBaseMs() === NOW, 'at the depot, base is now', at(sb.depBaseMs()));

// sets off for A at 10:00, a 12 min ride
sb.trip.push({ lat: 52.51, lon: 13.41, label: 'Station A', i: 0,
               mode: 'bike', sec: 720, goMs: clockMs });

clockMs = NOW + 5 * M;
ok(sb.depBaseMs() === NOW + 12 * M,
  'en route: base is the projected arrival, 10:12', at(sb.depBaseMs()));

clockMs = NOW + 37 * M;                       // arrived, working, nothing marked
ok(sb.depBaseMs() === clockMs,
  'standing at the stop: base is now — no repair time estimated', at(sb.depBaseMs()));
ok(sb.depBaseMs() !== clockMs + 12 * M,
  'the ride already done is not re-charged to now (was 10:49)', at(clockMs + 12 * M));

// Done is the signal: clearing A frees her to set off at that moment
[1, 2, 3].forEach(id => { sb.defects.delete(id); sb.repaired.add(id); });
clockMs = NOW + 90 * M;
ok(sb.depBaseMs() === clockMs, 'after Done at 11:30, base is 11:30', at(sb.depBaseMs()));

// a later leg re-anchors on its own stamp instead of stacking on the earlier one
sb.trip.push({ lat: 52.52, lon: 13.42, label: 'Station B', i: 1,
               mode: 'bike', sec: 600, goMs: clockMs });
clockMs = NOW + 95 * M;
ok(sb.depBaseMs() === NOW + 100 * M,
  'second leg: base is its own goMs + duration, 11:40', at(sb.depBaseMs()));

/* ---- no repair-time estimate anywhere in the product ---- */
{
  sb.tour = { order: [1, 2], totalSec: 20 * 60, estimated: false, altTotals: {},
              costing: 'bicycle' };
  const bar = sb.missionHTML();
  ok(!/dwell/.test(bar), 'round bar has no work-time control');
  ok(!/min work/.test(bar), 'round bar adds no estimated work total');
  ok(!/done ~/.test(bar), 'round bar makes no finish-time promise');
  ok(/20 min<\/b>\s*travel/.test(bar), 'round bar still shows travel time', bar);
  ok(bar.includes('<b>1</b> flagged bike at <b>1</b> station left'),
    'round bar counts only unvisited stations with work left',
    (bar.match(/Repair round[^·]*/) || [])[0]);
  ok(bar.includes('<b>3</b> repaired'), 'round bar counts repairs done');
  ok(!/dwellMin|DWELL_CHOICES|workLeftSec|flotte-dwell/.test(TEMPLATE),
    'no dwell code or storage key left in the source');
  ok(/projectedArrivalMs\(trip, nowMs\)/.test(TEMPLATE),
    'the engine takes no dwell callback');
}

/* ---- the order names the costing it was actually solved for ---- */
{
  sb.modePref = 'bike'; sb.tour.costing = 'bicycle';
  ok(sb.missionHTML().includes('best order by bike'), 'bicycle round says "by bike"');
  sb.modePref = 'walk'; sb.tour.costing = 'pedestrian';
  ok(sb.missionHTML().includes('best order on foot'), 'pedestrian round says "on foot"');
  // must follow tour.costing, not modePref: they differ until the round re-solves
  sb.modePref = 'walk'; sb.tour.costing = 'bicycle';
  ok(sb.missionHTML().includes('best order by bike'),
    'a stale bicycle order still says "by bike" under the Walk tab');
  sb.modePref = 'transit';
  const t = sb.missionHTML();
  ok(t.includes('best order by bike') && !t.includes('transit'),
    'transit round: the order is honestly labelled a bike order');
  ok(sb.roundCosting() === 'bicycle', 'transit falls back to bicycle costing');
  sb.modePref = 'walk';
  ok(sb.roundCosting() === 'pedestrian', 'walk uses pedestrian costing');
  sb.modePref = 'best';
  ok(sb.roundCosting() === 'bicycle', 'best falls back to bicycle costing');
  sb.tour.costing = 'bicycle';
}

/* ---- Best stays selectable in a round (an attempt to hide it was reverted) ---- */
{
  const row = TEMPLATE.match(/<div class="modes-row"[\s\S]{0,400}?<\/div>';/);
  ok(row && /mtab\('best'/.test(row[0]) && !/mission \?/.test(row[0]),
    'Best tab is offered and not hidden during a round', row && row[0]);
  ok(!/if\(modePref === 'best'\) modePref = 'bike'/.test(TEMPLATE),
    'entering a round does not coerce Best to Bike');
}

/* ---- but the order/mode mismatch is surfaced when it is real ---- */
{
  const agree = [{ i: 0, walk: { sec: 900 }, bike: { sec: 300 }, transit: null, selJ: 0 },
                 { i: 1, walk: { sec: 800 }, bike: { sec: 400 }, transit: null, selJ: 0 }];
  sb.options = agree; sb.modePref = 'best';
  ok(sb.orderModeMismatch() === null, 'no notice when Best agrees with the order');
  ok(!sb.missionHTML().includes('ordernote'), 'bar stays quiet when they agree');

  sb.options = agree.concat([{ i: 2, walk: { sec: 200 }, bike: { sec: 600 },
                               transit: null, selJ: 0 }]);
  const mm = sb.orderModeMismatch();
  ok(mm && mm.n === 1 && mm.of === 3, 'notice counts the disagreeing stops', mm);
  const bar = sb.missionHTML();
  ok(bar.includes('<b>1</b> of these 3 stops another way'), 'notice states the count');
  ok(bar.includes('solved by bike throughout'), 'notice names the order costing');

  for (const m of ['bike', 'walk', 'transit']) {
    sb.modePref = m;
    ok(sb.orderModeMismatch() === null, `no notice under an explicit ${m} round`);
  }
  sb.modePref = 'best'; sb.mission = false;
  ok(sb.orderModeMismatch() === null, 'no notice outside a round');
  sb.mission = true;

  sb.tour.costing = 'pedestrian';
  const w = sb.orderModeMismatch();
  ok(w && w.n === 2, 'pedestrian order: the bike-fastest stops disagree', w);
}

done();
