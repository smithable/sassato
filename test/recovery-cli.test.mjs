import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/storage.js';
import { requestStop } from '../dist/control.js';

const cli=resolve('bin/sassato.js');
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-recovery-cli-')),db=join(dir,'state.db');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const raw=args=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','demo','--as','builder','--json',...args],{cwd:dir,encoding:'utf8',timeout:5000});
  const run=args=>{const result=raw(args);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  run(['init']);return {dir,db,raw,run};
}
const fields=['--current','Parser implemented','--next','Check the public API','--notes','Preserve interface; see validation evidence'];

test('CLI stores bounded evidence as claims alongside observed repository, task and progress state',t=>{
  const f=fixture(t),path=join(f.dir,'evidence.json');
  const evidence={version:1,validation:[{command:'npm test',result:'Passed in prior run'}],artifacts:['logs/test.txt'],jobs:[{id:'tests',description:'Test process',state:'completed',disposition:'finish'}]};
  writeFileSync(path,JSON.stringify(evidence));
  const task=f.run(['add','Parser task','--owner','builder']);
  f.run(['take',task.id]);const progress=f.run(['progress','save','--cursor','0','--expect','0']);
  const saved=f.run(['checkpoint','save',...fields,'--evidence',path]);
  const shown=f.run(['checkpoint','show']);assert.equal(shown.id,saved.id);
  assert.deepEqual(shown.evidence.reported,evidence);
  assert.equal(shown.evidence.observed.repository.status,'unavailable');
  assert.equal(shown.evidence.observed.repository.directory,f.dir);
  assert.equal(shown.evidence.observed.tasks.items[0].id,task.id);
  assert.equal(shown.evidence.observed.tasks.items[0].version,2);
  assert.equal(shown.evidence.observed.notification_progress.id,progress.id);
  const view=f.run(['context','--brief']);
  assert.equal(view.sections.notification_progress[0].cursor,0);
  assert.equal(view.sections.notification_progress[0].version,1);
  assert.ok(JSON.stringify(view).length<=5800);
  assert.equal(JSON.stringify(view).includes('Passed in prior run'),false,'claims belong in full checkpoint, not bounded context');
});

test('CLI rejects invalid, oversized and non-file evidence without updating WIP',t=>{
  const f=fixture(t),path=join(f.dir,'evidence.json');
  for(const value of ['{',' '.repeat(32769),JSON.stringify({version:1,validation:[],artifacts:[],jobs:[],unrecognized:true})]) {
    writeFileSync(path,value);
    assert.equal(f.raw(['checkpoint','save',...fields,'--evidence',path]).status,2);
    assert.equal(f.run(['wip']).version,0);
    assert.equal(f.run(['checkpoint','show']),null);
  }
  assert.equal(f.raw(['checkpoint','save',...fields,'--evidence',f.dir]).status,2);
  assert.equal(f.raw(['checkpoint','save',...fields,'--evidence',join(f.dir,'missing.json')]).status,2);
  const saved=f.run(['checkpoint','save',...fields]);
  assert.equal(saved.evidence.reported,null);
  assert.ok(saved.missing_evidence.length>0);
});

test('CLI progress persists only handled cursor, replays across processes, and keeps later events',t=>{
  const f=fixture(t);assert.equal(f.run(['progress','show']),null);
  const initial=f.run(['progress','save','--cursor','0','--expect','0']);
  const first=f.run(['add','First notification','--owner','builder']);
  const received=f.run(['wait','--timeout','1']);assert.equal(received.task,first.id);
  const again=f.run(['wait','--timeout','1']);assert.equal(again.cursor,received.cursor);
  const second=f.run(['add','Arrived during handling','--owner','builder']);
  const handled=f.run(['progress','save','--cursor',String(received.cursor),'--expect',String(initial.version)]);
  const retry=f.run(['progress','save','--cursor',String(received.cursor),'--expect',String(initial.version)]);
  assert.equal(retry.id,handled.id);
  const later=f.run(['wait','--timeout','1']);assert.equal(later.task,second.id);assert.ok(later.cursor>handled.cursor);
  assert.equal(f.run(['progress','show']).id,handled.id,'waiting never advances durable progress');
  assert.equal(f.raw(['progress','save','--cursor',String(later.cursor),'--expect','1']).status,4);
  assert.equal(f.raw(['progress','save','--cursor','0','--expect','2']).status,4);
  assert.equal(f.raw(['progress','save','--cursor',String(later.cursor)]).status,2);
});

test('malformed progress is visible without hiding STOP or silently choosing a new cursor',t=>{
  const f=fixture(t),s=new Store(f.db,'human');s.use('demo');
  try {
    s.tx(()=>s.event('notification-progress','builder','saved',{format:999,cursor:0,version:1}));
    requestStop(s,['builder']);
  } finally {s.close();}
  assert.equal(f.raw(['progress','show']).status,4);
  const view=f.run(['context']);
  assert.equal(view.sections.notification_progress[0].state,'invalid');
  assert.equal(view.sections.notification_progress[0].cursor,undefined);
  assert.equal(view.sections.stop.length,1);
  assert.ok(JSON.stringify(view).length<=5800);
});
