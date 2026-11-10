import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { check, integer, name, text } from './errors.js';

export type BusyCheck = {name:string;type:'flock';path:string} | {name:string;type:'command';argv:string[];cwd:string;timeout_ms:number};
export interface BusyStatus { name:string; state:'busy'|'idle'|'unknown'; reason:string }
const pathValue=(value:unknown,base:string)=>{const path=text(value,'busy check path',4096);return resolve(base,path.startsWith('~/')?resolve(homedir(),path.slice(2)):path);};
/** Only human-owned workspace configuration can install executable checks. */
export function validateBusyChecks(input:unknown,base=process.cwd()):BusyCheck[] {
  check(Array.isArray(input)&&input.length<=16,'busy_checks must be an array of at most 16 checks');
  const names=new Set<string>();
  return input.map(value=>{
    check(value&&typeof value==='object'&&!Array.isArray(value),'Busy check must be an object');
    const label=name(value.name);check(!names.has(label),'Busy check names must be unique');names.add(label);
    check(value.type==='flock'||value.type==='command','Busy check type must be flock or command');
    const allowed=value.type==='flock'?['name','type','path']:['name','type','argv','cwd','timeout_ms'];
    check(Object.keys(value).every(key=>allowed.includes(key)),'Unknown busy check field');
    if(value.type==='flock')return {name:label,type:'flock',path:pathValue(value.path,base)};
    check(Array.isArray(value.argv)&&value.argv.length>0&&value.argv.length<=32,'Busy command needs 1–32 argv entries');
    const argv=value.argv.map((arg:unknown)=>text(arg,'busy command argument',4096));
    // An explicit path is anchored to the configuration, never the caller's later cwd.
    if(argv[0].includes('/'))argv[0]=pathValue(argv[0],base);
    check(!argv[0].startsWith('-'),'Busy command executable must not start with a dash');
    return {name:label,type:'command',argv,cwd:pathValue(value.cwd??base,base),timeout_ms:integer(value.timeout_ms??1000,'busy check timeout_ms',1,10_000)};
  });
}

/** No shell, no captured output, no writer transaction. Reap the check before returning. */
function execute(argv:string[],cwd:string|undefined,timeout:number,fd?:number,signal?:AbortSignal):Promise<{code:number|null;reason?:string}> {
  return new Promise(resolveResult=>{
    if(signal?.aborted){resolveResult({code:null,reason:'Check cancelled'});return;}
    if(process.platform==='win32'){resolveResult({code:null,reason:'Process-group checks require POSIX'});return;}
    const child=spawn(argv[0],argv.slice(1),{cwd,shell:false,detached:true,stdio:fd===undefined?'ignore':['ignore','ignore','ignore',fd]});
    let expired=false,settled=false;
    const killGroup=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{ /* Already gone. */ }};
    signal?.addEventListener('abort',killGroup,{once:true});
    const timer=setTimeout(()=>{expired=true;killGroup();},Math.max(1,timeout));
    const finish=(code:number|null,reason?:string)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',killGroup);resolveResult({code,reason});};
    child.once('error',()=>finish(null,'Could not start check'));
    child.once('exit',(code,exitSignal)=>{
      let descendants=false;
      if(child.pid)try{process.kill(-child.pid,0);descendants=true;killGroup();}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')descendants=true;}
      finish(code,signal?.aborted?'Check cancelled':expired?'Check timed out':descendants?'Check left child processes':exitSignal?'Check was signalled':undefined);
    });
  });
}
export async function observeBusyChecks(checks:BusyCheck[],deadline=Infinity,signal?:AbortSignal):Promise<BusyStatus[]> {
  return Promise.all(checks.map(async config=>{
    const unknown=(reason:string):BusyStatus=>({name:config.name,state:'unknown',reason});
    if(signal?.aborted)return unknown('Check cancelled');
    if(performance.now()>=deadline)return unknown('Stop timeout reached before check');
    const timeout=Math.min(config.type==='command'?config.timeout_ms:1000,deadline-performance.now());
    if(config.type==='command') {
      const result=await execute(config.argv,config.cwd,timeout,undefined,signal);
      return result.reason?unknown(result.reason):result.code===0?{name:config.name,state:'busy' as const,reason:'Command exited 0'}:result.code===1?{name:config.name,state:'idle' as const,reason:'Command exited 1'}:unknown(`Command exited ${result.code??'without status'}`);
    }
    let fd:number|undefined;
    try {
      check(isAbsolute(config.path),'Lock path must be absolute');
      // Do not create/truncate files, follow symlinks, or block opening a FIFO.
      fd=openSync(config.path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
      const before=fstatSync(fd);if(!before.isFile())return unknown('Lock path is not a regular file');
      const result=await execute(['flock','--exclusive','--nonblock','--conflict-exit-code','75','3'],undefined,timeout,fd,signal);
      const after=statSync(config.path);
      if(before.ino!==after.ino||before.dev!==after.dev)return unknown('Lock file changed during check');
      return result.reason?unknown(result.reason):result.code===0?{name:config.name,state:'idle' as const,reason:'Lock is not held'}:result.code===75?{name:config.name,state:'busy' as const,reason:'Lock is held'}:unknown('Could not inspect flock lock');
    }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'&&fd===undefined?{name:config.name,state:'idle',reason:'Lock file is absent'}:unknown('Lock file could not be inspected');}
    finally{if(fd!==undefined)closeSync(fd);}
  }));
}
