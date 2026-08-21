/* Filters must narrow the bike list, not just the map. paintCatalogue used to
   walk every LOCATIONS entry and apply only its own search box, so filtering to
   one district still listed all 267 bikes. Runs against the real payload.
   Run: node filter.test.mjs                                                   */
import { fn, chunk, sandbox, payload, harness } from './testkit.mjs';

const { ok, done } = harness('filter');
const P = payload();

const sb = sandbox(
  ['haystack', 'itemPasses', 'locPasses', 'eligible', 'filtersActive', 'eligibleItems',
   'valuesFor', 'countFor'],
  { LOCATIONS: P.locations },
  chunk(/var ITEM_FACETS = \[[\s\S]*?filters\[f\.key\] = new Set\(\); \}\);/, 'facets'));

const F = () => sb.filters;
const KEYS = ['district', 'region', 'type', 'drive', 'features', 'project'];
const reset = () => { F().q = ''; KEYS.forEach(k => F()[k].clear()); };

/* the pre-fix behaviour: every item at every station, filters ignored */
const everything = P.locations.reduce((a, l) => a + l.items.length, 0);
console.log(`  (dataset: ${P.locations.length} stations, ${everything} bikes)`);

/* ---- unfiltered, nothing changes ---- */
reset();
ok(!sb.filtersActive(), 'no filters active on a clean slate');
ok(sb.eligibleItems().length === everything,
  'unfiltered: the list is every bike, as before', sb.eligibleItems().length);
ok(sb.eligible().length === P.locations.length, 'unfiltered: every station eligible');

/* ---- a district filter really removes bikes ---- */
{
  reset();
  const d = sb.valuesFor('district')[0];
  F().district.add(d);
  ok(sb.filtersActive(), 'district filter registers as active');
  const items = sb.eligibleItems();
  ok(items.length > 0, 'district filter leaves some bikes', items.length);
  ok(items.length < everything,
    'district filter removes bikes from the list (the actual bug)',
    { filtered: items.length, before: everything });
  ok(items.every(r => r.loc.district.indexOf(d) !== -1),
    'every listed bike is in the chosen district');
  console.log(`  (district "${d}" -> ${items.length} bikes)`);
}

/* ---- item facets filter per BIKE, not per station ---- */
{
  reset();
  const t = sb.valuesFor('type')[0];
  F().type.add(t);
  const items = sb.eligibleItems();
  ok(items.length > 0 && items.length < everything, 'type filter narrows the list',
    items.length);
  ok(items.every(r => r.it.type.indexOf(t) !== -1),
    'every listed bike really is that type — station-level filtering would leak');
  // a station holding one match and one non-match must show only the match
  const mixed = sb.eligible().filter(l =>
    l.items.some(i => i.type.indexOf(t) !== -1) &&
    l.items.some(i => i.type.indexOf(t) === -1));
  if (mixed.length) {
    const loc = mixed[0];
    const here = items.filter(r => r.loc._i === loc._i);
    ok(here.length < loc.items.length,
      'at a mixed station only the matching bikes are listed',
      { listed: here.length, atStation: loc.items.length });
    console.log(`  (type "${t}": ${mixed.length} mixed stations, e.g. ` +
                `${loc.location_name} lists ${here.length}/${loc.items.length})`);
  } else {
    ok(true, `(no mixed-type station exists for "${t}" — nothing to leak)`);
  }
}

/* ---- text query and combinations ---- */
{
  reset();
  F().q = 'pankow';
  ok(sb.eligibleItems().length < everything, 'a text query narrows the list');
  ok(sb.filtersActive(), 'a text query registers as active');

  reset();
  const d = sb.valuesFor('district')[0];
  F().district.add(d);
  const onlyD = sb.eligibleItems().length;
  const t = sb.valuesFor('type')[0];
  F().type.add(t);
  const both = sb.eligibleItems();
  ok(both.length <= onlyD, 'adding a second filter can never widen the list',
    { onlyDistrict: onlyD, both: both.length });
  ok(both.every(r => r.loc.district.indexOf(d) !== -1 && r.it.type.indexOf(t) !== -1),
    'combined filters intersect, they do not union');
}

/* ---- one source of truth for the list and the header tally ---- */
{
  reset();
  F().district.add(sb.valuesFor('district')[1] || sb.valuesFor('district')[0]);
  const shared = sb.eligibleItems().length;
  const inline = sb.eligible().reduce((a, l) =>
    a + l.items.filter(i => sb.itemPasses(i)).length, 0);
  ok(shared === inline, 'the shared helper matches the tally maths it replaced',
    { helper: shared, inline });
}

/* ---- clearing restores everything ---- */
{
  reset();
  F().district.add(sb.valuesFor('district')[0]);
  F().type.add(sb.valuesFor('type')[0]);
  F().q = 'x';
  ok(sb.filtersActive(), 'filters active before clearing');
  reset();                                   // mirrors clearFilters() minus the DOM
  ok(!sb.filtersActive(), 'clearing drops every facet and the query');
  ok(sb.eligibleItems().length === everything, 'clearing restores the full list');
}

/* ---- and the list is wired to the shared helper, not to LOCATIONS ---- */
{
  const body = fn('paintCatalogue');
  ok(/eligibleItems\(\)/.test(body), 'paintCatalogue builds from eligibleItems()');
  ok(!/LOCATIONS\.forEach/.test(body),
    'paintCatalogue no longer walks every station regardless of filters');
  ok(/clearf/.test(body), 'paintCatalogue offers a Clear filters escape hatch');
  ok(/buried/.test(body), 'paintCatalogue reports flagged bikes the filter hides');
  const rand = (body.match(/rand5[\s\S]*?\}\);/) || [''])[0];
  ok(!/LOCATIONS\.forEach/.test(rand), 'the demo flagger draws from the filtered pool');
  ok(/eligibleItems\(\)/.test(fn('tallyText')),
    'the header tally shares the same helper');
}

done();
