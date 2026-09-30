/* Runs the whole test suite.  Usage:  node test/run.mjs
 *
 * card-parser and orchestrator need jsdom. Point JSDOM_PATH at
 * node_modules/jsdom/lib/api.js, or `npm i -D jsdom`, and they will be
 * skipped with a note instead of failing when it is unavailable. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  'merge.test.mjs',
  'xlsx.test.mjs',
  'background.test.mjs',
  'card-parser.test.mjs',
  'orchestrator.test.mjs'
];
const needsJsdom = new Set(['card-parser.test.mjs', 'orchestrator.test.mjs']);

let failed = 0;
let skipped = 0;
let totalPass = 0;

for (const s of suites) {
  process.stdout.write(`\n=== ${s} ===\n`);
  /* capture, then echo, so the jsdom-missing marker can be detected */
  const r = spawnSync(process.execPath, [join(here, s)], { encoding: 'utf8', env: process.env });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(out);

  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (m) totalPass += Number(m[1]);

  if (r.status === 0) continue;

  const jsdomMissing = /jsdom not found|Cannot find package 'jsdom'|ERR_MODULE_NOT_FOUND[\s\S]*jsdom/.test(out);
  if (needsJsdom.has(s) && jsdomMissing) {
    console.log(`  SKIPPED - jsdom unavailable. Install it or set JSDOM_PATH.`);
    skipped++;
    continue;
  }
  failed++;
}

console.log(`\n${'-'.repeat(46)}`);
console.log(`${totalPass} assertions passed`);
if (failed) console.log(`${failed} suite(s) FAILED`);
else if (skipped) console.log(`All suites passed (${skipped} skipped: jsdom not installed)`);
else console.log('All suites passed');
process.exit(failed ? 1 : 0);
