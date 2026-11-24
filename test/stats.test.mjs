import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {AppError} from '../dist/errors.js';
import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/storage.js';
import {initWorkspace} from '../dist/admin.js';
import {send,inbox,context} from '../dist/coordination.js';
import {saveNotificationProgress} from '../dist/notification-progress.js';
import {addTask,takeTask,submitTask,reviewTask,askHuman,showTask,noteTask,doneTask,recordRefusal} from '../dist/tasks.js';
const cli=new URL('../bin/sassato.js',import.meta.url).pathname;
import {stats,formatStats} from '../dist/stats.js';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sassato-stats-')),path=join(dir,'state.db'),s=new Store(path,'a',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');
  t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});
  return s;
}
const later=minutes=>new Date(Date.now()+minutes*60_000);

test('stats reports unread mail, late urgent mail, mail a cursor passed unread, reviews and questions from stored records (T1241)',t=>{
  const s=fixture(t);
  s.actor='a';
  const ordinary=send(s,['b'],'Ordinary note');
  const urgent=send(s,['b'],'Look now',{urgent:true});
  const passed=send(s,['c'],'Read me some time');
  s.actor='b';inbox(s);
  s.actor='c';saveNotificationProgress(s,{cursor:context(s).snapshot_cursor,expected_version:0});
  s.actor='a';const task=addTask(s,{title:'Change for review',forRole:'a'});takeTask(s,task.id);submitTask(s,task.id,'Ready');
  s.actor='c';reviewTask(s,task.id,{approve:true,note:'Fine',expected_version:showTask(s,task.id).version});
  s.actor='a';const other=addTask(s,{title:'Needs a decision',forRole:'a'});const question=askHuman(s,other.id,{question:'Which one?'});

  const r=stats(s,{now:later(120)});
  const b=r.mail_unread.by_role.find(row=>row.role==='b'),c=r.mail_unread.by_role.find(row=>row.role==='c');
  assert.equal(b.ordinary.count,1);assert.equal(b.ordinary.open,0);assert.equal(b.urgent.count,1);
  assert.equal(c.ordinary.open,1);assert.ok(c.ordinary.longest_minutes>=119);
  assert.equal(r.mail_unread.longest[0].message,passed.id);
  assert.deepEqual(r.urgent_unacknowledged.longest.map(m=>[m.message,m.to,m.open]),[[urgent.id,'b',true]]);
  assert.deepEqual(r.passed_unread.longest.map(m=>[m.message,m.to,m.open]),[[passed.id,'c',true]],'b read its mail before any cursor passed it');
  assert.equal(r.reviews.count,1);assert.equal(r.reviews.longest[0].reviewer,'c');assert.equal(r.reviews.open,0);
  assert.deepEqual(r.human_questions.longest.map(q=>[q.question,q.open]),[[question.id,true]]);
  assert.ok(r.not_stored.some(line=>/refused writes before schema 19/.test(line)));
  assert.deepEqual(r.refused_writes,{count:0,by_role:{},by_verb:{},latest:[]});
  assert.ok(!r.mail_unread.longest.some(m=>m.message===ordinary.id&&m.open));

  const text=formatStats(r);
  assert.match(text,/^Stats\./);assert.match(text,new RegExp(`${passed.id} ordinary to c: unread (?:1h5\\dm?|2h00) after, listed unknown \\(still open\\)`));
  assert.match(text,/Not stored, so not counted:/);

  const onlyC=stats(s,{role:'c',now:later(120)});
  assert.deepEqual(onlyC.mail_unread.by_role.map(row=>row.role),['c']);
  assert.equal(onlyC.urgent_unacknowledged.count,0);
  assert.equal(stats(s,{since:'2999-01-01'}).mail_unread.by_role.length,0);
  assert.match(formatStats(stats(s,{since:'2026-11-22T14:30:00Z'})),/^Stats since 2026-11-22 14:30 UTC\./);
  assert.match(formatStats(stats(s,{since:'2026-11-22'})),/^Stats since 2026-11-22\./);
});

