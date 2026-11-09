#!/usr/bin/env node
// Opt-in Claude Code command hook. No settings are installed by this script.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli=fileURLToPath(new URL('../bin/sassato.js',import.meta.url));
function providerPid() {
  if(process.platform!=='linux') return undefined;
  let pid=process.ppid;
  for(let n=0;n<12&&pid>1;n++) {
    const args=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
    if(args.slice(0,2).some(arg=>basename(arg).replace(/\.(?:js|mjs|cjs|exe)$/,'')==='claude')) return pid;
    const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
    pid=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
  }
  return undefined;
}
function run(args) {
  const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',shell:false,timeout:1500,maxBuffer:24_000,env:process.env});
  if(result.error||result.status!==0) throw new Error('Sassato hook command failed');
  return result.stdout;
}
try {
  let input='',bytes=0;
  for await(const chunk of process.stdin) {bytes+=chunk.length;if(bytes>64_000) throw new Error('Hook input too large');input+=chunk.toString();}
  const event=JSON.parse(input),role=process.env.SASSATO_ROLE;
  if(!role||!process.env.SASSATO_WORKSPACE) throw new Error('SASSATO_ROLE and SASSATO_WORKSPACE are required');
  if(event.hook_event_name==='SessionStart') {
    if(typeof event.session_id!=='string') throw new Error('Missing session ID');
    const pid=providerPid();
    // /clear can replace the external ID while the verified provider PID stays the same.
    // A missing process ID is kept explicit: it cannot prove that another session stopped.
    run(['session','register','--as',role,'--provider','claude','--session-id',event.session_id,...(pid?['--pid',String(pid)]:[]),'--replace','--json']);
  } else if(event.hook_event_name==='UserPromptSubmit') {
    if(typeof event.session_id==='string') run(['session','heartbeat','--as',role,'--session-id',event.session_id,'--json']);
  } else {
    process.exit(0);
  }
  const output=run(['context','--as',role,'--brief']);
  process.stdout.write(output.slice(0,6000));
} catch {
  // Hooks are advisory and never block an agent turn. Do not echo input or provider errors,
  // which may contain prompt data. Explicit CLI calls still report errors normally.
  process.stderr.write('Sassato hook unavailable; run sassato context --brief manually.\n');
}
