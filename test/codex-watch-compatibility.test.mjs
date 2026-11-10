import test from 'node:test';
import assert from 'node:assert/strict';
import { TESTED_CODEX_WATCH_VERSIONS, testedCodexWatchVersion } from '../dist/codex-watch-compatibility.js';

test('only one exact tested Codex version line enables the watcher',()=>{
  assert.deepEqual(TESTED_CODEX_WATCH_VERSIONS,['0.167.0']);
  assert.equal(testedCodexWatchVersion('Notice: update available\ncodex-cli 0.167.0\n'),'0.167.0');
  assert.equal(testedCodexWatchVersion('codex 0.167.0\r\n'),'0.167.0');
  for(const output of ['codex-cli 0.168.0','codex-cli 0.167.0-beta.1','codex-cli 0.167.0+custom',
    'pretending codex-cli 0.167.0','codex-cli 0.167.0\ncodex-cli 0.168.0','codex-cli 0.167.0\ncodex 0.167.0'])
    assert.equal(testedCodexWatchVersion(output),undefined,output);
});
