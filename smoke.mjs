/* End-to-end smoke test: drives index.html in headless Edge over CDP against
   the real Valhalla + VBB APIs.  Run:  node smoke.mjs   (takes ~2 min)      */
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const PORT = 9333;
const URL_ = 'file:///D:/new/Flotte/index.html';

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (existsSync(c)) return c;
  try { return execSync('where msedge', { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); }
  catch { throw new Error('msedge.exe not found'); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log('  ok -', name); }
  else { failed++; console.error('  FAIL -', name, detail === undefined ? '' : JSON.stringify(detail)); }
};

const profile = mkdtempSync(join(tmpdir(), 'flotte-smoke-'));
const edge = spawn(findEdge(), [
  `--headless=new`, `--remote-debugging-port=${PORT}`, `--remote-allow-origins=*`,
  `--user-data-dir=${profile}`, `--window-size=1280,900`, '--disable-extensions', URL_
], { stdio: 'ignore' });

let ws;
try {
  /* attach to the page target */
  let target = null;
  for (let t = 0; t < 40 && !target; t++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(x => x.type === 'page' && x.url.startsWith('file:'));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('no CDP page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      if (!String(d.url || '').startsWith('chrome-extension'))
        pageErrors.push(d.exception?.description || d.text);
    }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evl = async expr => {
    const r = await send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails)
      throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails.exception?.description
        || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  const state = () => evl('window.__flotte && __flotte.state()');
  const until = async (fn, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      const s = await fn();
      if (s) return s;
      if (Date.now() - t0 > ms) throw new Error('timeout: ' + label);
      await sleep(1200);
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await until(() => evl('!!window.__flotte'), 20000, 'app boot');
  console.log('app booted');

  /* ---- single trip: start near Spittelmarkt, wait for full option list ---- */
  await evl(`__flotte.start(52.5075, 13.4040, 'Smoke start')`);
  let s = await until(async () => { const x = await state(); return x.busy ? null : x; },
    120000, 'first hop options');
  console.log('hop 1 options:', s.options.map(o => `${o.i}${o.viaScan ? '*' : ''}`).join(', '),
    '| scan:', JSON.stringify(s.scanInfo));
  ok(s.options.length >= 5, 'at least 5 options', s.options.length);
  ok(s.options.every(o => o.hasTransit), 'every option got a transit check');
  ok(s.scanInfo && s.scanInfo.ok, 'transit scan ran', s.scanInfo);
  ok(s.farKm === null, 'start not flagged as far', s.farKm);
  const times = s.options.map(o => o.best).filter(v => v != null);
  ok(times.length > 0 && Math.min(...times) === times[0], 'list led by fastest option', times);

  /* ---- choose the top option: trip line must appear and persist ---- */
  await evl(`__flotte.choose(${s.options[0].i})`);
  s = await until(async () => { const x = await state(); return x.busy ? null : x; },
    120000, 'second hop options');
  ok(s.trip.length === 2, 'trip has 2 stops', s.trip.length);
  s = await until(async () => {
    const x = await state(); return x.lineCounts.trip >= 1 ? x : null;
  }, 15000, 'committed route drawn').catch(() => null);
  ok(!!s, 'chosen route stays drawn on the map', s && s.lineCounts);

  /* ---- repair round: flag bikes at 4 far-apart unvisited stations ---- */
  const ids = await evl(`(function(){
    var P = JSON.parse(document.getElementById('payload').textContent).locations;
    var visited = __flotte.state().trip.map(function(t){ return t.i; });
    var picks = [], want = [3, 60, 130, 210];
    for (var w = 0; w < want.length; w++) {
      for (var k = want[w]; k < P.length; k++) {
        if (visited.indexOf(k) === -1 && P[k].items.length && picks.indexOf(k) === -1) {
          picks.push(k); break;
        }
      }
    }
    return picks.map(function(k){ return P[k].items[0].id; });
  })()`);
  ok(ids.length === 4, 'flagged 4 bikes for the round', ids);
  await evl(`__flotte.startRound(${JSON.stringify(ids)})`);
  s = await until(async () => { const x = await state(); return x.busy ? null : x; },
    150000, 'round options');
  ok(s.mission, 'mission active');
  ok(s.tour && s.tour.order.length === 4, 'tour plans all 4 stations', s.tour);
  ok(s.tour && !s.tour.estimated, 'tour used real road matrix', s.tour);
  ok(s.options.length > 0 && s.tour && s.options[0].i === s.tour.order[0],
    'recommended next pinned first', { first: s.options[0], order: s.tour.order });
  s = await until(async () => {
    const x = await state(); return x.lineCounts.tour >= 1 ? x : null;
  }, 20000, 'tour drawn').catch(() => null);
  ok(!!s, 'planned round drawn on the map', s && s.lineCounts);

  /* ---- follow the plan one hop: tour shrinks, stays consistent ---- */
  if (s && s.tour) {
    await evl(`__flotte.choose(${s.tour.order[0]})`);
    s = await until(async () => { const x = await state(); return x.busy ? null : x; },
      150000, 'round hop 2');
    ok(s.tour && s.tour.order.length === 3, 'tour replanned to 3 remaining', s.tour);
    ok(s.trip.length === 3, 'trip has 3 stops');
  }

  /* ---- Done on a flagged bike: greys out, station leaves the plan ---- */
  if (s && s.tour) {
    const before = s.flags;
    const clicked = await evl(`(function(){
      var b = document.querySelector('.donebtn');
      if (!b) return false;
      b.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      return true;
    })()`);
    ok(clicked, 'Done button present on flagged bike card');
    s = await until(async () => { const x = await state(); return x.busy ? null : x; },
      150000, 'replan after Done');
    ok(s.flags.defects === before.defects - 1 && s.flags.repaired === before.repaired + 1,
      'Done moves bike from flagged to repaired', s.flags);
    ok(s.tour && s.tour.order.length === 2, 'repaired station left the plan', s.tour);
  }

  ok(pageErrors.length === 0, 'no page exceptions', pageErrors.slice(0, 3));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('smoke.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot -> smoke.png');
} catch (e) {
  failed++;
  console.error('FAIL -', e.message);
} finally {
  try { ws && ws.close(); } catch {}
  edge.kill();
}
console.log(failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
