// Owned child: register before durable release, then exec provider as group leader.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Store } from './storage.js';
import { check,now } from './errors.js';
import { workerTokenHash } from './managed-generation.js';
import { processIdentity } from './coordination.js';
import { activeStop } from './control.js';
import { attendedPrompt,enrollment } from './attended.js';

async function main():Promise<void> {
  const transition=process.env.SASSATO_ATTENDED_TRANSITION,launch=process.env.SASSATO_ATTENDED_LAUNCH_TOKEN;
  check(transition && launch,'Missing owned bootstrap intent',3);
  const s=new Store(process.env.SASSATO_DB!,process.env.SASSATO_ROLE,{managedWriteMode:'bootstrap'});s.use(process.env.SASSATO_WORKSPACE);
  try {
    const p=enrollment(s,s.requireActor()),start=processIdentity(process.pid),holder=Number(process.env.SASSATO_ATTENDED_HOLDER_PID),holderStart=processIdentity(holder);
    const own=()=>{
      const row=s.get('SELECT t.*,w.role,w.generation AS current_generation,w.context,w.state AS worker_state FROM managed_transitions t JOIN managed_workers w ON w.id=t.worker_id WHERE t.id=? AND w.workspace_id=? AND w.role=?',transition,s.ws,s.requireActor());
      check(row && row.launch_token_hash===workerTokenHash(launch) && row.generation===row.current_generation,'Bootstrap intent/token/generation changed',4);return row;
    };
    const fields=readFileSync('/proc/self/stat','utf8').split(') ').at(-1)!.split(' ');
    check(start && holderStart && Number(fields[1])===holder && Number(fields[2])===process.pid && Number(fields[3])===process.pid,'Bootstrap must be the PTY holder child and new session/group leader',4);
    const original=s.tx(()=>{
      const t=own();check(t.state==='starting' && t.worker_state==='starting' && !t.bootstrap_pid,'Bootstrap already registered; no duplicate',4);
      check(!activeStop(s,[p.role,p.controller_role]),'STOP prevents bootstrap registration',4);
      const payload=JSON.parse(t.payload);check(payload.context.evidence_kind==='cooperative-attended','Wrong lifecycle mode',4);
      s.run('UPDATE managed_transitions SET bootstrap_pid=?,bootstrap_start=?,payload=?,updated_at=? WHERE id=?',process.pid,start,JSON.stringify({...payload,holder_pid:holder,holder_start:holderStart}),now(),t.id);
      s.event('managed-transition',t.id,'attended-bootstrap-registered',{generation:t.generation,pid:process.pid,process_start:start,holder_pid:holder,holder_start:holderStart});return t;
    });
    const deadline=Date.now()+Math.max(0,Math.min(120000,Date.parse(JSON.parse(original.payload).bootstrap_deadline)-Date.now()));
    for(;;){
      const t=own();check(!activeStop(s,[p.role,p.controller_role]),'STOP prevents provider exec',4);
      check(!['blocked','stopped'].includes(t.state),'Bootstrap cancelled',4);
      if(t.bootstrap_released_at && t.state==='reconciling'){
        const w=s.get('SELECT * FROM managed_workers WHERE id=?',t.worker_id)!,configuration=JSON.parse(w.context).configuration;
        const prompt=attendedPrompt(s,w),environment={...process.env};
        delete environment.SASSATO_ATTENDED_LAUNCH_TOKEN;delete environment.SASSATO_ATTENDED_HOLDER_PID;
        check(process.execve,'Provider exec requires Node execve on Linux',4);
        s.close();
        process.chdir(configuration.cwd);
        process.execve(configuration.executable,[configuration.executable,...configuration.argv_template,prompt],Object.fromEntries(Object.entries(environment).filter((entry):entry is [string,string]=>entry[1]!==undefined)));
        throw new Error('Provider exec returned unexpectedly');
      }
      check(Date.now()<deadline,'Bootstrap release deadline elapsed; no provider launched',4);
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }catch(error){try{s.close();}catch{/* Already closed before exec. */}throw error;}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'Attended bootstrap failed');process.exitCode=4;});
