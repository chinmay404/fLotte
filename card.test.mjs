/* Option cards: a card shows ONLY the selected travel mode. "Best" is the sole
   comparing view. Before this was enforced, every card listed walk + bike +
   transit at once with a faint tint on the active one, so picking Walk still
   showed you three routes.  Run: node card.test.mjs                           */
import { fn, engineSrc, sandbox, harness, i18nSrc } from './testkit.mjs';

const { ok, done } = harness('card');
const BASE = Date.parse('2026-08-17T10:00:00Z');

const sb = sandbox(
  ['esc', 'safeColor', 'mins', 'km', 'clock', 'inMin', 'transitSec', 'timeFor',
   'bestMode', 'stripHTML', 'hintHTML', 'depHTML', 'mv', 'thumbOK', 'isAdhoc', 'hoursToday', 'windowsFor', 'windowsCover',
   'hoursLabel', 'hhmmOf', 'optHTML'],
  {
    IC: { walk: '<ICON-walk>', bike: '<ICON-bike>', tram: '<ICON-tram>', right: '<ICON-right>',
          clock: '<ICON-clock>' },
    LOCATIONS: [{ location_name: 'Kiezpirat Nord', street: 'Kastanienallee 12',
                  district: ['Pankow'],
                  items: [{ id: 1, name: 'Kiezpirat', type: ['Long John'], thumbnail: null }] }],
    colorOf: () => '#7FC600', tourNext: () => null,
    depBaseMs: () => BASE, baseFuture: () => false,
    here: () => ({ lat: 52.5, lon: 13.4, label: 'Kastanienallee' }),
    defects: new Set(), repaired: new Set(), badThumb: {},
    mission: false, tour: null, ANIM: false, BOARD_ANIM: false,
    expanded: null, modePref: 'best', Date,
  }, engineSrc() + '\n' + i18nSrc());

const journey = {
  dep: '2026-08-17T10:05:00Z', arr: '2026-08-17T10:20:00Z',
  legs: [{ walking: true, sec: 180 },
         { line: 'M4', bg: '#BE1414', fg: '#ffffff', dep: '2026-08-17T10:08:00Z',
           arr: '2026-08-17T10:17:00Z', direction: 'Hackescher Markt' },
         { walking: true, sec: 120 }],
};
// walk 12 min, bike 5 min, transit 20 min  ->  bike is the best mode
const opt = { i: 0, walk: { sec: 720, km: 0.9 }, bike: { sec: 300, km: 1.1 },
              transit: { journeys: [journey] }, selJ: 0 };

const render = (mode, expandedI = null, o = opt) => {
  sb.modePref = mode; sb.expanded = expandedI;
  return sb.optHTML(o, 0);
};
const modeline = h => (h.match(/<div class="modeline num">([\s\S]*?)<\/div>/) || [, ''])[1];

/* ---- Best is the one comparing view ---- */
{
  const h = render('best'), ml = modeline(h);
  ok(ml.includes('<ICON-walk>') && ml.includes('<ICON-bike>') && ml.includes('<ICON-tram>'),
    'best: all three modes listed', ml);
  ok(ml.includes('12 min') && ml.includes('5 min') && ml.includes('20 min'),
    'best: all three times present', ml);
  ok(!ml.includes('mv-l'), 'best: rows unlabelled, the icons carry it', ml);
  ok(ml.includes('mv sel'), 'best: the winning mode is highlighted');
  ok(h.includes('>5 min<'), 'best: headline time is the winner (bike, 5 min)');
  ok(!h.includes('class="strip"'),
    'best: no transit line badges when transit is not the winner');
}

/* ---- a picked mode shows that mode and nothing else ---- */
for (const [mode, icon, want, other1, other2, dist] of [
  ['walk', '<ICON-walk>', '12 min', '5 min', '20 min', '900 m'],
  ['bike', '<ICON-bike>', '5 min', '12 min', '20 min', '1.1 km'],
]) {
  const h = render(mode), ml = modeline(h);
  ok(ml.includes(icon), `${mode}: its own row is present`, ml);
  ok(!ml.includes(other1) && !ml.includes(other2),
    `${mode}: no other mode's time leaks in`, ml);
  const NAME = { walk: 'Walk', bike: 'Bike' }[mode];
  ok(ml.includes(`<span class="mv-l">${NAME}</span>`), `${mode}: the row is named`, ml);
  ok(ml.includes('mv sel'), `${mode}: shown as the picked mode`, ml);
  ok(ml.includes(dist), `${mode}: distance shown`, ml);
  ok(!h.includes('class="strip"'), `${mode}: no transit line badges`);
  ok(h.includes(`>${want}<`), `${mode}: headline time is that mode's time`);
}

