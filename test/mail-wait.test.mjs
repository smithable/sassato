import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,SCHEMA_VERSION} from '../dist/storage.js';
import {initWorkspace} from '../dist/admin.js';
import {send,inbox,context} from '../dist/coordination.js';
import {requestStop,acknowledgeStop} from '../dist/control.js';
import {waitForUrgent} from '../dist/mail-wait.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'sassato-mailwait-')),path=join(dir,'state.db'),s=new Store(path,'a',{create:true});initWorkspace(s,'team',fixtureConfig);s.use('team');t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});return {s,path,stopFile:join(dir,'legacy-stop')};}
test('urgent waiter sees later writes through a read-only connection without consuming receipts',async t=>{
  const {s,path,stopFile}=fixture(t);send(s,['b'],'ordinary mail');send(s,['c'],'urgent elsewhere',{urgent:true});
  initWorkspace(s,'other',fixtureConfig);send(s,['b'],'foreign urgent',{urgent:true});s.use('team');
  const reader=new Store(path,'b',{readonly:true});reader.use('team');t.after(()=>reader.close());
  let urgent;const timer=setTimeout(()=>{urgent=send(s,['b'],'Wake up\nreview \u001b[2Jneeded',{urgent:true});},30);t.after(()=>clearTimeout(timer));
  const event=await waitForUrgent(reader,{timeout:2,stopFile});
  assert.equal(event.reason,'urgent');assert.equal(event.message.id,urgent.id);assert.equal(event.message.summary,'Wake up review [2Jneeded');
  assert.equal(s.get('SELECT state FROM receipts WHERE workspace_id=? AND message_id=? AND recipient=?',s.ws,Number(urgent.id.slice(1)),'b').state,'unread');
  assert.equal(context(reader).sections.inbox[0].urgent,true);
  s.actor='b';const messages=inbox(s,{limit:1});assert.equal(messages[0].id,urgent.id);assert.equal(messages[0].urgent,true);
  assert.equal((await waitForUrgent(reader,{timeout:1,stopFile})).reason,'timeout','read urgent mail must not repeatedly wake the watcher');
});
test('stop wins over urgent mail and acknowledged stop does not restart a watcher loop',async t=>{
  const {s,stopFile}=fixture(t);send(s,['a'],'urgent',{urgent:true});s.actor='human';const req=requestStop(s,['a'])[0];s.actor='a';
  const event=await waitForUrgent(s,{timeout:1,stopFile});assert.equal(event.reason,'stop');assert.equal(event.stop.id,req.id);
  acknowledgeStop(s,req.id);assert.equal((await waitForUrgent(s,{stopFile})).stop.acknowledged,true);
  assert.equal(inbox(s,{peek:true})[0].state,'unread');
});
test('mail waiter requires role identity and rejects malformed timeout',async t=>{
  const {s}=fixture(t);s.actor=null;await assert.rejects(()=>waitForUrgent(s),/identity|--as|role/i);
  s.actor='a';await assert.rejects(()=>waitForUrgent(s,{timeout:-1}),/timeout/);
});
test('v3 upgrade preserves messages and receipts and defaults urgency to false',t=>{
  const {s,path}=fixture(t);const msg=send(s,['b'],'old mail');s.actor='b';inbox(s);const receipts=JSON.stringify(s.all('SELECT * FROM receipts'));s.close();
  const db=new DatabaseSync(path);db.exec('DROP INDEX urgent_messages; ALTER TABLE messages DROP COLUMN urgent; DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3');db.close();
  const newer=new Store(path,'b');newer.use('team');t.after(()=>newer.close());
  assert.equal(newer.get('PRAGMA user_version').user_version,SCHEMA_VERSION);assert.equal(inbox(newer,{peek:true})[0].urgent,false);
  assert.equal(newer.get('SELECT urgent FROM messages WHERE id=?',Number(msg.id.slice(1))).urgent,0);assert.equal(JSON.stringify(newer.all('SELECT * FROM receipts')),receipts);
});

test('legacy stop file ends the waiter without consuming mail or creating a durable request',async t=>{
  const {s,stopFile}=fixture(t);const timer=setTimeout(()=>writeFileSync(stopFile,''),20);t.after(()=>clearTimeout(timer));
  const result=await waitForUrgent(s,{timeout:2,stopFile});assert.equal(result.reason,'stop');assert.equal(result.stop.file,stopFile);
  assert.equal(s.get('SELECT count(*) n FROM stop_requests').n,0);
});
