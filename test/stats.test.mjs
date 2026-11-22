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
import {addTask,takeTask,submitTask,reviewTask,askHuman,showTask} from '../dist/tasks.js';
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
  assert.ok(r.not_stored.some(line=>/refused writes/.test(line)));
  assert.ok(!r.mail_unread.longest.some(m=>m.message===ordinary.id&&m.open));

  const text=formatStats(r);
  assert.match(text,/^Stats\./);assert.match(text,new RegExp(`${passed.id} ordinary to c: unread 1h5\\dm? after \\(still open\\)|${passed.id} ordinary to c: unread 2h00 after \\(still open\\)`));
  assert.match(text,/Not stored, so not counted:/);

  const onlyC=stats(s,{role:'c',now:later(120)});
  assert.deepEqual(onlyC.mail_unread.by_role.map(row=>row.role),['c']);
  assert.equal(onlyC.urgent_unacknowledged.count,0);
  assert.equal(stats(s,{since:'2999-01-01'}).mail_unread.by_role.length,0);
});

test('stats refuses a since that is not a date and a role that does not exist',t=>{
  const s=fixture(t);
  assert.throws(()=>stats(s,{since:'yesterday-ish'}),error=>error.code===2);
  assert.throws(()=>stats(s,{role:'nobody'}));
});