test('a saved cursor names the mail its wake listed, so stats tells listed-but-unread from never listed (T1241)',t=>{
  const s=fixture(t);
  s.actor='a';
  const listed=send(s,['c'],'Listed and left');
  const missed=send(s,['c'],'Never listed');
  s.actor='c';
  const first=saveNotificationProgress(s,{cursor:context(s).snapshot_cursor,expected_version:0,delivered:[listed.id,listed.id]});
  const r=stats(s,{now:later(90)});
  assert.deepEqual(Object.fromEntries(r.passed_unread.longest.map(m=>[m.message,m.listed])),{[listed.id]:'yes',[missed.id]:'no'});
  assert.deepEqual(r.passed_unread.listed,{yes:1,no:1});
  assert.match(formatStats(r),/listed by a wake before it was read: yes 1, no 1, unknown 0/);
  const saved=s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='notification-progress' ORDER BY id DESC LIMIT 1",s.ws);
  assert.deepEqual(JSON.parse(saved.detail).delivered,[listed.id]);
  assert.throws(()=>saveNotificationProgress(s,{cursor:context(s).snapshot_cursor,expected_version:first.version,delivered:['T1']}),/Invalid delivered mail list/);
  // A later save without a list, or with a cut one, leaves the never-listed mail unknown (review).
  const plain=saveNotificationProgress(s,{cursor:context(s).snapshot_cursor,expected_version:first.version,scored:undefined,idle:undefined});
  s.actor='a';const third=send(s,['c'],'After the plain save');s.actor='c';
  assert.equal(stats(s,{now:later(90)}).passed_unread.longest.find(m=>m.message===missed.id).listed,'unknown');
  const many=Array.from({length:250},(_,i)=>`M${100000+i}`);
  saveNotificationProgress(s,{cursor:context(s).snapshot_cursor,expected_version:plain.version,delivered:many});
  const cut=s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='notification-progress' ORDER BY id DESC LIMIT 1",s.ws);
  assert.equal(JSON.parse(cut.detail).delivered.length,200);assert.equal(JSON.parse(cut.detail).delivered_cut,true);
  assert.equal(stats(s,{now:later(90)}).passed_unread.longest.find(m=>m.message===third.id).listed,'unknown');
});

test('stats refuses a since that is not a date and a role that does not exist',t=>{
  const s=fixture(t);
  assert.throws(()=>stats(s,{since:'yesterday-ish'}),error=>error.code===2);
  assert.throws(()=>stats(s,{role:'nobody'}));
});

test('a refused take, note or done is stored and counted by stats; a usage error from an unknown role is not (T1387)',t=>{
  const s=fixture(t);
  s.actor='a';const task=addTask(s,{title:'Held by a',forRole:'a'});takeTask(s,task.id);
  s.actor='b';
  for(const [verb,run] of [['take',()=>takeTask(s,task.id)],['note',()=>noteTask(s,task.id,'Mine now')],['done',()=>doneTask(s,task.id,{})]]){
    let error;try{run();}catch(e){error=e;}
    assert.ok(error,`${verb} by b is refused`);recordRefusal(s,verb,task.id,error);
  }
  s.actor='nobody';recordRefusal(s,'take',task.id,new AppError('Unknown role',3));
  s.actor='a';recordRefusal(s,'take',task.id,new Error('not a refusal'));recordRefusal(s,'take',task.id,new AppError('Usage error',2));
  const r=stats(s);
  assert.equal(r.refused_writes.count,3);assert.deepEqual(r.refused_writes.by_role,{b:3});assert.deepEqual(r.refused_writes.by_verb,{take:1,note:1,done:1});
  assert.deepEqual(r.refused_writes.latest.map(x=>[x.verb,x.task,x.role]),[['done',task.id,'b'],['note',task.id,'b'],['take',task.id,'b']]);
  assert.ok(r.refused_writes.latest.every(x=>x.reason.length>0&&x.code>0));
  assert.equal(stats(s,{role:'a'}).refused_writes.count,0);
  assert.match(formatStats(r),/Refused take, note and done: 3 \(b 3; done 1, note 1, take 1\)/);
});

test('the CLI stores a refused take and still exits with the refusal (T1387)',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sassato-refusal-')),db=join(dir,'state.db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const s=new Store(db,'a',{create:true});initWorkspace(s,'team',fixtureConfig);s.use('team');const task=addTask(s,{title:'Held by a',forRole:'a'});takeTask(s,task.id);s.close();
  const take=()=>spawnSync(process.execPath,[cli,'--db',db,'--workspace','team','take',task.id,'--as','b'],{env:{...process.env,SASSATO_ROLE:''},encoding:'utf8'});
  const run=take();
  assert.equal(run.status,4);assert.match(run.stderr,/^sassato: Task is not open for claiming: .+\n$/);
  const usage=spawnSync(process.execPath,[cli,'--db',db,'--workspace','team','take',task.id,'--hours','x','--as','b'],{env:{...process.env,SASSATO_ROLE:''},encoding:'utf8'});
  assert.equal(usage.status,2,'a usage error is not a refusal');
  const locked=new DatabaseSync(db);locked.exec('CREATE TRIGGER no_refusals BEFORE INSERT ON refusals BEGIN SELECT RAISE(ABORT,\'blocked\'); END');locked.close();
  const again=take();
  assert.equal(again.status,run.status);assert.equal(again.stderr,run.stderr,'a failed record keeps the refusal as it was');
  const after=new Store(db,'a');after.use('team');t.after(()=>after.close());
  assert.deepEqual(after.all('SELECT role,verb,task FROM refusals').map(r=>({...r})),[{role:'b',verb:'take',task:task.id}]);
});
