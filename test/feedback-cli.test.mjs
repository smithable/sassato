import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const bin=resolve('bin/sassato.js');
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'sassato-feedback-')),db=join(dir,'state.db');t.after(()=>rmSync(dir,{recursive:true,force:true}));const args=['--db',db,'--workspace','team'],stopFile=join(dir,'absent-stop');function raw(a){if(a[0]==='init')a=[...a,'--config',fixtureConfig];if(a[0]==='wait')a=[...a,'--stop-file',stopFile];return spawnSync(process.execPath,[bin,...args,...a],{encoding:'utf8',env:{...process.env,SASSATO_ROLE:''}});}function run(a){const r=raw([...a,'--json']);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}run(['init']);return {args,raw,run,stopFile};}
test('version identifies the package build without opening a database',t=>{
 const {run}=fixture(t),info=run(['--version']),pkg=JSON.parse(readFileSync('package.json','utf8'));assert.equal(info.version,pkg.version);assert.match(info.build,/^[a-f0-9]{16}$/);assert.ok(Date.parse(info.built_at));
});
test('task pages expose a continuation in JSON and terminal output',t=>{
 const {run,raw}=fixture(t);const tasks=[1,2,3].map(n=>run(['add',`Task ${n}`,'--as','a']));
 const page=run(['tasks','--limit','2']);assert.equal(page.items.length,2);assert.equal(page.has_more,true);assert.equal(page.next_after,tasks[1].id);
 const next=run(['tasks','--limit','2','--after',page.next_after]);assert.equal(next.items[0].id,tasks[2].id);assert.equal(next.has_more,false);
 assert.match(raw(['tasks','--limit','2']).stdout,/More tasks exist.*--after T2/);
});
test('CLI waiter exits on later urgent mail, prints one line, and timeout exits 5',async t=>{
 const {args,run,raw,stopFile}=fixture(t);
 const child=spawn(process.execPath,[bin,...args,'wait','--urgent','--as','b','--timeout','3','--stop-file',stopFile],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill();});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const done=new Promise(resolveExit=>child.on('close',code=>resolveExit(code)));
 const message=run(['send','b','Please inspect the failure','--urgent','--as','a']);assert.equal(message.urgent,true);
 assert.equal(await done,0,err);assert.match(out,/^URGENT M\d+ from a: Please inspect the failure · cursor \d+\n$/);
 assert.equal(run(['inbox','--peek','--as','b'])[0].state,'unread');run(['inbox','--as','b']);
 const timed=raw(['wait','--urgent','--timeout','1','--as','b','--json']);assert.equal(timed.status,5,timed.stderr);assert.equal(JSON.parse(timed.stdout).reason,'timeout');
 assert.equal(raw(['wait','--as','b','--timeout','1']).status,5);
});
test('answer --close completes a human-only task without a separate claim',t=>{
 const {run}=fixture(t);const task=run(['add','Human decision','--human-only','--as','a']);const q=run(['ask-human',task.id,'Approve?','--as','a']);run(['answer',q.id,'yes','--close','--as','human']);assert.equal(run(['show',task.id]).status,'done');
});

test('wait --since catches a human answer committed between context and watcher startup',t=>{
 const {run}=fixture(t);const task=run(['add','Decision for B','--as','b']);const q=run(['ask-human',task.id,'Choose an approach','--as','b']);
 const cursor=run(['context','--as','b']).snapshot_cursor;run(['answer',q.id,'Proceed with the small change','--as','human']);
 const event=run(['wait','--since',String(cursor),'--as','b','--timeout','1']);assert.equal(event.reason,'answer');assert.equal(event.question,q.id);assert.equal(event.task,task.id);assert.ok(event.cursor>cursor);
 assert.equal(run(['inbox','--peek','--as','b'])[0].state,'unread','workflow notification does not consume ordinary answer mail');
});
test('wait distinguishes blocked assignment from resolved work and ignores ordinary mail',t=>{
 const {run,raw}=fixture(t);const cursor=run(['context','--as','b']).snapshot_cursor;
 const task=run(['add','Assigned but blocked','--owner','b','--as','a']);const blocker=run(['block',task.id,'Needs operator','--kind','human','--waits-on','human','--as','b']);
 const assigned=run(['wait','--since',String(cursor),'--as','b','--timeout','1']);assert.equal(assigned.reason,'task-assigned');assert.equal(assigned.task,task.id);
 run(['send','b','Ordinary update','--as','a']);const timed=raw(['wait','--since',String(assigned.cursor),'--as','b','--timeout','1','--json']);assert.equal(timed.status,5,timed.stderr);
 const nextCursor=JSON.parse(timed.stdout).cursor;run(['resolve',blocker.id,'Operator finished','--as','human']);
 const ready=run(['wait','--since',String(nextCursor),'--as','b','--timeout','1']);assert.equal(ready.reason,'blocker-resolved');assert.equal(ready.blocker,blocker.id);assert.equal(ready.task,task.id);
});
