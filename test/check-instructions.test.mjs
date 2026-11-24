import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (args) => spawnSync(process.execPath, [resolve('scripts/check-instructions.mjs'), ...args], { encoding: 'utf8' });

test('check-instructions reports the command lines a build no longer accepts, and only those', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-instructions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const md = join(dir, 'RULES.md'), txt = join(dir, 'prompt.txt');
  writeFileSync(md, [
    'Start with `sas context --as <role> --brief` and read `sas inbox`.',
    'A sassato fact is prose; so is (sas block T --kind other --waits-on\nfable) and (sas take T1 --nope).',
    'Review with `sas review T<n> --approve|--reject --expect <version> --note "…"`.',
    'Save: `V=$(sassato wip show --as c | grep version)` then `sas checkpoint save … --expect V`.',
    '```sh',
    'sas topic add "A thread" --keeper a',
    'sas take T1 --frobnicate',
    '```',
    'Old: `sas humans --since 3` and `sas launder T1` and `sas review T1 --approve|--nope`.',
    'Missing value: `sas take T1 --hours`.',
  ].join('\n'));
  writeFileSync(txt, 'First run sassato context --as c --brief. Then sassato done T1 --ref x, and stop.\n');
  const r = run(['--json', md, txt]);
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.checked, 15);
  assert.deepEqual(report.failures.map((f) => [f.line, f.reason]), [
    [3, "Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--nope\""],
    [8, "Unknown option '--frobnicate'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--frobnicate\""],
    [10, '--since does not apply to humans'],
    [10, 'Unknown command launder'],
    [10, "Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--nope\""],
    [11, "Option '--hours <value>' argument missing"],
  ]);
  assert.deepEqual(report.unreadable, []);

  const clean = run(['--unused', txt]);
  assert.equal(clean.status, 0, clean.stdout);
  assert.match(clean.stdout, /^Checked 2 command lines in 1 of 1 sources against sassato /);
  assert.match(clean.stdout, /\n {2}humans\n/);
  assert.doesNotMatch(clean.stdout, /\n {2}context --brief\n/);
  assert.match(clean.stdout, /\n {2}context --since\n/);

  assert.equal(run([join(dir, 'missing.md')]).status, 1);
  assert.equal(run([]).status, 2);
});
