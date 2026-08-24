/* List <-> map: the two are views of the same 250 stations, so pointing at one
   in either place must say where it is in the other, and panning the map
   narrows the list to what is on screen (the Airbnb benchmark).
   Run: node link.test.mjs                                                     */
import { fn, sandbox, payload, harness, TEMPLATE } from './testkit.mjs';

const { ok, eq, done } = harness('link');
const P = payload();

/* ---- one circle is restyled, not 250 redrawn ---- */
{
  const styled = [];
  const dot = (i) => ({ _base: { r: 3.5, w: 1.5 },
                        setStyle: s => styled.push([i, s]),
                        bringToFront: () => {} });
  const sb = sandbox(['litDot', 'linkTo'],
    { dotOf: { 5: dot(5), 9: dot(9) }, linked: null, view: 'plan',
      revealRow: () => {}, reduce: true, T: k => k, document: null });

  sb.linkTo(5, 'list');
  eq(sb.linked, 5, 'linking records which station is lit');
  eq(styled.length, 1, 'exactly one circle is touched, not the whole layer');
  ok(styled[0][1].radius > 3.5, 'the lit circle grows', styled[0][1]);

  styled.length = 0;
  sb.linkTo(9, 'list');
  eq(styled.map(s => s[0]), [5, 9], 'moving the link unlights the old one first');

  styled.length = 0;
  sb.linkTo(9, 'list');
  eq(styled.length, 0, 're-linking the same station does no work');

  styled.length = 0;
  sb.linkTo(null, 'list');
  eq(styled.map(s => s[0]), [9], 'clearing the link unlights it');

  // a station with no drawn circle must not throw — dots are hidden mid-trip
  sb.linkTo(4242, 'list');
  ok(true, 'linking a station with no circle on the map is harmless');
}

/* ---- map -> list only reveals while she is looking at the list ---- */
{
  const calls = [];
  const mk = view => sandbox(['litDot', 'linkTo'],
    { dotOf: {}, linked: null, view, revealRow: i => calls.push(i),
      reduce: true, T: k => k, document: null });
  const a = mk('catalogue');
  a.linkTo(3, 'map');
  eq(calls, [3], 'a dot scrolls the list to its station');
  calls.length = 0;
  a.linked = null;
  a.linkTo(3, 'list');
  eq(calls, [], 'but hovering the list does not scroll the list under her');
  calls.length = 0;
  const b = mk('plan');
  b.linkTo(3, 'map');
  eq(calls, [], 'and nothing is scrolled when she is not on the Bikes tab');
}

/* ---- the wiring in the source ---- */
{
  const cat = fn('paintCatalogue');
  ok(/data-loc="' \+ r\.loc\._i/.test(cat), 'every row carries its station index');
  ok(/inView\.contains/.test(cat), 'the list can be limited to the map viewport');
  ok(/isAdhoc\(r\.loc\) \|\| inView/.test(cat),
    'her own off-map stop is never hidden by the viewport');
  ok(/hiddenByMap/.test(cat), 'and the count outside the map is offered as a way back');
  ok(/mouseenter[\s\S]{0,60}linkTo\(li, 'list'\)/.test(cat),
    'hovering a row lights its station on the map');
  ok(/focus[\s\S]{0,60}linkTo\(li, 'list'\)/.test(cat),
    'and so does keyboard focus, not just the mouse');

  const db = fn('drawBase');
  ok(/dotOf\[loc\._i\] = dot/.test(db), 'drawBase indexes circles by station');
  ok(/dotOf = \{\}/.test(db), 'and clears that index on every redraw');
  ok(/linkTo\(loc\._i, 'map'\)/.test(db), 'a dot links back to the list');

  const move = TEMPLATE.match(/map\.on\('moveend zoomend'[\s\S]{0,400}?\n\}\);/)[0];
  ok(/view !== 'catalogue'/.test(move), 'the map only drives the list on the Bikes tab');
  ok(/setTimeout/.test(move), 'and is debounced, since a pan fires continuously');
  ok(/inView = map\.getBounds\(\)/.test(move), 'the bounds become the filter');

  ok(/revealRow/.test(fn('linkTo')), 'linkTo can reveal a row');
  const rr = fn('revealRow');
  ok(/scrollIntoView/.test(rr), 'revealing scrolls the row into view');
  ok(/classList\.add\('lit'\)/.test(rr), 'and flashes it so she can see which');
  ok(/if\(!row\)\{/.test(rr) && /notInList/.test(rr),
    'a station filtered out of the list says so rather than doing nothing');
}

/* ---- Bikes comes before Directions ---- */
{
  const nav = fn('renderNav');
  ok(nav.indexOf('data-view="catalogue"') < nav.indexOf('data-view="plan"'),
    'the Bikes tab is rendered first — pick the bikes, then get the route');
  ok(/var view = 'catalogue'/.test(TEMPLATE), 'and the app opens on it');
}

/* ---- the mobile overflow that clipped the list ---- */
{
  const css = TEMPLATE.slice(0, TEMPLATE.indexOf('</style>'));
  ok(/\.cat-search\{[^}]*min-width:0/.test(css),
    'the search box can shrink — a flex item defaults to min-width:auto and overflowed');
  ok(/\.bk-sub\{display:block/.test(css),
    'bk-sub is a block, or its text-overflow does nothing on an inline span');
  ok(/\.bk-name\{display:block/.test(css), 'and so is bk-name');
  ok(/#flow\{overflow-x:hidden\}/.test(css), 'and the panel never scrolls sideways');
}

done();
