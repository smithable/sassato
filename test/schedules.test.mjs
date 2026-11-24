import { fixtureConfig } from './fixtures/team.mjs';
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../dist/storage.js';
import {initWorkspace} from '../dist/admin.js';
import {requestStop,resumeWork} from '../dist/control.js';
import {addTask,dropTask,showTask} from '../dist/tasks.js';
import {nextDue,civil,parseRule,addSchedule,editSchedule,pauseSchedule,resumeSchedule,archiveSchedule,previewSchedule,tickSchedules,listSchedules,showSchedule,renderSchedules} from '../dist/schedules.js';

const MIN=60_000,HOUR=3_600_000,DAY=86_400_000;
function fixture(t,start='2027-01-04T06:00:00Z'){
  mock.timers.enable({apis:['Date'],now:Date.parse(start)});t.after(()=>mock.timers.reset());
  const dir=mkdtempSync(join(tmpdir(),'sassato-schedules-')),path=join(dir,'state.db'),s=new Store(path,'human',{create:true});
  initWorkspace(s,'team',fixtureConfig);s.use('team');
  t.after(()=>{if(s.db.isOpen)s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,path};
}
const at=t=>new Date(t).toISOString();
const coded=n=>e=>e.code===n;
const tasksOf=(s,c)=>showSchedule(s,c).history.filter(o=>o.task).map(o=>o.task);

test('schema 18 adds the schedule tables and keeps every row',t=>{
  const {s,path}=fixture(t);
  addTask(s,{title:'Old work'});s.close();
  const db=new DatabaseSync(path);
  db.exec('DROP TABLE schedule_ticks; DROP TABLE occurrences; DROP INDEX schedules_due; DROP TABLE schedules; DELETE FROM schema_migrations WHERE version=18; PRAGMA user_version=17;');db.close();
  const again=new Store(path,'human');again.use('team');
  assert.equal(again.get('PRAGMA user_version').user_version,18);
  assert.deepEqual(again.all('SELECT title FROM tasks').map(r=>r.title),['Old work']);
  assert.equal(again.all('SELECT * FROM schedules').length,0);
  again.close();
});

test('rules: daily and weekly in local time, intervals in elapsed time',t=>{
  fixture(t);
  const daily={kind:'daily',at:'09:00',tz:'Europe/Helsinki'};
  assert.equal(at(nextDue(daily,Date.parse('2027-01-04T06:00:00Z'))),'2027-01-04T07:00:00.000Z');
  assert.equal(at(nextDue(daily,Date.parse('2027-01-04T07:00:00Z'))),'2027-01-05T07:00:00.000Z');
  assert.equal(at(nextDue(daily,Date.parse('2027-07-01T00:00:00Z'))),'2027-07-01T06:00:00.000Z','summer time is UTC+3');
  assert.equal(civil(daily,'2027-07-01T06:00:00.000Z'),'2027-07-01 09:00 Europe/Helsinki');
  const weekly={kind:'weekly',days:['mon','thu'],at:'09:00',tz:'Europe/Helsinki'};
  let due=Date.parse('2027-01-04T08:00:00Z');const days=[];
  for(let i=0;i<3;i++){due=nextDue(weekly,due);days.push(at(due).slice(0,10));}
  assert.deepEqual(days,['2027-01-07','2027-01-11','2027-01-14']);
  const every={kind:'interval',minutes:90,anchor:'2027-01-01T00:00:00.000Z'};
  assert.equal(at(nextDue(every,Date.parse('2026-12-31T00:00:00Z'))),'2027-01-01T00:00:00.000Z');
  assert.equal(at(nextDue(every,Date.parse('2027-01-01T00:00:00Z'))),'2027-01-01T01:30:00.000Z');
  assert.equal(at(nextDue(every,Date.parse('2027-03-28T00:10:00Z'))),'2027-03-28T01:30:00.000Z','DST does not move an interval');
  const once={kind:'once',at:'2027-02-01T12:00:00.000Z'};
  assert.equal(at(nextDue(once,Date.parse('2027-01-01T00:00:00Z'))),'2027-02-01T12:00:00.000Z');
  assert.equal(nextDue(once,Date.parse('2027-02-01T12:00:00Z')),null);
});

test('DST: a time in the spring gap is issued at the first valid instant; a repeated time only once',t=>{
  fixture(t);
  // Helsinki springs from 03:00 to 04:00 on 2027-03-28 and falls back from 04:00 to 03:00 on 2027-10-31.
  const gap={kind:'daily',at:'03:30',tz:'Europe/Helsinki'};
  assert.equal(at(nextDue(gap,Date.parse('2027-03-27T12:00:00Z'))),'2027-03-28T01:00:00.000Z','04:00 EEST, the end of the gap');
  assert.equal(at(nextDue(gap,Date.parse('2027-03-28T01:00:00Z'))),'2027-03-29T00:30:00.000Z');
  assert.equal(at(nextDue(gap,Date.parse('2027-10-30T12:00:00Z'))),'2027-10-31T00:30:00.000Z','the first 03:30');
  assert.equal(at(nextDue(gap,Date.parse('2027-10-31T00:30:00Z'))),'2027-11-01T01:30:00.000Z','not the second 03:30');
  const ny={kind:'daily',at:'02:30',tz:'America/New_York'};
  assert.equal(at(nextDue(ny,Date.parse('2027-03-14T00:00:00Z'))),'2027-03-14T07:00:00.000Z','03:00 EDT');
});

test('rule input is checked',t=>{
  fixture(t);const now=Date.now();
  for(const bad of [{},{daily:true,every:5},{daily:true,at:'9:00',tz:'Europe/Helsinki'},{daily:true,at:'09:00'},{daily:true,at:'09:00',tz:'Mars/Base'},{weekly:'mon,funday',at:'09:00',tz:'UTC'},{weekly:'',at:'09:00',tz:'UTC'},{every:0},{every:5,at:'09:00'},{once:'2027-02-01 12:00'},{once:'2027-02-01T12:00:00'},{daily:true,at:'09:00',tz:'UTC',anchor:'2027-01-01T00:00:00Z'}])
    assert.throws(()=>parseRule(bad,now),coded(2),JSON.stringify(bad));
  assert.throws(()=>parseRule({once:'2026-01-01T00:00:00Z'},now),coded(4));
  assert.deepEqual(parseRule({weekly:'thu,Mon',at:'09:00',tz:'UTC'},now),{kind:'weekly',days:['mon','thu'],at:'09:00',tz:'UTC'});
  assert.deepEqual(parseRule({every:'30'},now),{kind:'interval',minutes:30,anchor:'2027-01-04T06:00:00.000Z'});
});

test('only a human adds, edits, resumes or archives a schedule; any role may pause one',t=>{
  const {s}=fixture(t);
  const c=addSchedule(s,{title:'Weekly prune',weekly:'mon',at:'09:00',tz:'Europe/Helsinki',forRole:'a'});
  assert.equal(c.id,'C1');assert.equal(c.state,'active');assert.equal(c.next_due,'2027-01-04T07:00:00.000Z');
  assert.equal(c.next_due_local,'2027-01-04 09:00 Europe/Helsinki');
  assert.deepEqual(previewSchedule(s,c.id,2).preview.map(p=>p.local),['2027-01-04 09:00 Europe/Helsinki','2027-01-11 09:00 Europe/Helsinki']);
  s.actor='b';
  assert.throws(()=>addSchedule(s,{title:'Daily digest',daily:true,at:'08:00',tz:'UTC'}),coded(3));
  assert.throws(()=>editSchedule(s,c.id,{expect:1,title:'x'}),coded(3));
  assert.throws(()=>archiveSchedule(s,c.id,{expect:1,reason:'no'}),coded(3));
  assert.equal(pauseSchedule(s,c.id,{expect:1,reason:'release week'}).state,'paused');
  assert.throws(()=>resumeSchedule(s,c.id,{expect:2}),coded(3));
  s.actor='human';
  assert.throws(()=>resumeSchedule(s,c.id,{expect:1}),coded(4));
  assert.equal(editSchedule(s,c.id,{expect:2,title:'Prune'}).state,'paused','an edit leaves it paused');
  assert.equal(resumeSchedule(s,c.id,{expect:3}).state,'active');
  const gone=addSchedule(s,{title:'Never mind',every:60});
  assert.equal(archiveSchedule(s,gone.id,{expect:1,reason:'not needed'}).state,'archived');
  assert.throws(()=>pauseSchedule(s,gone.id,{expect:2,reason:'x'}),coded(4));
  assert.deepEqual(listSchedules(s).schedules.map(r=>r.id),['C1']);
  assert.deepEqual(listSchedules(s,{all:true}).schedules.map(r=>r.id),['C1','C2']);
  assert.throws(()=>addSchedule(s,{title:'Human only',every:60,forRole:'a',humanOnly:true}),coded(3));
  assert.throws(()=>showSchedule(s,'C9'),coded(3));
});

test('two stores ticking the same calendar issue one task',t=>{
  const {s,path}=fixture(t);
  addSchedule(s,{title:'Once a day',daily:true,at:'09:00',tz:'Europe/Helsinki'});
  mock.timers.tick(HOUR);
  const other=new Store(path,'human');other.use('team');t.after(()=>other.close());
  const both=[tickSchedules(s),tickSchedules(other)];
  assert.deepEqual(both.map(r=>r.issued.length),[1,0]);
  mock.timers.setTime(Date.now()-2*HOUR);
  assert.deepEqual(tickSchedules(other).issued,[],'a clock set back recreates nothing');
  assert.equal(s.all('SELECT * FROM occurrences').length,1);
});

test('a tick under a clock far ahead is flagged when the clock comes back, and the held schedule is named (T1445)',t=>{
  const {s}=fixture(t);
  addSchedule(s,{title:'Once a day',daily:true,at:'09:00',tz:'Europe/Helsinki'});
  const start=Date.now();
  mock.timers.setTime(start+10*24*HOUR);
  const ahead=tickSchedules(s);assert.equal(ahead.issued.length,1);assert.equal(ahead.clock_ahead,undefined,'nothing to compare with yet');
  const farTick=ahead.at,until=s.get('SELECT last_due_at FROM occurrences').last_due_at;
  mock.timers.setTime(start+HOUR);
  const back=tickSchedules(s);
  assert.deepEqual(back.issued,[],'nothing duplicated');
  assert.deepEqual(back.clock_ahead,{last_tick_at:farTick,held:[{schedule:'C1',until}]});
  const list=listSchedules(s);assert.deepEqual(list.held_ahead,[{schedule:'C1',until}]);
  assert.match(renderSchedules(list).split('\n')[1],new RegExp(`^Held by a tick whose clock was ahead: C1 until ${until}\\.$`));
  mock.timers.setTime(Date.parse(until)+HOUR);
  assert.equal(tickSchedules(s).clock_ahead,undefined,'gone once the clock reaches the held time');
  assert.equal(listSchedules(s).held_ahead,undefined);
  mock.timers.setTime(Date.parse(until)+30*24*HOUR);tickSchedules(s);
  const pausedUntil=s.get('SELECT MAX(last_due_at) AS t FROM occurrences').t;
  pauseSchedule(s,'C1',{expect:1,reason:'held test'});mock.timers.setTime(Date.parse(until)+2*HOUR);
  assert.equal(listSchedules(s).held_ahead,undefined,'a paused schedule is not named');
  assert.ok(pausedUntil>new Date().toISOString());
});

test('a tick issues one task per due time, and a second tick finds nothing',t=>{
  const {s}=fixture(t);
  const c=addSchedule(s,{title:'Read the queue',body:'Every morning.',daily:true,at:'09:00',tz:'Europe/Helsinki',forRole:'a'});
  assert.deepEqual(tickSchedules(s).issued,[],'not yet due');
  mock.timers.tick(HOUR);
  const first=tickSchedules(s);
  assert.equal(first.issued.length,1);
  const task=showTask(s,first.issued[0].task);
  assert.equal(task.for_role,'a');assert.equal(task.title,'Read the queue (due 2027-01-04 09:00 Europe/Helsinki)');
  assert.match(task.body,/Every morning\.\n\nFrom schedule C1 \(revision 1\): due 2027-01-04 09:00/);
  assert.deepEqual(tickSchedules(s),{at:new Date().toISOString(),issued:[],coalesced:[],deferred:[]});
  const list=listSchedules(s);
  assert.equal(list.last_tick_at,new Date().toISOString());assert.equal(list.last_tick_by,'human');assert.equal(list.overdue,0);
  assert.equal(list.schedules[0].next_due,'2027-01-05T07:00:00.000Z');
  assert.equal(list.schedules[0].last.task,first.issued[0].task);
  assert.match(renderSchedules(list),/^Last tick: .* by human; 0 overdue\.\nC1 r1 · Read the queue · a · daily at 09:00 Europe\/Helsinki · next 2027-01-05 09:00 Europe\/Helsinki; last 2027-01-04 09:00 Europe\/Helsinki issued T1 \(open\)$/);
  assert.equal(c.id,'C1');
});

test('missed times coalesce: into the open task, or into one new task for the range',t=>{
  const {s}=fixture(t);
  addSchedule(s,{title:'Check the backups',daily:true,at:'09:00',tz:'Europe/Helsinki'});
  mock.timers.tick(HOUR);const first=tickSchedules(s).issued[0].task;
  mock.timers.tick(3*DAY);
  assert.equal(listSchedules(s,{due:true}).schedules.length,1);
  const later=tickSchedules(s);
  assert.equal(later.issued.length,0);
  assert.deepEqual([later.coalesced[0].task,later.coalesced[0].slots],[first,3],'still open: recorded against it, nobody woken');
  dropTask(s,first,'done by hand');
  mock.timers.tick(2*DAY);
  const next=tickSchedules(s).issued[0];
  assert.equal(next.slots,2);
  assert.equal(next.label,'2027-01-08 09:00 Europe/Helsinki to 2027-01-09 09:00 Europe/Helsinki (2 times)');
  assert.match(showTask(s,next.task).body,/2 due times/);
  assert.deepEqual(tasksOf(s,'C1'),[next.task,first,first]);
  assert.equal(listSchedules(s).schedules[0].next_due,'2027-01-10T07:00:00.000Z');
});

test('STOP on the role defers delivery until it is lifted',t=>{
  const {s}=fixture(t);
  addSchedule(s,{title:'Nightly notes',every:60,forRole:'b'});
  requestStop(s,['b']);
  mock.timers.tick(HOUR);
  const held=tickSchedules(s);
  assert.deepEqual([held.issued.length,held.deferred[0].reason],[0,'b is stopped']);
  assert.equal(listSchedules(s).overdue,1);
  resumeWork(s,['b']);
  mock.timers.tick(HOUR);
  const out=tickSchedules(s).issued[0];
  assert.equal(out.slots,2);assert.equal(showTask(s,out.task).for_role,'b');
});

test('pause records nothing; resume skips the paused times and starts at the next future one',t=>{
  const {s}=fixture(t);
  const c=addSchedule(s,{title:'Hourly',every:60});
  s.actor='a';
  assert.throws(()=>pauseSchedule(s,c.id,{expect:1,reason:''}),coded(2));
  const paused=pauseSchedule(s,c.id,{expect:1,reason:'release week'});
  assert.equal(paused.state,'paused');assert.equal(paused.next_due,null,'a paused schedule shows no next time');
  assert.throws(()=>pauseSchedule(s,c.id,{expect:2,reason:'again'}),coded(4));
  mock.timers.tick(5*HOUR+30*MIN);
  assert.equal(tickSchedules(s).issued.length,0);
  s.actor='human';
  const back=resumeSchedule(s,c.id,{expect:2});
  assert.equal(back.next_due,'2027-01-04T12:00:00.000Z');
  const skipped=showSchedule(s,c.id).history[0];
  assert.deepEqual([skipped.status,skipped.slots,skipped.task],['skipped',5,null]);
  assert.equal(tickSchedules(s).issued.length,0);
});

test('edits apply from now and need the current revision',t=>{
  const {s}=fixture(t);
  const c=addSchedule(s,{title:'Standup',daily:true,at:'09:00',tz:'Europe/Helsinki'});
  assert.throws(()=>editSchedule(s,c.id,{expect:1}),coded(2));
  assert.throws(()=>editSchedule(s,c.id,{expect:1,at:'10:00'}),coded(2),'--at alone names no rule');
  const titled=editSchedule(s,c.id,{expect:1,title:'Morning standup'});
  assert.deepEqual([titled.revision,titled.next_due],[2,'2027-01-04T07:00:00.000Z']);
  assert.throws(()=>editSchedule(s,c.id,{expect:1,title:'stale'}),coded(4));
  mock.timers.tick(2*DAY);
  const moved=editSchedule(s,c.id,{expect:2,daily:true,at:'10:00',tz:'Europe/Helsinki'});
  assert.equal(moved.next_due,'2027-01-06T08:00:00.000Z');
  const superseded=showSchedule(s,c.id).history[0];
  assert.deepEqual([superseded.status,superseded.slots,superseded.revision],['superseded',2,2]);
  mock.timers.tick(3*HOUR);
  const issued=tickSchedules(s).issued[0];
  assert.match(showTask(s,issued.task).body,/revision 3/);
  assert.match(showTask(s,issued.task).title,/^Morning standup \(due 2027-01-06 10:00/);
});

test('review points: a template edit is prospective, a new audience gets its own task, a clock set back repeats nothing',t=>{
  const {s}=fixture(t);
  const c=addSchedule(s,{title:'Hourly check',every:60,forRole:'a'});
  mock.timers.tick(HOUR);
  const first=tickSchedules(s).issued[0].task;
  mock.timers.tick(HOUR+30*MIN);
  const edited=editSchedule(s,c.id,{expect:1,forRole:'human',humanOnly:true});
  assert.equal(edited.next_due,'2027-01-04T09:00:00.000Z','the due 08:00 is not issued under the new revision');
  assert.deepEqual(['status','revision','task'].map(k=>showSchedule(s,c.id).history[0][k]),['superseded',1,null]);
  mock.timers.tick(30*MIN);
  const out=tickSchedules(s);
  assert.equal(out.coalesced.length,0,'the open task is for a, the template now for a human');
  assert.notEqual(out.issued[0].task,first);
  assert.deepEqual([showTask(s,out.issued[0].task).for_role,showTask(s,out.issued[0].task).human_only],['human',true]);
  mock.timers.tick(2*HOUR);tickSchedules(s);
  const paused=pauseSchedule(s,c.id,{expect:2,reason:'clock check'});
  mock.timers.setTime(Date.now()-2*HOUR-30*MIN);
  const back=resumeSchedule(s,c.id,{expect:paused.revision});
  assert.equal(back.next_due,'2027-01-04T12:00:00.000Z','after the last recorded 11:00, not the 09:00 after the clock');
  mock.timers.setTime(Date.parse('2027-01-04T12:00:00Z'));
  assert.equal(tickSchedules(s).coalesced[0].due_at,'2027-01-04T12:00:00.000Z');
});

test('final read: one schedule that cannot issue leaves the rest; archive records due times; template flags can be cleared',t=>{
  const {s}=fixture(t);
  const broken=addSchedule(s,{title:'For a human',every:60,forRole:'human',humanOnly:true});
  addSchedule(s,{title:'Fine',every:60});
  s.run("UPDATE schedules SET for_role='a' WHERE id=1");
  mock.timers.tick(HOUR);
  const out=tickSchedules(s);
  assert.deepEqual([out.issued.length,out.issued[0].schedule,out.deferred[0].schedule],[1,'C2','C1']);
  assert.match(out.deferred[0].reason,/Human-only/);
  assert.deepEqual([showSchedule(s,'C1').history.length,listSchedules(s).schedules.find(r=>r.id==='C1').next_due],[0,'2027-01-04T07:00:00.000Z'],'nothing of C1 is kept');
  assert.throws(()=>editSchedule(s,broken.id,{expect:1,forRole:'nobody'}),/Unknown role nobody/,'an AppError, not a foreign-key failure');
  const cleared=editSchedule(s,broken.id,{expect:1,forRole:null,humanOnly:false});
  assert.deepEqual([cleared.for_role,cleared.human_only],[null,false]);
  mock.timers.tick(HOUR);
  archiveSchedule(s,'C2',{expect:1,reason:'done with it'});
  assert.deepEqual(['status','slots'].map(k=>showSchedule(s,'C2').history[0][k]),['skipped',1]);
});

test('impossible calendar dates are refused',t=>{
  fixture(t);
  for(const once of ['2027-02-30T12:00:00Z','2027-04-31T12:00:00Z','2027-13-01T12:00:00Z'])assert.throws(()=>parseRule({once},Date.now()),coded(2),once);
  assert.equal(parseRule({once:'2028-02-29T12:00:00Z'},Date.now()).at,'2028-02-29T12:00:00.000Z');
  assert.throws(()=>parseRule({once:'0000-02-29T12:00:00Z'},Date.now()),coded(4),'year 0 is a leap year (not 1900): a real date, only in the past');
});

test('a once schedule issues one task and then has no next time',t=>{
  const {s}=fixture(t);
  const c=addSchedule(s,{title:'Renew the certificate',once:'2027-01-05T12:00:00+02:00'});
  assert.equal(c.next_due,'2027-01-05T10:00:00.000Z');
  assert.equal(previewSchedule(s,c.id,3).preview.length,1);
  mock.timers.tick(10*DAY);
  assert.equal(tickSchedules(s).issued[0].slots,1);
  const after=listSchedules(s).schedules[0];
  assert.deepEqual([after.state,after.next_due],['active',null]);
  assert.match(renderSchedules(listSchedules(s)),/finished/);
  assert.equal(previewSchedule(s,c.id).preview.length,0);
  const archived=archiveSchedule(s,c.id,{expect:1,reason:'renewed'});
  assert.equal(archived.state,'archived');
  assert.equal(tasksOf(s,c.id).length,1,'history and the issued task stay');
});

test('the schedule commands through the CLI',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sassato-schedule-cli-')),db=join(dir,'state.db');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cli=(args,json=true)=>spawnSync(process.execPath,[resolve('bin/sassato.js'),'--db',db,'--workspace','team',...(json?['--json']:[]),...args],{encoding:'utf8',env:{...process.env,SASSATO_ROLE:'',SASSATO_WORKSPACE:'',SASSATO_DB:''}});
  const ok=(args,json=true)=>{const r=cli(args,json);assert.equal(r.status,0,r.stderr);return json?JSON.parse(r.stdout):r.stdout;};
  ok(['init','--config',fixtureConfig]);
  const c=ok(['schedule','add','Weekly','prune','--weekly','mon,thu','--at','09:00','--tz','Europe/Helsinki','--for','a','--body','Run sas prune.','--as','human']);
  assert.deepEqual([c.id,c.title,c.rule_text],['C1','Weekly prune','weekly on mon,thu at 09:00 Europe/Helsinki']);
  assert.equal(cli(['schedule','add','x','--daily','--as','human']).status,2);
  assert.equal(cli(['schedule','add','x','--every','5','--as','a']).status,3);
  assert.equal(ok(['schedule','preview','C1','--count','3']).preview.length,3);
  assert.equal(cli(['schedule','pause','C1','--expect','2','--reason','x','--as','a']).status,4);
  assert.equal(ok(['schedule','pause','C1','--expect','1','--reason','release week','--as','a']).state,'paused');
  assert.equal(ok(['schedule','resume','C1','--expect','2','--as','human']).revision,3);
  assert.equal(ok(['schedule','edit','C1','--expect','3','--title','Prune','--as','human']).title,'Prune');
  assert.deepEqual(ok(['schedule','tick','--as','a']).issued,[]);
  assert.match(ok(['schedule','list'],false),/^Last tick: .* by a; 0 overdue\.\nC1 r4 · Prune · a · weekly on mon,thu at 09:00 Europe\/Helsinki · next /);
  assert.deepEqual(ok(['schedule','show','C1','--limit','5']).history,[],'nothing came due');
  assert.equal(ok(['schedule','archive','C1','--expect','4','--reason','done','--as','human']).state,'archived');
});
