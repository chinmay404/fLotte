/* Runs every suite. Usage: node test.mjs */
import { spawnSync } from 'node:child_process';
const SUITES = ['engine.test.mjs', 'card.test.mjs', 'round.test.mjs',
                'filter.test.mjs', 'outage.test.mjs', 'dot.test.mjs',
                'hours.test.mjs', 'lang.test.mjs', 'adhoc.test.mjs'];
let bad = 0, total = 0;
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [s], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/all (\d+) passed|(\d+) FAILED, (\d+) passed/);
  if (r.status === 0) {
    total += Number(m?.[1] ?? m?.[3] ?? 0);
    console.log(`  ok   ${s.padEnd(18)} ${m ? m[0] : ''}`);
  } else {
    bad++;
    console.log(`  FAIL ${s.padEnd(18)} ${m ? m[0] : 'crashed'}`);
    console.log(out.split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 6)
      .map(l => '        ' + l).join('\n'));
  }
}
console.log(bad ? `\n${bad} suite(s) failed` : `\nall ${SUITES.length} suites green, ${total} assertions`);
process.exit(bad ? 1 : 0);
