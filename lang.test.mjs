/* German: every key must exist in both languages, and rendering under de must
   not leak the English copy. The data is already German; only the app's own
   words were not.  Run: node lang.test.mjs                                    */
import { fn, chunk, engineSrc, i18nSrc, sandbox, harness, TEMPLATE } from './testkit.mjs';

const { ok, eq, done } = harness('lang');

/* ---- the table itself ---- */
const tbl = sandbox([], {}, chunk(/var STR = \{[\s\S]*?\n\};/, 'STR'));
const { en, de } = tbl.STR;
{
  const enK = Object.keys(en), deK = Object.keys(de);
  eq(enK.length, deK.length, 'both languages define the same number of keys');
  eq(enK.filter(k => !(k in de)), [], 'no key is missing from German');
  eq(deK.filter(k => !(k in en)), [], 'no key exists only in German');

  // plural forms must match shape, or T() would pick a missing branch
  const shape = k => (typeof en[k] === 'object' ? 'plural' : 'flat');
  const wrong = enK.filter(k => shape(k) !== (typeof de[k] === 'object' ? 'plural' : 'flat'));
  eq(wrong, [], 'plural keys are plural in both languages');
  Object.keys(en).filter(k => typeof en[k] === 'object').forEach(k => {
    ok('one' in en[k] && 'other' in en[k] && 'one' in de[k] && 'other' in de[k],
      `plural key "${k}" has one and other in both`);
  });

  // every {placeholder} in English must also appear in German, or data vanishes
  const ph = v => [...String(v).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  const flat = v => (typeof v === 'object' ? Object.values(v).join(' ') : v);
  const lost = Object.keys(en).filter(k =>
    ph(flat(en[k])).join() !== ph(flat(de[k])).join());
  eq(lost, [], 'no placeholder is dropped or renamed in the German copy');

  // nothing left untranslated by copy-paste
  const same = Object.keys(en).filter(k => flat(en[k]) === flat(de[k]))
    // legitimately identical: a brand name, and a unit symbol
    .filter(k => !['maps', 'aboutKm'].includes(k));
  eq(same, [], 'no German value is just the English one');
}

/* ---- T() behaviour ---- */
const t = sandbox([], { LANG: 'en' }, i18nSrc());
{
  t.LANG = 'en';
  eq(t.T('mBike'), 'Bike', 'T: English lookup');
  t.LANG = 'de';
  eq(t.T('mBike'), 'Rad', 'T: German lookup');
  eq(t.T('nBikes', { n: 1 }), '<b>1</b> gemeldetes Rad', 'T: German singular');
  eq(t.T('nBikes', { n: 3 }), '<b>3</b> gemeldete Räder', 'T: German plural');
  eq(t.T('nStations', { n: 1 }), '<b>1</b> Standort', 'T: singular station');
  eq(t.T('nStations', { n: 2 }), '<b>2</b> Standorten', 'T: dative plural for "an ..."');
  eq(t.T('resume', { label: 'Alexanderplatz' }), 'Neu starten ab Alexanderplatz',
    'T: interpolates');
  eq(t.T('no-such-key'), 'no-such-key', 'T: a missing key degrades to the key, never throws');
  eq(t.T('mBike', null), 'Rad', 'T: tolerates no params');
  t.LANG = 'xx';
  eq(t.T('mBike'), 'Bike', 'T: an unknown language falls back to English');
  t.LANG = 'de';
}

/* ---- the round bar renders in German, with no English left ---- */
{
  const NOW = Date.parse('2026-08-17T10:00:00Z');
  const sb = sandbox(
    ['esc', 'mins', 'km', 'clock', 'hhmm', 'here', 'visitedIdx', 'depBaseMs', 'baseFuture',
     'defectiveAt', 'defectStations', 'tourRemaining', 'roundCosting', 'costingLabel',
     'transitSec', 'timeFor', 'bestMode', 'orderModeMismatch', 'missionHTML'],
    { IC: { wrench: '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
              pin: '<svg viewBox="0 0 24 24"><path d="M12 2v20"/></svg>' },
      LOCATIONS: [{ _i: 0, location_name: 'Station A', items: [{ id: 1 }, { id: 2 }] },
                  { _i: 1, location_name: 'Station B', items: [{ id: 3 }] }],
      defects: new Set([1, 2, 3]), repaired: new Set([9]),
      mission: true, addingStop: false, trip: [{ lat: 52.5, lon: 13.4, label: 'Depot', i: null, sec: 0 }],
      options: [], modePref: 'bike', Date,
      tour: { order: [0, 1], dropped: [], totalSec: 1200, estimated: false,
              altTotals: {}, costing: 'bicycle', timed: false, baseMs: NOW } },
    engineSrc() + '\n' + i18nSrc());

  sb.LANG = 'de';
  const bar = sb.missionHTML();
  ok(bar.includes('Reparatur-Runde'), 'round bar is German', bar.slice(0, 90));
  ok(bar.includes('gemeldete Räder'), 'plural noun agrees');
  ok(bar.includes('beste Reihenfolge mit dem Rad'), 'the costing label is German too');
  ok(bar.includes('Beenden'), 'Exit is German');
  for (const word of ['Repair round', 'flagged bike', 'station', 'best order',
                      'by bike', 'travel', 'Exit', 'repaired'])
    ok(!bar.includes(word), `no English "${word}" leaks into the German bar`);

  sb.LANG = 'en';
  const en2 = sb.missionHTML();
  ok(en2.includes('Repair round') && en2.includes('flagged bike'),
    'and English still renders');
  ok(!en2.includes('Reparatur'), 'with no German left in it');
}

/* ---- the modeline labels are localised, not raw mode keys ---- */
{
  const body = fn('optHTML');
  ok(/mv\(IC\.walk, T\('mWalk'\)/.test(body), 'the walk row label goes through T()');
  ok(/mv\(IC\.bike, T\('mBike'\)/.test(body), 'the bike row label goes through T()');
  ok(/T\('mTransit'\)/.test(body), 'the transit row label goes through T()');
  ok(!/mv\(IC\.\w+, '(walk|bike|transit)'/.test(body),
    'no raw mode key is used as a visible label');
}

/* ---- the shell and the toggle ---- */
{
  ok(/lang="en"/.test(TEMPLATE), 'the document declares a language');
  ok(/id="langbtn"/.test(TEMPLATE), 'a language toggle exists');
  ok(/flotte-lang/.test(TEMPLATE), 'the choice is remembered');
  const st = fn('applyStaticText');
  ok(/searchPlaceholder/.test(st) && /filters/.test(st),
    'the static HTML strings are swapped too, not just the rendered ones');
  ok(/setAttribute\('lang'/.test(fn('setLang')), 'switching updates the lang attribute');
  ok(/var LANG = 'de'/.test(TEMPLATE), 'German is the default, since the repairer is German');
}

done();
