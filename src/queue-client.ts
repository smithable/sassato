import { spawn } from 'node:child_process';
export interface WatchExecution { code:number|null; stdout:string; stderr:string; timedOut?:boolean }
/** Bounded queue client only: no shell, no private provider state, no stdin approvals. */
export function queueClient(executable:string,args:string[],options:{cwd:string;signal?:AbortSignal;timeoutMs?:number}):Promise<WatchExecution> {
  return new Promise(done=>{
    if(options.signal?.aborted){done({code:null,stdout:'',stderr:'cancelled'});return;}
    const child=spawn(executable,args,{cwd:options.cwd,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    let stdout='',stderr='',timedOut=false,settled=false;
    const kill=()=>{if(child.pid)try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{/* Already exited. */}};
    const finish=(code:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',kill);done({code,stdout,stderr,timedOut});};
    const timer=setTimeout(()=>{timedOut=true;kill();},options.timeoutMs??10_000);
    options.signal?.addEventListener('abort',kill,{once:true});
    const collect=(chunk:Buffer,isError:boolean)=>{
      if(isError)stderr+=chunk.toString();else stdout+=chunk.toString();
      if(stdout.length+stderr.length>64_000){stdout=stdout.slice(0,32_000);stderr='Output limit exceeded';kill();}
    };
    child.stdout.on('data',chunk=>collect(chunk,false));child.stderr.on('data',chunk=>collect(chunk,true));
    child.once('error',()=>{stderr='Could not execute queue client';finish(null);});
    child.once('close',code=>finish(code));
    if(options.signal?.aborted)kill();
  });
}
