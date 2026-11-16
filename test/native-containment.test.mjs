import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('native containment offline faults never launch a unit or provider', {skip:process.platform!=='linux'},()=>{
  const result=spawnSync('python3',['-B',resolve('test/native_containment_cases.py')],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  assert.match(result.stderr,/OK/);
});
