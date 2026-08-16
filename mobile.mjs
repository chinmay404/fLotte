/* Mobile smoke: phone viewport, bottom sheet, peek bar, declutter.
   Run:  node mobile.mjs  */
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9334;
const URL_ = 'file:///D:/new/Flotte/index.html';
function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
  for (const c of cands) if (existsSync(c)) return c;
  return execSync('where msedge', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, d) => c ? (passed++, console.log('  ok -', n))
  : (failed++, console.error('  FAIL -', n, d === undefined ? '' : JSON.stringify(d)));

const edge = spawn(findEdge(), [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'flotte-mob-'))}`, '--disable-extensions', URL_
], { stdio: 'ignore' });

let ws;
try {
  let target = null;
  for (let t = 0; t < 40 && !target; t++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(x => x.type === 'page' && x.url.startsWith('file:'));
    } catch {}
  }
  if (!target) throw new Error('no CDP target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const errs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      if (!String(d.url || '').startsWith('chrome-extension'))
        errs.push(d.exception?.description || d.text);
    }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evl = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(name, Buffer.from(r.result.data, 'base64'));
    console.log('screenshot ->', name);
  };
  const state = () => evl('window.__flotte && __flotte.state()');
  const until = async (fn, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      const s = await fn(); if (s) return s;
      if (Date.now() - t0 > ms) throw new Error('timeout: ' + label);
      await sleep(1200);
    }
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await evl('location.reload()'); await sleep(1500);
  await until(() => evl('!!window.__flotte'), 20000, 'boot');

  let s = await state();
  ok(s.sheet.mobile, 'mobile media query active', s.sheet);
  ok(s.sheet.y && s.sheet.y.includes('translateY'), 'sheet positioned via transform', s.sheet);
  ok(s.dots > 200, 'idle: all station dots visible', s.dots);
  await shot('mob-1-start.png');

  await evl(`__flotte.start(52.5075, 13.4040, 'Alexanderplatz-ish')`);
  s = await until(async () => { const x = await state(); return x.busy ? null : x; },
    120000, 'options');
  ok(s.sheet.pos === 'half', 'start snaps sheet to half', s.sheet);
  ok(s.dots === 0, 'active trip: base dots fully hidden', s.dots);
  ok(s.lineCounts.preview >= 1, 'top option auto-previews its route', s.lineCounts);
  const pk = await evl(`(function(){ var p = document.querySelector('[data-pk]');
    return p ? {i: +p.getAttribute('data-pk'), text: p.textContent.trim().slice(0, 80)} : null; })()`);
  ok(pk && pk.i === s.options[0].i, 'peek bar shows the top option', pk);
  await shot('mob-2-options-half.png');

  await evl(`__flotte.sheetTo('peek')`); await sleep(600);
  await shot('mob-3-peek.png');
  await evl(`__flotte.sheetTo('full')`); await sleep(600);
  await shot('mob-4-full.png');

  /* choose via the peek-bar Go: route persists, sheet drops to peek */
  await evl(`__flotte.sheetTo('peek')`); await sleep(400);
  await evl(`document.querySelector('[data-pk] .pk-go').closest('[data-pk]') &&
    (function(){ var pk = document.querySelector('[data-pk]');
      pk.querySelector('.pk-go').dispatchEvent(new MouseEvent('click', {bubbles:true})); })()`);
  s = await until(async () => { const x = await state(); return x.trip.length === 2 ? x : null; },
    10000, 'choose via Go');
  ok(s.trip.length === 2, 'peek-bar Go commits the hop');
  ok(s.sheet.pos === 'peek', 'choosing drops sheet to peek', s.sheet);
  s = await until(async () => { const x = await state(); return x.busy ? null : x; },
    120000, 'hop 2 options');
  s = await until(async () => { const x = await state(); return x.lineCounts.trip >= 1 ? x : null; },
    15000, 'trip line').catch(() => null);
  ok(!!s, 'committed route drawn', s && s.lineCounts);
  await shot('mob-5-en-route.png');

  ok(errs.length === 0, 'no page exceptions', errs.slice(0, 3));
} catch (e) {
  failed++; console.error('FAIL -', e.message);
} finally {
  try { ws && ws.close(); } catch {}
  edge.kill();
}
console.log(failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
