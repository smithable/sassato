import { fixtureConfig } from './fixtures/team.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../dist/storage.js';
import { initWorkspace, search } from '../dist/admin.js';
import * as c from '../dist/coordination.js';
import { addTask, takeTask, askHuman, answerQuestion, blockTask, addDependency } from '../dist/tasks.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(),'sassato-coordination-'));
  const s = new Store(join(dir,'state.db'),'a',{create:true});
  initWorkspace(s,'team',fixtureConfig); s.use('team');
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir};
}
function as(s,actor,fn) { const old=s.actor;s.actor=actor;try{return fn();}finally{s.actor=old;} }

// These tests use fake provider processes (Node scripts named claude.mjs), never actual agents.
async function provider(t,dir,suffix='') {
  const path=join(dir,`claude${suffix}.mjs`);
  writeFileSync(path,"process.send('ready');setInterval(()=>{},1000);\n");
  const child=spawn(process.execPath,[path],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
  await once(child,'message');return child;
}

test('role configuration cannot promote an agent or alter another role',t=>{
  const {s,dir}=setup(t);
  assert.throws(()=>c.setRole(s,'a',{kind:'human'}),/human role/);
  assert.throws(()=>c.setRole(s,'b',{model:'x'}),/human role/);
  assert.throws(()=>c.setRole(s,'newworker',{}),/human role/);
  const own=c.setRole(s,'a',{provider:'codex',working_dir:dir});
  assert.equal(own.kind,'agent');assert.equal(own.provider,'codex');
  as(s,'human',()=>c.setRole(s,'newworker',{provider:'claude'}));
  assert.ok(c.roles(s).some(r=>r.name==='newworker'));
  assert.equal(c.setUsage(s,'out until tomorrow','2026-11-10').usage_until,'2026-11-10T00:00:00.000Z');
  assert.throws(()=>c.setUsage(s,'out','2026-02-30'),/valid UTC calendar date/);
  assert.equal(c.setUsage(s,'').usage,null);
});

test('inbox consumes only returned receipts and exposes read/done state to sender',t=>{
  const {s}=setup(t);
  const first=c.send(s,['b','c','b'],'First shared handoff');
  const second=c.send(s,['b'],'Second shared handoff');
  assert.equal(as(s,'b',()=>c.inbox(s,{peek:true,limit:1}))[0].state,'unread');
  as(s,'b',()=>{ const read=c.inbox(s,{limit:1});assert.equal(read[0].id,first.id);assert.equal(read[0].state,'read'); });
  let sent=c.outbox(s);
  assert.equal(sent.find(m=>m.id===first.id).receipts.find(r=>r.recipient==='b').state,'read');
  assert.equal(sent.find(m=>m.id===first.id).receipts.find(r=>r.recipient==='c').state,'unread');
  assert.equal(sent.find(m=>m.id===second.id).receipts[0].state,'unread');
  // A previous read-but-unfinished message must not starve new unread messages.
  assert.equal(as(s,'b',()=>c.inbox(s,{limit:1}))[0].id,second.id);
  as(s,'b',()=>c.acknowledge(s,first.id));
  const events=s.get('SELECT count(*) AS n FROM events').n;
  as(s,'b',()=>c.acknowledge(s,first.id));
  assert.equal(s.get('SELECT count(*) AS n FROM events').n,events);
  assert.equal(c.outbox(s).find(m=>m.id===first.id).receipts.find(r=>r.recipient==='b').state,'done');
  assert.throws(()=>c.acknowledge(s,first.id),/not addressed/);
  assert.equal(as(s,'b',()=>c.inbox(s,{peek:true})).length,1);
});

test('message validation rolls back recipients and search reflects committed data',t=>{
  const {s}=setup(t);
  assert.throws(()=>c.send(s,['b','missing'],'Should not be partially delivered'),/Unknown role/);
  assert.equal(s.get('SELECT count(*) AS n FROM messages').n,0);
  const task=addTask(s,{title:'OAuth redirect'});
  const message=c.send(s,['b'],'Specific cometquartz handoff',{task:task.id});
  assert.equal(search(s,'cometquartz',{type:'message'})[0].id,message.id);
  assert.equal(as(s,'b',()=>c.inbox(s,{peek:true}))[0].task_id,task.id);
  assert.throws(()=>c.send(s,['b'],'ghp_'+'A'.repeat(36)),/Possible secret/);
  assert.equal(s.get('SELECT count(*) AS n FROM messages').n,1);
});

test('facts require sources and expected versions, preserve correction history and update FTS atomically',t=>{
  const {s}=setup(t);
  assert.throws(()=>c.setFact(s,'hosting',{body:'Local',source:''}),/nonempty/);
  const fact=c.setFact(s,'hosting',{body:'oldcomet host',source:'ops.md:8',checked_at:'2026-11-09'});
  assert.equal(fact.version,1);
  assert.throws(()=>c.setFact(s,'hosting',{body:'new',source:'ops.md:9'}),/expected version missing/);
  as(s,'b',()=>c.setFact(s,'hosting',{body:'newquartz host',source:'ops.md:9',expected_version:1}));
  assert.throws(()=>c.setFact(s,'hosting',{body:'stale overwrite',source:'ops.md',expected_version:1}),/Fact changed/);
  assert.equal(c.facts(s,{key:'hosting'})[0].version,2);
  const history=c.factHistory(s,'hosting');assert.equal(history.length,2);
  assert.equal(history[1].detail.before.body,'oldcomet host');
  assert.equal(history[1].detail.after.body,'newquartz host');
  assert.equal(search(s,'oldcomet',{type:'fact'}).length,0);
  assert.equal(search(s,'newquartz',{type:'fact'})[0].id,fact.id);
});

test('WIP is role-owned, shared-readable and protected against stale writes',t=>{
  const {s}=setup(t);
  c.setWip(s,{current:'Implement OAuth',next:'Review redirect',notes:'Waiting on config'});
  as(s,'b',()=>{
    assert.equal(c.getWip(s,'a').current,'Implement OAuth');
    c.setWip(s,{current:'Work owned by b'});
  });
  assert.equal(c.getWip(s).current,'Implement OAuth');
  assert.throws(()=>c.setWip(s,{current:'Overwrite'}),/expected version missing; current version is 1.*--expect 1/);
  c.setWip(s,{current:'Done implementing',expected_version:1});
  assert.equal(c.getWip(s).next,'Review redirect');
  assert.throws(()=>c.setWip(s,{notes:'Old draft',expected_version:1}),/WIP changed.*current version is 2.*--expect 2/);
});

test('fresh provider session recovers role work, facts and unread mail without transcript identity',t=>{
  const {s}=setup(t);
  const task=addTask(s,{title:'Resume me'});takeTask(s,task.id);
  c.setWip(s,{current:'Continue halfway implementation'});
  c.setFact(s,'handoff',{body:'Use existing fixture',source:'fixture.test.ts'});
  as(s,'b',()=>c.send(s,['a'],'Review after resuming'));
  c.registerSession(s,{provider:'claude',external_id:'first-session'});
  assert.equal(c.sessions(s)[0].state,'unknown');
  c.endSession(s,'first-session');
  c.registerSession(s,{provider:'codex',external_id:'new-session'});
  const view=c.context(s);
  assert.equal(view.sections.work[0].id,task.id);
  assert.equal(view.sections.wip[0].current,'Continue halfway implementation');
  assert.equal(view.sections.inbox[0].state,'unread');
  assert.equal(view.sections.facts[0].key,'handoff');
  assert.throws(()=>c.heartbeat(s,'first-session'),/replaced/);
  assert.equal(c.sessions(s)[0].external_id,'new-session');
});

test('session registration verifies providers, fingerprints, live process exclusivity and same-process clear',async t=>{
  const {s,dir}=setup(t), child=await provider(t,dir);
  assert.throws(()=>c.registerSession(s,{provider:'codex',external_id:'bad',pid:child.pid}),/not a verifiable/);
  const first=c.registerSession(s,{provider:'claude',external_id:'first',pid:child.pid});
  assert.equal(first.state,'running');assert.ok(c.processIdentity(child.pid));
  assert.equal(c.sessionState({...first,ended_at:new Date().toISOString()}),'running','an end marker is not proof a verified provider exited');
  s.run('UPDATE sessions SET last_seen_at=? WHERE workspace_id=?','2000-01-01T00:00:00.000Z',s.ws);
  assert.equal(c.sessions(s)[0].heartbeat_stale,true);
  assert.equal(c.sessions(s)[0].state,'running','old heartbeat does not prove exit');
  c.endSession(s,'first');
  assert.throws(()=>c.registerSession(s,{provider:'codex',external_id:'new-after-end',replace:true}),/verified running session/);
  assert.throws(()=>c.registerSession(s,{provider:'codex',external_id:'second',replace:true}),/verified running session/);
  const cleared=c.registerSession(s,{provider:'claude',external_id:'after-clear',pid:child.pid});
  assert.notEqual(cleared.id,first.id);
  assert.throws(()=>c.endSession(s,'first'),/replaced/);
  assert.equal(c.sessionState({...cleared,process_start:'a-different-boot:1'}),'stale');
  const exited=once(child,'exit');child.kill();await exited;
  assert.equal(c.sessions(s)[0].state,'stale');
  const replacement=c.registerSession(s,{provider:'codex',external_id:'fresh',replace:true});
  assert.equal(replacement.state,'unknown');
});

test('workspace isolation covers inbox, facts, WIP and role sessions',t=>{
  const {s}=setup(t);
  c.send(s,['b'],'Team-only message');c.setFact(s,'shared',{body:'Team-only fact',source:'team.md'});c.setWip(s,{current:'Team-only WIP'});
  c.registerSession(s,{provider:'claude',external_id:'team-session'});
  initWorkspace(s,'other',fixtureConfig);s.use('other');
  assert.equal(c.facts(s).length,0);assert.equal(c.sessions(s).length,0);assert.equal(c.getWip(s).version,0);
  as(s,'b',()=>assert.equal(c.inbox(s,{peek:true}).length,0));
  assert.equal(search(s,'Team').length,0);
  s.use('team');assert.equal(c.facts(s).length,1);
});

test('context is bounded and non-consuming, and exposes relevant waits and assigned work',t=>{
  const {s}=setup(t);
  const work=addTask(s,{title:'Own doing task'});takeTask(s,work.id);
  const dependency=as(s,'b',()=>addTask(s,{title:'Wait for shared base',owner:'b'}));
  addDependency(s,work.id,dependency.id);
  blockTask(s,work.id,{kind:'external',waitingOn:'vendor',body:'Need vendor answer'});
  const next=addTask(s,{title:'Next assigned task',forRole:'a'});
  addTask(s,{title:'Only for b',forRole:'b'});addTask(s,{title:'Only human',humanOnly:true});
  for(let i=0;i<15;i++) as(s,'b',()=>c.send(s,['a'],`Message ${i} ${'text '.repeat(1000)}`));
  for(let i=0;i<10;i++) c.setFact(s,`fact-${i}`,{body:'long fact '.repeat(1000),source:'source.md'});
  const before=s.get('SELECT count(*) AS n FROM events').n;
  const view=c.context(s,{limit:5});const rendered=c.renderContext(view);
  assert.equal(s.get('SELECT count(*) AS n FROM events').n,before);
  assert.equal(view.counts.inbox_unread,15);
  assert.equal(view.sections.available[0].id,next.id);
  assert.equal(view.sections.dependencies[0].waits_on,dependency.id);
  assert.equal(view.sections.blockers[0].waits_on,'vendor');
  assert.equal(view.truncated,true);
  assert.ok(JSON.stringify(view).length<=5800);
  assert.ok(rendered.length<=6000);assert.ok(rendered.split('\n').length<=40);
  assert.equal(as(s,'a',()=>c.inbox(s,{peek:true,state:'unread',limit:100})).length,15);
});

test('context cursors never skip facts or answered questions omitted by limits or budget',t=>{
  const {s}=setup(t);
  const start=c.context(s).cursor;
  const factIds=[],questionIds=[];
  for(let i=0;i<9;i++) {
    factIds.push(c.setFact(s,`long-fact-${i}`,{body:'evidence '.repeat(30),source:'record.md'}).id);
    const task=addTask(s,{title:`Question task ${i}`});
    const q=askHuman(s,task.id,{question:`Choose option ${i}`});questionIds.push(q.id);
    as(s,'human',()=>answerQuestion(s,q.id,`Answer ${i}`));
  }
  for(let i=0;i<8;i++) {
    const work=addTask(s,{title:`W${i}`});takeTask(s,work.id);
    const dependency=as(s,'b',()=>addTask(s,{title:`D${i}`,owner:'b'}));
    addDependency(s,work.id,dependency.id);blockTask(s,work.id,{kind:'external',waitingOn:'v',body:'Wait'});
    addTask(s,{title:`A${i}`});askHuman(s,work.id,{question:'Pending?'});
    s.run("UPDATE tasks SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?",Number(work.id.slice(1)));
  }
  const seenFacts=new Set(),seenQuestions=new Set();let cursor=start;
  for(let page=0;page<30;page++) {
    const view=c.context(s,{since:cursor,limit:2});
    const terminal=c.renderContext(view);
    assert.ok(terminal.split('\n').length<=40);assert.ok(terminal.length<=6000);
    for(const row of [...view.sections.facts,...view.sections.answers])assert.ok(terminal.includes(row.id),`terminal must show delta ${row.id} before cursor advances`);
    for(const row of view.sections.facts)seenFacts.add(row.id);
    for(const row of view.sections.answers)seenQuestions.add(row.id);
    assert.ok(view.cursor>=cursor);
    cursor=view.cursor;
    if(view.cursor===view.snapshot_cursor)break;
  }
  assert.deepEqual([...seenFacts].sort(),factIds.sort());
  assert.deepEqual([...seenQuestions].sort(),questionIds.sort());
  const empty=c.context(s,{since:cursor});
  assert.equal(empty.sections.facts.length,0);assert.equal(empty.sections.answers.length,0);
  assert.throws(()=>c.context(s,{since:cursor+100}),/ahead of this workspace/);
});


test('role reasoning and permission settings persist with human-only permission changes',t=>{
  const {s}=setup(t);
  assert.equal(c.setRole(s,'a',{reasoning_effort:'xhigh'}).reasoning_effort,'xhigh');
  assert.throws(()=>c.setRole(s,'a',{permission_mode:'bypassPermissions'}),/human role/);
  as(s,'human',()=>c.setRole(s,'a',{permission_mode:'plan'}));
  assert.equal(c.setRole(s,'a',{model:'another-model'}).permission_mode,'plan','unspecified policy is preserved');
  assert.throws(()=>c.setRole(s,'a',{permission_mode:'inherit'}),/human role/);
  assert.throws(()=>c.setRole(s,'a',{provider:'codex'}),/not supported/);
  as(s,'human',()=>c.setRole(s,'a',{provider:'codex',model:'codex-model',permission_mode:'inherit',reasoning_effort:'ultra',sandbox_mode:'workspace-write',approval_policy:'on-request'}));
  const changed=s.role('a');assert.equal(changed.permission_mode,null);assert.equal(changed.reasoning_effort,'ultra');assert.equal(changed.sandbox_mode,'workspace-write');
  assert.throws(()=>c.setRole(s,'a',{sandbox_mode:'danger-full-access'}),/human role/);
  assert.throws(()=>c.setRole(s,'a',{approval_policy:'never'}),/human role/);
  assert.throws(()=>c.setRole(s,'a',{sandbox_mode:null}),/human role/);
  assert.equal(c.setRole(s,'a',{reasoning_effort:'inherit'}).reasoning_effort,null);
  assert.equal(c.setRole(s,'a',{sandbox_mode:'workspace-write'}).sandbox_mode,'workspace-write','unchanged policy does not require privilege');
  const history=s.all("SELECT detail FROM events WHERE workspace_id=? AND entity='role' AND entity_id='a' AND action='updated' ORDER BY id",s.ws).map(r=>JSON.parse(r.detail));
  assert.ok(history.some(e=>e.before.permission_mode==='plan'&&e.after.sandbox_mode==='workspace-write'));
  as(s,'human',()=>c.setRole(s,'a',{sandbox_mode:'inherit',approval_policy:'',model:null}));
  assert.equal(s.role('a').sandbox_mode,null);assert.equal(s.role('a').approval_policy,null);assert.equal(s.role('a').model,null);
});

test('context dates WIP, flags stale source state, and retains it under truncation',t=>{
  const {s}=setup(t);c.setWip(s,{current:'Historical WIP '+ 'x'.repeat(500),next:'y'.repeat(500),notes:'z'.repeat(500)});
  const old=new Date(Date.now()-25*60*60_000).toISOString();s.run('UPDATE wip SET updated_at=? WHERE workspace_id=? AND role=?',old,s.ws,'a');
  for(let i=0;i<10;i++){addTask(s,{title:`Available item ${i} ${'q'.repeat(150)}`});c.setFact(s,`long-fact-${i}`,{body:'Fact '+ 'f'.repeat(500),source:'source.md'});}
  const view=c.context(s,{limit:5});assert.equal(view.sections.wip.length,1);assert.equal(view.sections.wip[0].stale,true);assert.equal(view.sections.wip[0].updated_at,old);
  assert.match(c.renderContext(view),/wip: stale=true.*updated_at=/);assert.ok(JSON.stringify(view).length<=5800);assert.ok(c.renderContext(view).length<=6000);
  c.setWip(s,{current:'New work',expected_version:1});assert.equal(c.context(s).sections.wip[0].stale,false);
  s.run('UPDATE wip SET updated_at=? WHERE workspace_id=? AND role=?',new Date(Date.now()-23*60*60_000).toISOString(),s.ws,'a');assert.equal(c.context(s).sections.wip[0].stale,false);
});
