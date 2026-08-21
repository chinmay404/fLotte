/* Shared plumbing for the render/behaviour test suites.

   template.html is one big IIFE around a Leaflet map, so it cannot be imported.
   Instead each suite pulls the *named functions it needs* out of the source by
   brace-counting, runs them in a vm context, and stubs the surrounding globals.
   That keeps the tests honest — they execute the shipped code, not a copy — at
   the cost of listing dependencies explicitly.

   engine.test.mjs does not use this: the pure engine has its own markers.      */
import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';

const HERE = new URL('.', import.meta.url);
export const TEMPLATE = readFileSync(new URL('template.html', HERE), 'utf8');
export const PAGE = readFileSync(new URL('index.html', HERE), 'utf8');

/* Blank out strings, comments and regex literals so their braces don't count. */
function stripCode(line) {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[(,=:!&|?;+[])\s*\/(?:[^/\\\n[]|\\.|\[[^\]]*\])+\/[gimsuy]*/g, '$1 RE ')
    .replace(/\/\/.*$/, '');
}

const LINES = TEMPLATE.split('\n');

/** Source of one top-level `function name(...){...}` from template.html. */
export function fn(name) {
  const start = LINES.findIndex(l => new RegExp('^(?:async )?function ' + name + '\\(').test(l));
  if (start === -1) throw new Error(`testkit: no top-level function "${name}" in template.html`);
  let depth = 0, opened = false;
  for (let k = start; k < LINES.length; k++) {
    for (const ch of stripCode(LINES[k])) {
      if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
    }
    if (opened && depth === 0) {
      const block = LINES.slice(start, k + 1).join('\n');
      if ((block.match(/^(?:async )?function /gm) || []).length !== 1)
        throw new Error(`testkit: over-captured "${name}"`);
      new Script(block);                       // must parse standalone
      return block;
    }
    if (depth < 0) break;
  }
  throw new Error(`testkit: unbalanced braces extracting "${name}"`);
}

/** The pure engine, verbatim, for suites that need FlotteEngine. */
export function engineSrc() {
  const m = TEMPLATE.match(/\/\*ENGINE-START\*\/([\s\S]*?)\/\*ENGINE-END\*\//);
  if (!m) throw new Error('testkit: no ENGINE-START/END block');
  return m[1];
}

/** A module-scope declaration block, matched by regex (e.g. the facet consts). */
export function chunk(re, label) {
  const m = TEMPLATE.match(re);
  if (!m) throw new Error(`testkit: chunk not found: ${label || re}`);
  return m[0];
}

/** The real icon set, so rendered markup looks like the app's. */
export function iconSrc() { return chunk(/var IC = \{[\s\S]*?\n\};/, 'IC'); }

/** All <style> blocks concatenated — for suites that dump HTML to look at. */
export function css() {
  return [...TEMPLATE.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
}

/** The inlined station payload from the built page. */
export function payload() {
  const m = PAGE.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('testkit: no payload in index.html — run build.py');
  const p = JSON.parse(m[1]);
  p.locations.forEach((l, i) => { l._i = i; });
  return p;
}

/** Build a vm context with `names` extracted from template.html plus `globals`. */
export function sandbox(names, globals, extraSrc = '') {
  const sb = Object.assign({ Math, JSON, String, Number, Array, Object, Set, Map,
                             Promise, parseInt, parseFloat, isNaN, console }, globals);
  const ctx = createContext(sb);
  runInContext(extraSrc + '\n' + names.map(fn).join('\n'), ctx);
  return sb;
}

/** Tiny assertion harness, same shape as engine.test.mjs. */
export function harness(title) {
  let passed = 0, failed = 0;
  const ok = (cond, name, detail) => {
    if (cond) { passed++; console.log('  ok  -', name); }
    else { failed++; console.error('  FAIL -', name, detail === undefined ? '' : detail); }
  };
  const eq = (a, b, name) =>
    ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
  const done = () => {
    console.log(failed ? `\n${title}: ${failed} FAILED, ${passed} passed`
                       : `\n${title}: all ${passed} passed`);
    process.exit(failed ? 1 : 0);
  };
  return { ok, eq, done, count: () => ({ passed, failed }) };
}
