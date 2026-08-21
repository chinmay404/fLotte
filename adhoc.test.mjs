/* Off-map repair stops: a bike too broken to return to its station is repaired
   where it lies, so the round needs a stop that is not in fLotte's database.
   Modelled as a synthetic station holding one synthetic flagged bike, because
   LOCATIONS[i] is the key every downstream path already uses.
   Run: node adhoc.test.mjs                                                    */
import { fn, chunk, engineSrc, i18nSrc, sandbox, payload, harness, TEMPLATE } from './testkit.mjs';

const { ok, eq, done } = harness('adhoc');
const P = payload();

let stored = null;
const sb = sandbox(
  ['esc', 'haystack', 'isAdhoc', 'adhocStations', 'makeAdhoc', 'saveAdhoc', 'restoreAdhoc',
   'itemPasses', 'locPasses', 'eligible', 'eligibleItems', 'filtersActive',
   'defectiveAt', 'defectStations', 'valuesFor', 'countFor'],
  { LOCATIONS: P.locations.slice(0, 20).map(l => JSON.parse(JSON.stringify(l))),
    defects: new Set(), repaired: new Set(),
    localStorage: { getItem: () => stored, setItem: (k, v) => { stored = v; } },
    adhocSeq: 0, addingStop: false,
    Date },
  chunk(/var ITEM_FACETS = \[[\s\S]*?filters\[f\.key\] = new Set\(\); \}\);/, 'facets')
  + '\n' + engineSrc() + '\n' + i18nSrc());
sb.LOCATIONS.forEach((l, i) => { l._i = i; });
const BASE = sb.LOCATIONS.length;
const KEYS = ['district', 'region', 'type', 'drive', 'features', 'project'];
const reset = () => { sb.filters.q = ''; KEYS.forEach(k => sb.filters[k].clear()); };

/* ---- the shape of a synthetic stop ---- */
const stop = sb.makeAdhoc(52.4801, 13.4402, 'Stranded bike, Hermannstr.');
{
  ok(sb.isAdhoc(stop), 'it is marked as ad-hoc');
  eq(stop.hours, null, 'it has no opening hours — a street corner has no door');
  eq(stop.items.length, 1, 'it carries exactly one bike, the reason it exists');
  ok(stop.items[0].adhoc, 'and that bike is marked ad-hoc too');
  ok(stop.items[0].id < 0,
    'the bike id is negative, so it cannot collide with a WordPress post id',
    stop.items[0].id);
  ok(Number.isInteger(stop.items[0].id),
    'and it is an integer, because the click handlers coerce it with unary +');
  eq(+String(stop.items[0].id), stop.items[0].id,
    'round-trips through a data attribute without becoming NaN');
  ok(Array.isArray(stop.district) && Array.isArray(stop.region),
    'it still looks like a station to code that reads district/region');
  eq(stop.district, [], 'with no district, so the card subline has no dangling separator');
  ok(stop.location_name === 'Stranded bike, Hermannstr.', 'it keeps her label');
}

/* ---- it joins the round like any other station ---- */
{
  stop._i = sb.LOCATIONS.length;
  sb.LOCATIONS.push(stop);
  sb.defects.add(stop.items[0].id);
  eq(sb.defectiveAt(stop).length, 1, 'its bike counts as flagged');
  ok(sb.defectStations().some(l => l._i === stop._i),
    'so it appears among the stations a round must visit');
  ok(sb.adhocStations().length === 1, 'and it is findable as an ad-hoc stop');
}

/* ---- hazard 1: facets must not hide her own stop ---- */
{
  reset();
  ok(sb.eligibleItems().some(r => r.it.adhoc), 'unfiltered, the stranded bike is listed');
  const t = sb.valuesFor('type')[0];
  sb.filters.type.add(t);
  ok(sb.eligibleItems().some(r => r.it.adhoc),
    'a bike-type filter does not hide it — it has no catalogue facets to match', t);
  const d = sb.valuesFor('district')[0];
  reset(); sb.filters.district.add(d);
  ok(sb.eligible().some(l => l._i === stop._i),
    'nor does a district filter, which would drop it from the round too');
  // but a text search still applies, so she can find it by name
  reset(); sb.filters.q = 'hermannstr';
  ok(sb.eligible().some(l => l._i === stop._i), 'a name search finds it');
  sb.filters.q = 'zzzznotpresent';
  ok(!sb.eligible().some(l => l._i === stop._i),
    'and a search that cannot match it still excludes it');
  reset();
}

