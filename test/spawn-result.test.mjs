import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnError } from '../dist/spawn-result.js';
import { indexCacheRoot } from '../dist/index-cache.js';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const err = (code) => Object.assign(new Error(`spawnSync git ${code}`), { code });

test("a sandbox's EPERM after the child exited is forgiven; a child that did not run, timed out or was killed is not (T1258)", () => {
  assert.equal(spawnError({ error: err('EPERM'), status: 0, signal: null }), undefined, 'Codex read-only sandbox: ran and exited 0');
  assert.equal(spawnError({ error: err('EPERM'), status: 1, signal: null }), undefined, 'an optional probe that answered no');
  assert.equal(spawnError({ error: undefined, status: 0, signal: null }), undefined);
  assert.equal(spawnError({ error: err('EPERM'), status: null, signal: null })?.code, 'EPERM', 'never ran');
  assert.equal(spawnError({ error: err('EPERM'), status: null, signal: 'SIGTERM' })?.code, 'EPERM');
  assert.equal(spawnError({ error: err('ETIMEDOUT'), status: null, signal: 'SIGTERM' })?.code, 'ETIMEDOUT');
  assert.equal(spawnError({ error: err('ENOBUFS'), status: 0, signal: null })?.code, 'ENOBUFS', 'only EPERM is forgiven');
  assert.equal(spawnError({ error: err('ENOENT'), status: null, signal: null })?.code, 'ENOENT');
});

test('an index cache that cannot be created says to give --cache, instead of a bare error (T1258)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sassato-rocache-')), parent = join(dir, 'ro');
  mkdirSync(parent, { mode: 0o500 });
  t.after(() => { chmodSync(parent, 0o700); rmSync(dir, { recursive: true, force: true }); });
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  assert.throws(() => indexCacheRoot(join(parent, 'index')), (e) => e.code === 4 && /cannot be created here \(EACCES\); give --cache/.test(e.message));
});
