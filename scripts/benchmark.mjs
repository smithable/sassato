import { performance } from 'node:perf_hooks';
import { mkdirSync,writeFileSync,statSync } from 'node:fs';
import { cpus,loadavg,platform,release,totalmem } from 'node:os';
import { resolve,join } from 'node:path';
import { fork,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../dist/storage.js';
import { initWorkspace,search,status } from '../dist/admin.js';
import { send } from '../dist/coordination.js';
const filename=fileURLToPath(import.meta.url);
function stats(values){const a=[...values].sort((a,b)=>a-b),pick=q=>Number(a[Math.min(a.length-1,Math.ceil(a.length*q)-1)].toFixed(3));return {samples:a.length,p50_ms:pick(.5),p95_ms:pick(.95),max_ms:pick(1)};}
function timed(fn){const start=performance.now();fn();return performance.now()-start;}
if(process.argv[2]==='worker') {
  const s=new Store(process.argv[3],'a');s.use('bench');
  process.send({ready:true});
  process.once('message',async()=>{
    const mode=process.argv[4],durations=[],statuses=[];
    for(let i=0;i<100;i++) {
      if(mode==='writer')durations.push(timed(()=>send(s,['b'],`Concurrent benchmark write ${i} cohort42`)));
      else {durations.push(timed(()=>search(s,`cohort${i%100}`,{limit:20})));statuses.push(timed(()=>status(s)));}
      await new Promise(resolve=>setImmediate(resolve));
    }
    s.close();process.send({mode,durations,statuses});process.disconnect();
  });
} else {
  process.umask(0o077);
  const out=resolve('.artifacts',`benchmark-${new Date().toISOString().replace(/[:.]/g,'-')}`);mkdirSync(out,{recursive:true});
  const db=join(out,'bench.db'),s=new Store(db,'a',{create:true});initWorkspace(s,'bench',{roles:[{name:'a',kind:'agent'},{name:'b',kind:'agent'},{name:'human',kind:'human'}]});s.use('bench');
  const start=performance.now(),at=new Date().toISOString();
  const insertTask=s.db.prepare("INSERT INTO tasks(workspace_id,title,body,owner,status,creator,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  const insertMessage=s.db.prepare('INSERT INTO messages(workspace_id,sender,body,created_at) VALUES(?,?,?,?)');
  const insertReceipt=s.db.prepare('INSERT INTO receipts(workspace_id,message_id,recipient) VALUES(?,?,?)');
  const insertFact=s.db.prepare('INSERT INTO facts(workspace_id,key,body,source,checked_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)');
  const doc=s.db.prepare('INSERT INTO documents(workspace_id,type,entity_id,title,body,role,status,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const seedStart=performance.now();
  s.tx(()=>{
    for(let i=0;i<10000;i++) {
      const title=`Benchmark task ${i} cohort${i%100}`,body='Authentication callback validation and durable recovery',state=i%4?'open':'doing';
      const id=Number(insertTask.run(s.ws,title,body,i%4?'b':'a',state,'a',at,at).lastInsertRowid);
      doc.run(s.ws,'task',`T${id}`,title,body,i%4?'b':'a',state,at);s.event('task',`T${id}`,'created',{title,body});
    }
    for(let i=0;i<100000;i++) {
      const body=`Benchmark discussion ${i} cohort${i%100} authentication callback deployment review`;
      const id=Number(insertMessage.run(s.ws,'a',body,at).lastInsertRowid);
      insertReceipt.run(s.ws,id,'b');doc.run(s.ws,'message',`M${id}`,'a to b',body,'a',null,at);s.event('message',`M${id}`,'sent',{body});
    }
    for(let i=0;i<10000;i++) {
      const key=`fact/${i}`,body=`Shared fact ${i} cohort${i%100} callback contract verified`;
      const id=Number(insertFact.run(s.ws,key,body,'synthetic fixture',at,'a',at).lastInsertRowid);
      doc.run(s.ws,'fact',`F${id}`,key,body,'a',null,at);s.event('fact',`F${id}`,'created',{body});
    }
  });
  s.db.exec('ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)');
  const seedMs=performance.now()-seedStart;
  const searchTimes=[],statusTimes=[],writeTimes=[];
  for(let i=0;i<100;i++) {
    searchTimes.push(timed(()=>search(s,`cohort${i%100}`,{limit:20})));
    statusTimes.push(timed(()=>status(s)));
    writeTimes.push(timed(()=>send(s,['b'],`Serial benchmark write ${i} cohort42`)));
  }
  const cold=[];
  for(let i=0;i<12;i++)cold.push(timed(()=>{
    const child=spawnSync(process.execPath,[resolve('bin/sassato.js'),'context','--db',db,'--workspace','bench','--as','a','--json'],{encoding:'utf8'});
    if(child.status!==0)throw new Error(child.stderr);JSON.parse(child.stdout);
  }));
  const children=['reader','reader','writer'].map(mode=>{
    const child=fork(filename,['worker',db,mode],{stdio:['ignore','ignore','inherit','ipc']});
    let go;const ready=new Promise(r=>go=r);
    const result=new Promise((res,rej)=>{
      let completed=false;
      child.on('message',m=>{if(m.ready)go();else{completed=true;res(m);}});
      child.on('error',rej);child.on('exit',code=>{if(!completed)rej(new Error(`benchmark worker exited ${code}`));});
    });return{child,ready,result};
  });
  await Promise.all(children.map(c=>c.ready));const concurrentStart=performance.now();for(const c of children)c.child.send('go');
  const concurrent=await Promise.all(children.map(c=>c.result));
  const result={at:new Date().toISOString(),environment:{node:process.version,sqlite:s.get('SELECT sqlite_version() version').version,platform:platform(),release:release(),cpu:cpus()[0].model,logical_cpus:cpus().length,memory_gib:Number((totalmem()/2**30).toFixed(1)),load:loadavg(),journal:'WAL',synchronous:'FULL',filesystem:'local project path (operator must ensure native disk)'},dataset:{tasks:10000,messages:100000,facts:10000,audit_events:120000,search_documents:240000,seed_ms:Number(seedMs.toFixed(1)),database_bytes:statSync(db).size},cold_cli_context:stats(cold),indexed_search:stats(searchTimes),status:stats(statusTimes),write:stats(writeTimes),concurrent:{processes:'2 readers + 1 writer; each 100 operations',elapsed_ms:Number((performance.now()-concurrentStart).toFixed(1)),search:stats(concurrent.filter(r=>r.mode==='reader').flatMap(r=>r.durations)),status:stats(concurrent.flatMap(r=>r.statuses)),write:stats(concurrent.find(r=>r.mode==='writer').durations)},total_seconds:Number(((performance.now()-start)/1000).toFixed(1)),method:'Cold means a fresh Node process, not evicted OS page cache. Search uses one cohort token matching about 2400 of 240000 source and audit documents and returns top 20; includes BM25 sorting. Synthetic seed uses one bulk transaction; write latency measures individual full-durability message+receipt+event transactions.'};
  s.close();writeFileSync(join(out,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,artifact:join(out,'results.json')},null,2));
}