/* ---- hazard 2: the tally counts fLotte's fleet, not her stops ---- */
{
  reset();
  const st = sb.eligible().filter(l => !sb.isAdhoc(l)).length;
  const bk = sb.eligibleItems().filter(r => !r.it.adhoc).length;
  eq(st, BASE, 'the station tally excludes ad-hoc stops', { st, BASE });
  ok(bk === sb.eligibleItems().length - 1, 'and so does the free-bike tally');
  ok(/isAdhoc\(l\)/.test(fn('tallyText')), 'tallyText actually applies that exclusion');
}

/* ---- hazard 3: persistence, and only while there is work left ---- */
{
  stored = null;
  sb.saveAdhoc();
  const saved = JSON.parse(stored);
  eq(saved.length, 1, 'a flagged ad-hoc stop is persisted');
  eq(saved[0].label, 'Stranded bike, Hermannstr.', 'with its label');
  ok(saved[0].id < 0 && typeof saved[0].lat === 'number', 'with its id and position');

  // once dealt with, it should not come back next session
  sb.defects.delete(stop.items[0].id);
  sb.saveAdhoc();
  eq(JSON.parse(stored).length, 0, 'a finished stop is not carried over');

  // restore rebuilds it, flagged, before indices are assigned
  stored = JSON.stringify([{ id: -7, lat: 52.5, lon: 13.4, label: 'Bike on the towpath' }]);
  const before = sb.LOCATIONS.length;
  sb.restoreAdhoc();
  eq(sb.LOCATIONS.length, before + 1, 'restore appends the stop');
  const back = sb.LOCATIONS[sb.LOCATIONS.length - 1];
  ok(sb.isAdhoc(back) && back.location_name === 'Bike on the towpath', 'with its label');
  ok(sb.defects.has(-7), 'and re-flagged, since it only persisted because it was flagged');
  ok(/restoreAdhoc\(\);[\s\S]{0,80}LOCATIONS\.forEach\(function\(l, i\)\{ l\._i = i; \}\)/
     .test(TEMPLATE), 'boot restores BEFORE _i is handed out, or indices shift');

  // junk in storage must not take the app down
  stored = '{"not":"an array"}';
  const n0 = sb.LOCATIONS.length;
  sb.restoreAdhoc();
  eq(sb.LOCATIONS.length, n0, 'malformed storage is ignored');
  stored = '[{"lat":"nope"}]';
  sb.restoreAdhoc();
  eq(sb.LOCATIONS.length, n0, 'a row without real coordinates is skipped');
}

/* ---- hazard 4: nothing is ever spliced out of LOCATIONS ---- */
{
  ok(!/LOCATIONS\.splice/.test(TEMPLATE),
    'LOCATIONS is never spliced — that would shift every _i after it');
  const db = fn('drawBase');
  ok(/isAdhoc\(loc\) && !bad/.test(db),
    'a finished ad-hoc stop stops drawing a dot instead of being deleted');
}

/* ---- the affordance ---- */
{
  ok(/addingStop/.test(fn('missionHTML')), 'the round bar offers adding a stop');
  const click = TEMPLATE.match(/map\.on\('click'[\s\S]{0,220}?\}\);/)[0];
  ok(/if\(addingStop\)\{ addAdhocAt/.test(click), 'a map tap creates the stop when armed');
  ok(/if\(!picking\) return;/.test(click), 'and the start-point flow is untouched');
  const add = fn('addAdhocAt');
  ok(/if\(!label\)\{/.test(add), 'cancelling the prompt creates nothing');
  ok(/saveAdhoc\(\)/.test(add) && /saveDefects\(\)/.test(add), 'both stores are updated');
  ok(/nextHop\(\)/.test(add), 'and the round re-plans from where she is');
  ok(/mission = true/.test(add), 'adding a stop puts her in a round if she was not');
  ok(/saveAdhoc\(\)/.test(fn('markRepaired')),
    'marking it Done also updates what is carried over');
}

/* ---- and it reads as having no hours, not unpublished ones ---- */
{
  const body = fn('optHTML');
  ok(/isAdhoc\(loc\)[\s\S]{0,60}T\('adhocNoHours'\)/.test(body),
    'the card says "no fixed hours", not "hours not published"');
}

/* ---- and it is solver-visible as always open ---- */
{
  const w = sandbox(['hoursToday', 'windowsFor'], { Date }, i18nSrc());
  eq(w.windowsFor(stop, Date.parse('2026-08-17T09:00:00')), null,
    'an ad-hoc stop has no windows, so the solver treats it as always reachable');
}

done();
