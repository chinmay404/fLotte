/* Station dots on the map must answer "which bikes are here?" on their own.
   They were drawn with interactive:false, so ~250 stations were inert and the
   only way to identify a bike was the Bikes list.  Run: node dot.test.mjs     */
import { fn, sandbox, payload, harness, i18nSrc } from './testkit.mjs';

const { ok, done } = harness('dot');
const P = payload();

const sb = sandbox(
  ['esc', 'safeColor', 'colorOf', 'mins', 'timeFor', 'transitSec', 'thumbOK',
   'defectiveAt', 'tipHTML'],
  { LOCATIONS: P.locations, COLORS: P.colors, FALLBACK: '#5F6368',
    defects: new Set(), mission: false, badThumb: {}, modePref: 'best' },
  i18nSrc());

/* ---- what a dot actually shows ---- */
const loc = P.locations.find(l => l.items.length > 2) || P.locations[0];
const h = sb.tipHTML(loc, null);
ok(h.includes(loc.location_name), 'names the station', loc.location_name);
ok(h.includes(loc.street), 'shows the street');
ok(h.includes(loc.district[0]), 'shows the district');
ok(!h.includes('away'), 'shows no travel time before a trip exists (o = null)');
ok(loc.items.slice(0, 3).every(i => h.includes(i.name)),
  'lists the bikes at that station', loc.items.slice(0, 3).map(i => i.name));
ok(/cargo bike|Trike|Rikscha|Long|Anh|Bakfiets/i.test(h), 'each bike shows its type');

sb.defects = new Set([loc.items[0].id]);
ok(sb.tipHTML(loc, null).includes('needs repair'),
  'a flagged bike reads as flagged from the map too');
sb.defects = new Set();

/* ---- and the wiring ---- */
const db = fn('drawBase');
ok(/bindTooltip\(tipHTML\(loc, null\)/.test(db), 'drawBase binds the tooltip to a dot');
ok(/radius: 13/.test(db), 'a padded hit target exists — 3.5px is not a thumb target');
ok(/fillOpacity:0/.test(db), 'the hit target is invisible');
ok(/if\(picking \|\| addingStop\) return;/.test(db),
  'arming the map for a start point or a new stop still wins over the tooltip');
ok(/linkTo\(loc\._i, 'map'\)/.test(db), 'a dot points at its row in the list');
ok(!/bubblingMouseEvents\s*:\s*false/.test(db),
  'dot events keep bubbling so the map pick handler still fires');
ok(/interactive:false/.test(db), 'the drawn dot stays inert; the halo takes the events');

console.log(`  (a dot now answers "which bikes are here" for ${P.locations.length} stations)`);
done();
