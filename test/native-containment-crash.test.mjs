import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('controller crash protocol uses only a fixed offline child and temporary evidence', {skip:process.platform!=='linux'},()=>{
  const result=spawnSync('python3',['-B',resolve('test/native_containment_crash_cases.py')],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  assert.match(result.stderr,/OK/);
});