/* ---- transit keeps its line badges, and says the departure once ---- */
{
  const h = render('transit'), ml = modeline(h);
  ok(ml.includes('<ICON-tram>') && !ml.includes('<ICON-walk>') && !ml.includes('<ICON-bike>'),
    'transit: transit row only', ml);
  ok(ml.includes('<span class="mv-l">Transit</span>'), 'transit: the row is named', ml);
  ok(h.includes('class="strip"') && h.includes('>M4<'),
    'transit: line badges for the picked journey');
  ok((h.match(/dep 10:05/g) || []).length === 1,
    'transit: departure said once, not in both strip and modeline',
    (h.match(/dep 10:05/g) || []).length);
  ok(h.includes('>20 min<'), 'transit: headline time is the transit time');
}

/* ---- under Best, badges appear only when transit actually wins ---- */
{
  const slow = { i: 0, walk: { sec: 3600, km: 4.4 }, bike: { sec: 2400, km: 4.6 },
                 transit: { journeys: [journey] }, selJ: 0 };
  const h = render('best', null, slow);
  ok(h.includes('class="strip"') && h.includes('>M4<'),
    'best: badges appear when transit is the winning mode');
  ok((h.match(/dep 10:05/g) || []).length === 1, 'best+transit-wins: departure said once');
  const h2 = render('best');
  ok(!h2.includes('class="strip"') && h2.includes('dep 10:05'),
    'best+transit-loses: no strip, so the modeline keeps the departure');
}

/* ---- the expanded card drills into the mode you picked ---- */
{
  const hb = render('best', 0);
  ok(hb.includes('Departures') && hb.includes('class="dep"'),
    'best expanded: departures board');

  const hw = render('walk', 0);
  ok(hw.includes('>On foot<'), 'walk expanded: titled "On foot"');
  ok(!hw.includes('Departures') && !hw.includes('class="dep"'),
    'walk expanded: NO transit departures list');
  ok(hw.includes('data-gmode="walking"'), 'walk expanded: Google handoff is walking');
  ok(hw.includes('12 min') && hw.includes('900 m'), 'walk expanded: shows the leg detail');
  ok(hw.includes('data-go="0"'), 'walk expanded: Go button still present');

  const hk = render('bike', 0);
  ok(hk.includes('>By bike<'), 'bike expanded: titled "By bike"');
  ok(hk.includes('data-gmode="bicycling"'), 'bike expanded: Google handoff is bicycling');

  const ht = render('transit', 0);
  ok(ht.includes('Departures') && ht.includes('class="dep"'),
    'transit expanded: departures board');
  ok(!ht.includes('data-gmode'), 'transit expanded: Google handoff defaults to transit');
}

/* ---- missing or failed data degrades honestly ---- */
{
  const noBike = { i: 0, walk: { sec: 720, km: 0.9 }, bike: null,
                   transit: { journeys: [journey] }, selJ: 0 };
  const h = render('bike', 0, noBike);
  ok(modeline(h).includes('—'), 'bike missing: em-dash, never a fabricated number');
  ok(h.includes('No cycling route found'), 'bike missing: the board says so plainly');

  // VBB answered: there is genuinely no route
  const none = { i: 0, walk: { sec: 720 }, bike: { sec: 300 },
                 transit: { err: 'no route', kind: 'none' }, selJ: 0 };
  ok(modeline(render('transit', null, none)).includes('no route'),
    'transit absent: reads "no route"');

  // we could not ask — must never read as an absence of routes
  const down = { i: 0, walk: { sec: 720 }, bike: { sec: 300 },
                 transit: { err: 'service unavailable', kind: 'down' }, selJ: 0 };
  const hd = modeline(render('transit', null, down));
  ok(hd.includes('unavailable'), 'transit down: reads "unavailable"', hd);
  ok(!hd.includes('no route'), 'transit down: never claims no route exists', hd);

  const pend = { i: 0, walk: { sec: 720 }, bike: { sec: 300 }, transit: null, selJ: 0 };
  ok(modeline(render('transit', null, pend)).includes('…'),
    'transit pending: shows the waiting ellipsis');
}

done();
