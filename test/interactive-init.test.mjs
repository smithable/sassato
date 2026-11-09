import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const supported=process.platform==='linux'&&spawnSync('script',['--version'],{encoding:'utf8'}).status===0;
const cli=resolve('bin/sassato.js');
async function terminal(t,steps,explicit=false) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-terminal-')),db=join(dir,'state.db');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const env={...process.env,SASSATO_DB:db,SASSATO_WORKSPACE:'',SASSATO_ROLE:'',SASSATO_TEST_NODE:process.execPath,SASSATO_TEST_CLI:cli};
  // Fixed command only; executable paths travel in quoted environment variables.
  const command=explicit?'exec "$SASSATO_TEST_NODE" "$SASSATO_TEST_CLI" init --workspace explicit --humans alice':'exec "$SASSATO_TEST_NODE" "$SASSATO_TEST_CLI" init';
  const child=spawn('script',['-qefc',command,'/dev/null'],{env,stdio:['pipe','pipe','pipe']});
  let output='',index=0;
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error(`Terminal setup timed out: ${output}`));},5000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);resolve({code,output});});
    child.stdout.on('data',data=>{
      output+=data;
      if(index<steps.length&&output.includes(steps[index][0]))child.stdin.write(steps[index++][1]);
    });
    child.stderr.on('data',data=>{output+=data;});
  });
  return {...result,db,env};
}
test('bare terminal init asks for workspace and humans, then creates exactly those humans',{skip:!supported},async t=>{
  const r=await terminal(t,[['Workspace name: ','terminal-team\n'],['Your human role name: ','alice\n'],['Other human role names','bob,carol\n']]);
  assert.equal(r.code,0,r.output);
  const roles=spawnSync(process.execPath,[cli,'roles','--workspace','terminal-team','--json'],{encoding:'utf8',env:r.env});
  assert.equal(roles.status,0,roles.stderr);
  assert.deepEqual(JSON.parse(roles.stdout).filter(r=>r.kind==='human').map(r=>r.name),['alice','bob','carol']);
});
test('cancelling terminal setup before the final answer leaves no database',{skip:!supported},async t=>{
  const r=await terminal(t,[['Workspace name: ','cancelled\n'],['Your human role name: ','alice\n'],['Other human role names','\x03']]);
  assert.notEqual(r.code,0,r.output);assert.match(r.output,/cancelled/);assert.equal(existsSync(r.db),false);
});
test('setup parameters suppress prompts even when invoked from a terminal',{skip:!supported},async t=>{
  const r=await terminal(t,[],true);assert.equal(r.code,0,r.output);
  assert.doesNotMatch(r.output,/Workspace name:|Your human role name:/);assert.ok(existsSync(r.db));
});
