import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { initWorkspace } from '../dist/admin.js';
import { setFact, facts } from '../dist/coordination.js';
import { setWorkspaceSettings } from '../dist/workspace-settings.js';

const bin=resolve('bin/sassato.js');
function fixture(t,zone='America/New_York') {
  const dir=mkdtempSync(join(tmpdir(),'sassato-facts-')),db=join(dir,'state.db'),s=new Store(db,'writer',{create:true});
  initWorkspace(s,'team',{import_timezone:zone,roles:[{name:'writer'},{name:'reviewer'},{name:'human',kind:'human'}]});
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const raw=args=>spawnSync(process.execPath,[bin,'--db',db,'--workspace','team',...args],{encoding:'utf8',env:{...process.env,SASSATO_ROLE:''}});
  const run=args=>{const r=raw([...args,'--json']);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  return {s,raw,run};
}
function factAt(s,key,time) {
  const fact=setFact(s,key,{body:`Decision ${key}`,source:`decisions/${key}.md`});
  s.run('UPDATE facts SET updated_at=? WHERE id=?',time,Number(fact.id.slice(1)));
  return fact;
}

test('fact get and history show complete version text and localized provenance without changing JSON',t=>{
  const {s,raw,run}=fixture(t),body='Long decision text '.repeat(25)+'\nFinal paragraph survives plain output.';
  const first=setFact(s,'decision',{body,source:'decisions/one.md:12',checked_at:'2026-11-10T12:30:00Z'});
  const get=raw(['fact','get','decision']);assert.equal(get.status,0,get.stderr);
  assert.ok(get.stdout.includes(body));assert.match(get.stdout,/F1 decision · version 1/);
  assert.match(get.stdout,/set by writer at .* America\/New_York, source: decisions\/one.md:12/);
  assert.match(get.stdout,/checked at 2026-11-10 07:30:00 America\/New_York/);
  assert.deepEqual(run(['fact','get','decision']),[first]);
  s.actor='reviewer';const second=setFact(s,'decision',{body:'Revised full decision\nWith another paragraph.',source:'decisions/two.md:24',expected_version:1});
  const history=raw(['fact','history','decision']);assert.equal(history.status,0,history.stderr);
  assert.ok(history.stdout.includes(body));assert.ok(history.stdout.includes(second.body));
  assert.ok(history.stdout.indexOf('version 1')<history.stdout.indexOf('version 2'));
  assert.match(history.stdout,/set by writer at .*source: decisions\/one.md:12/);
  assert.match(history.stdout,/set by reviewer at .*source: decisions\/two.md:24/);
  assert.equal(run(['fact','history','decision'])[1].detail.after.body,second.body);
});

test('facts list newest updates first and --since uses the workspace calendar date in chronological order',t=>{
  const {s,raw,run}=fixture(t);
  factAt(s,'later','2026-11-10T06:00:00.000Z');
  factAt(s,'previous-local-day','2026-11-10T04:59:59.000Z');
  factAt(s,'midnight','2026-11-10T05:00:00.000Z');
  assert.deepEqual(run(['facts']).map(f=>f.key),['later','midnight','previous-local-day']);
  const since=run(['facts','--since','2026-11-10']);assert.deepEqual(since.map(f=>f.key),['midnight','later']);
  assert.deepEqual(run(['facts','--since','2026-11-10','--limit','1']).map(f=>f.key),['midnight']);
  const plain=raw(['facts','--since','2026-11-10']);assert.equal(plain.status,0,plain.stderr);
  assert.equal(plain.stdout.trim().split('\n').length,2);
  assert.match(plain.stdout,/2026-11-10 00:00:00 America\/New_York, source: decisions\/midnight.md/);
  for(const invalid of ['2026-02-30','not-a-date','123','2026-11-10T00:00:00Z']) {
    const result=raw(['facts','--since',invalid]);assert.equal(result.status,2);assert.match(result.stderr,/calendar date/);
  }
  assert.equal(raw(['context','--as','writer','--since','not-a-cursor']).status,2,'event cursors remain numeric');
});

test('date filtering includes both sides of a repeated DST hour and bounds pages before matching rows',t=>{
  const {s}=fixture(t);
  for(let n=0;n<105;n++)factAt(s,`old-${n}`,'2026-11-01T03:00:00.000Z');
  factAt(s,'first-hour','2026-11-01T05:30:00.000Z');factAt(s,'second-hour','2026-11-01T06:30:00.000Z');
  assert.deepEqual(facts(s,{since:'2026-11-01',limit:2}).map(f=>f.key),['first-hour','second-hour']);
  s.actor='human';setWorkspaceSettings(s,{import_timezone:'Pacific/Auckland'});
  assert.equal(facts(s,{since:'2026-11-02'}).length,0);
});
