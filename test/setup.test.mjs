import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const cli=resolve('bin/sassato.js');
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'sassato-setup-'));t.after(async()=>{
    const base=join(root,'data','state.db.launch','team');
    for(let i=0;i<100&&existsSync(base)&&readdirSync(base).some(name=>name.startsWith('.runtime-')||name.endsWith('.lock'));i++)await new Promise(res=>setTimeout(res,20));
    rmSync(root,{recursive:true,force:true});
  });
  const db=join(root,'data','state.db'),config=join(root,'config.json'),bin=join(root,'bin'),log=join(root,'windows.jsonl');mkdirSync(bin);
  writeFileSync(config,JSON.stringify({roles:[{name:'a',provider:'claude',working_dir:root,model:'opus',reasoning_effort:'high'},{name:'b',provider:'claude',working_dir:root},{name:'human',kind:'human'}]}));
  writeFileSync(join(bin,'claude'),'#!/usr/bin/env node\nif(process.argv.includes("--version")){console.log("fixture-provider");process.exit(0);}setTimeout(()=>{},400);\n',{mode:0o755});
  writeFileSync(join(bin,'wt.exe'),'#!/usr/bin/env node\nconst args=process.argv.slice(2);require("node:fs").appendFileSync(process.env.SASSATO_TEST_WT_LOG,JSON.stringify(args)+"\\n");const at=args.indexOf("--exec");const child=require("node:child_process").spawn(args[at+1],args.slice(at+2),{env:{...process.env,PATH:"/usr/bin:/bin"},stdio:"ignore",detached:true});child.unref();\n',{mode:0o755});
  function raw(args) {return spawnSync(process.execPath,[cli,'--db',db,'--workspace','team','--json',...args],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,WSL_DISTRO_NAME:'FixtureWSL',SASSATO_TEST_WT_LOG:log,SASSATO_ROLE:'',SASSATO_WORKSPACE:'',SASSATO_DB:''}});}
  function run(args){const r=raw(args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
  return {root,db,config,log,raw,run};
}
test('init launch preview creates neither database nor windows; committed init confirms provider startup in separate windows',t=>{
  const f=fixture(t),args=['init','--config',f.config,'--launch','a,b','--new-window','--as','human','--stop-file',join(f.root,'stop')];
  const files=readdirSync(f.root),preview=f.run([...args,'--dry-run']);
  assert.equal(preview.created,false);assert.equal(preview.would_create,true);
  assert.equal(preview.launch.length,2);assert.ok(preview.launch.every(p=>p.window==='new'&&p.mode==='fresh'));
  assert.equal(existsSync(f.db),false);assert.equal(existsSync(f.log),false);assert.deepEqual(readdirSync(f.root),files);
  const result=f.run(args);assert.equal(result.created,true);assert.ok(result.launch.every(p=>p.status==='started'));
  const calls=readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);
  for(const call of calls) {assert.deepEqual(call.slice(0,3),['-w','new','new-tab']);const payload=JSON.parse(Buffer.from(call.at(-1),'base64url'));assert.equal(payload.db,f.db);assert.equal(payload.options.newWindow,undefined);}
});
test('plain init never launches and existing setup preview preserves state and resume IDs',t=>{
  const f=fixture(t);assert.equal(f.run(['init','--config',f.config]).created,true);assert.equal(existsSync(f.log),false);
  const session='11111111-2222-3333-4444-555555555555';
  f.run(['session','register','--provider','claude','--session-id',session,'--as','a']);f.run(['session','end','--as','a']);
  const before=readFileSync(f.db);
  const preview=f.run(['init','--config',f.config,'--launch','a,b','--new-window','--dry-run']);
  assert.equal(preview.would_create,false);assert.equal(preview.launch[0].mode,'resume');assert.equal(preview.launch[0].sessionId,session);
  assert.deepEqual(readFileSync(f.db),before);if(existsSync(f.db+'-wal'))assert.equal(readFileSync(f.db+'-wal').length,0);assert.equal(existsSync(f.log),false);
});
test('invalid launch configuration and permission fail before initial workspace is created',t=>{
  const f=fixture(t),base=['init','--config',f.config];
  for(const args of [
    ['--new-window'],['--launch','missing','--new-window','--as','human'],
    ['--launch','a','--new-window','--terminal','native','--as','human'],
    ['--launch','a','--new-window','--window','named','--as','human'],
    ['--launch','a','--new-window','--as','a'],
    ['--launch','a,b','--as','human']
  ]) {const r=f.raw([...base,...args]);assert.notEqual(r.status,0);assert.equal(existsSync(f.db),false);assert.equal(existsSync(f.log),false);}
});
test('launch runtime failure leaves initialized workspace available for retry',t=>{
  const f=fixture(t),stop=join(f.root,'stop');writeFileSync(stop,'');
  const r=f.raw(['init','--config',f.config,'--launch','a','--new-window','--as','human','--stop-file',stop]);
  assert.equal(r.status,4);assert.match(r.stderr,/initialized, but launch did not complete/);
  assert.ok(f.run(['roles']).some(role=>role.name==='a'));assert.equal(existsSync(stop),true);assert.equal(existsSync(f.log),false);
});
