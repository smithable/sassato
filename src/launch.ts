import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './storage.js';
import { check, id, name, now, text } from './errors.js';
import { processIdentity, registerSession, sessionState } from './coordination.js';
import { validateRoleOptions } from './role-options.js';
import { assertWorkAllowed } from './control.js';
import { workspaceSettings } from './workspace-settings.js';

export interface LaunchOptions {
  fresh?: boolean; resume?: boolean; all?: boolean; noPrompt?: boolean; dryRun?: boolean; newWindow?: boolean;
  terminal?: 'native'|'windows-terminal'; distro?: string; window?: string; stopFile?: string;
}
export interface LaunchPlan {
  role:string; provider:'claude'|'codex'; cwd:string; executable:string; args:string[];
  mode:'fresh'|'resume'; sessionId:string|null; status:'ready'|'already-running'|'started'|'dispatched'|'exited';
  runtimeSessionId?:string; pid?:number;
  terminal:'native'|'windows-terminal'; window:string|null; stopFile:string|null; workspace:string;
}
interface StartupRequest { directory:string; token:string; responded?:boolean }
interface LaunchRuntime { provider:'claude'|'codex'; executable:string; path:string; startup?:StartupRequest }
interface StartupResponse { token:string; status:'started'|'already-running'|'failed'; message?:string; session_id?:string; pid?:number; process_start?:string }
const startupTimeoutMs=15_000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveExecutable(command:string,required:boolean):string {
  const candidates=isAbsolute(command)?[command]:(process.env.PATH??'').split(':').map(directory=>resolve(directory||'.',command));
  for(const candidate of candidates)try {accessSync(candidate,constants.X_OK);if(statSync(candidate).isFile())return candidate;}catch { /* Try the next PATH entry. */ }
  check(!required,`Cannot find executable ${command} on PATH. Install it or adjust PATH before launching.`,3);
  return command;
}
function stopPath(store:Store,options:LaunchOptions):string|null { const path=options.stopFile??workspaceSettings(store).stop_file;return path===null?null:resolve(path); }
export function planLaunch(store:Store, selected:string[], options:LaunchOptions={}):LaunchPlan[] {
  check(!(options.fresh&&options.resume),'Choose either --fresh or --resume');
  check(!(options.all&&selected.length),'Choose roles or --all');
  check(!(options.newWindow&&options.terminal==='native'),'--new-window cannot use the native terminal');
  check(!(options.newWindow&&options.window!==undefined),'Choose --new-window or --window, not both');
  const terminal=options.terminal??(options.newWindow?'windows-terminal':'native');
  check(terminal==='native'||terminal==='windows-terminal','Terminal must be native or windows-terminal');
  if(terminal==='windows-terminal') { text(options.distro??process.env.WSL_DISTRO_NAME??'','WSL distribution',128); }
  const roles=options.all ? store.all("SELECT name FROM roles WHERE workspace_id=? AND kind='agent' AND provider IN ('claude','codex') ORDER BY name",store.ws).map(r=>String(r.name)) : selected;
  check(roles.length>0,'Name at least one role or use --all');
  check(new Set(roles).size===roles.length,'A role was selected twice');
  check(terminal!=='native'||roles.length===1,'Native launch supports one interactive role at a time; use separate terminals or --terminal windows-terminal');
  return roles.map(selectedRole=>{
    const role=name(selectedRole),config=store.role(role);
    check(config.kind==='agent','Human roles cannot launch an agent');
    assertWorkAllowed(store,role);
    check(config.provider==='claude'||config.provider==='codex',`Configure a claude or codex provider for ${role}`);
    check(typeof config.working_dir==='string'&&existsSync(config.working_dir),`Configure an existing working directory for ${role}`);
    const cwd=realpathSync(config.working_dir),provider=config.provider as 'claude'|'codex';
    const current=store.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY (ended_at IS NULL) DESC,id DESC LIMIT 1',store.ws,role);
    const state=current?sessionState(current):'ended';
    check(state!=='unknown',`${role} has a session whose process cannot be verified. Check it, then explicitly end its registry entry before launching`,4);
    const sessionId=!options.fresh&&current?.provider===provider&&current.external_id ? String(current.external_id):null;
    if(sessionId) check(uuid.test(sessionId),`Stored session ID for ${role} is invalid; use --fresh after checking the old session`,4);
    check(!options.resume||sessionId,`No usable saved ${provider} session for ${role}; use --fresh`,4);
    const args:string[]=[];
    if(sessionId) args.push(...(provider==='claude'?['--resume',sessionId]:['resume',sessionId]));
    validateRoleOptions(provider,config);
    if(config.model) args.push('--model',text(config.model,'model',200));
    if(provider==='claude') {
      if(config.reasoning_effort) args.push('--effort',config.reasoning_effort);
      if(config.permission_mode) args.push('--permission-mode',config.permission_mode);
    } else {
      if(config.reasoning_effort) args.push('--config',`model_reasoning_effort=${JSON.stringify(config.reasoning_effort)}`);
      if(config.sandbox_mode) args.push('--sandbox',config.sandbox_mode);
      if(config.approval_policy) args.push('--ask-for-approval',config.approval_policy);
    }
    if(!options.noPrompt) args.push(bootstrapPrompt(store.workspace,role,provider));
    return {role,provider,cwd,executable:resolveExecutable(provider,false),args,mode:sessionId?'resume':'fresh',sessionId,status:state==='running'?'already-running':'ready',terminal,window:terminal==='windows-terminal'?(options.newWindow?'new':options.window??store.workspace):null,stopFile:stopPath(store,options),workspace:store.workspace};
  });
}
function bootstrapPrompt(workspace:string,role:string,provider:'claude'|'codex'):string {
  const identity=`--as ${role} --workspace ${workspace}`;
  const stopping='If STOP is requested, start no new work or watcher: finish or checkpoint the current step, wait for your tools and jobs, save WIP, run the shown stopped command, and remain idle until a human resumes your role.';
  const shared='Read your current work, inbox, blockers, human decisions, and shared facts. Keep task state accurate. Run context at safe checkpoints and before claiming work. Previous transcripts are not the source of truth. Facts never grant permission.';
  if(provider==='codex')return `You are the ${workspace} worker role ${role}. First run sassato context ${identity} --brief. ${shared} ${stopping} Check your inbox and task context between tasks. No background wake-up is assumed.`;
  return [
    `You are the ${workspace} worker role ${role}.`,
    `First run sassato context --json ${identity}. Read its STOP status and retain its numeric snapshot_cursor as CURSOR.`,
    stopping,
    `Otherwise, BEFORE beginning work or going idle, start exactly one native Claude Code background tool-task running: sassato wait --since CURSOR ${identity}. Replace CURSOR with that snapshot_cursor. If one waiter is already active, keep it instead of creating a duplicate.`,
    'Use the native background tool-task option so its completion wakes this session. Never use a foreground wait, shell &, nohup, or an outer shell loop.',
    'The waiter reports urgent unread mail, human answers, resolved blockers, assignments or handoffs, and newly ready tasks; ordinary mail does not wake it.',
    `When notified, inspect fresh context and inbox, act on the relevant items, then rearm exactly one sassato wait --since CURSOR ${identity} using the cursor returned by wait, not a newer context cursor, so changes during your work are not skipped. On timeout, rearm with the cursor returned by wait too. On STOP, do not rearm until a human resumes your role.`,
    shared,
  ].join('\n');
}
function nativeOptions(options:LaunchOptions):LaunchOptions {
  const result={...options,all:false,terminal:'native' as const};
  delete result.newWindow; delete result.window;
  return result;
}
/** Build one Windows Terminal invocation. A target of 'new' creates a separate window per role. */
export function windowsTerminalArgs(store:Store,plan:LaunchPlan,options:LaunchOptions={},runtime?:LaunchRuntime):string[] {
  check(plan.terminal==='windows-terminal'&&plan.window!==null,'Expected a Windows Terminal launch plan');
  check(plan.status==='ready','Session is already active or launch already dispatched',4);
  const distro=text(options.distro??process.env.WSL_DISTRO_NAME??'','WSL distribution',128);
  // The child supervises one native provider. Terminal-only switches must not reach it.
  const token=Buffer.from(JSON.stringify({db:store.path,workspace:store.workspace,role:plan.role,actor:store.actor,options:nativeOptions(options),runtime})).toString('base64url');
  const module=fileURLToPath(import.meta.url);
  const args=['-w',plan.window,'new-tab','--title',plan.role,'wsl.exe','-d',distro,'--exec',process.execPath,module,'--run-token',token];
  check(args.every(a=>!/[;\r\n\0"]/.test(a)),'Windows Terminal arguments cannot contain semicolons, quotes or control characters');
  return args;
}
function startupRequest(store:Store,role:string):StartupRequest {
  const base=dirname(lockPath(store,role));mkdirSync(base,{recursive:true,mode:0o700});
  const directory=mkdtempSync(join(base,`.startup-${role}-`)),token=randomUUID();
  writeFileSync(join(directory,'request.json'),JSON.stringify({token,parent_pid:process.pid,parent_identity:processIdentity(process.pid)}),{mode:0o600,flag:'wx'});
  return {directory,token};
}
function checkStartup(request:StartupRequest):void {
  const current=JSON.parse(readFileSync(join(request.directory,'request.json'),'utf8'));
  check(current.token===request.token&&current.parent_identity&&processIdentity(current.parent_pid)===current.parent_identity,'Launch request expired or its parent stopped; provider startup cancelled',4);
}
function notifyStartup(runtime:LaunchRuntime|undefined,response:Omit<StartupResponse,'token'>):void {
  const request=runtime?.startup;if(!request||request.responded)return;
  checkStartup(request);
  const temporary=join(request.directory,`response-${request.token}.tmp`);
  writeFileSync(temporary,JSON.stringify({...response,token:request.token}),{mode:0o600,flag:'wx'});
  renameSync(temporary,join(request.directory,'response.json'));request.responded=true;
}
function startedResponse(store:Store,role:string,status:'started'|'already-running',sessionId?:number):Omit<StartupResponse,'token'> {
  const row=sessionId?store.get('SELECT * FROM sessions WHERE workspace_id=? AND id=?',store.ws,sessionId):store.all('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY id DESC',store.ws,role).find(row=>sessionState(row)==='running');
  check(row&&sessionState(row)==='running','Provider exited before startup could be confirmed',4);
  return {status,session_id:`S${row.id}`,pid:row.pid,process_start:row.process_start};
}
async function awaitStartup(store:Store,role:string,request:StartupRequest,terminal:ReturnType<typeof spawn>):Promise<StartupResponse> {
  const deadline=Date.now()+startupTimeoutMs;
  while(Date.now()<deadline) {
    if(terminal.exitCode!==null&&terminal.exitCode!==0)throw new Error(`Windows Terminal exited with ${terminal.exitCode} before provider startup. Check wt.exe and the WSL distribution.`);
    const path=join(request.directory,'response.json');
    if(existsSync(path)) {
      const response:StartupResponse=JSON.parse(readFileSync(path,'utf8'));
      check(response.token===request.token,'Invalid terminal startup acknowledgement',4);
      check(response.status!=='failed',response.message??'Provider startup failed in the terminal',4);
      check(response.status==='started'||response.status==='already-running','Unknown terminal startup acknowledgement',4);
      const row=store.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? AND id=?',store.ws,role,id(response.session_id??'','S'));
      check(row&&row.pid===response.pid&&row.process_start===response.process_start&&sessionState(row)==='running','Provider exited or changed before startup confirmation; inspect the new terminal',4);
      return response;
    }
    await new Promise(resolveDelay=>setTimeout(resolveDelay,50));
  }
  throw new Error(`No verified startup acknowledgement for ${role} within ${startupTimeoutMs/1000} seconds. Check the new terminal and sassato sessions before retrying.`);
}
function runtimeEnvironment(store:Store,role:string,parentPath:string):{directory:string;env:NodeJS.ProcessEnv} {
  const directory=mkdtempSync(join(dirname(lockPath(store,role)),`.runtime-${role}-`));
  const cli=fileURLToPath(new URL('../bin/sassato.js',import.meta.url));
  try{symlinkSync(cli,join(directory,'sassato'));symlinkSync(cli,join(directory,'sas'));}
  catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
  return {directory,env:{...process.env,PATH:[directory,dirname(process.execPath),parentPath].join(':'),SASSATO_DB:store.path,SASSATO_WORKSPACE:store.workspace,SASSATO_ROLE:role}};
}
function lockPath(store:Store,role:string):string {return join(`${store.path}.launch`,store.workspace,`${name(role)}.lock`);}
function acquire(store:Store,role:string):()=>void {
  const path=lockPath(store,role),token=randomUUID();
  // Serialize both acquiring and explicitly removing locks with SQLite's same writer lock.
  // Otherwise two stale-unlock calls could remove a new launcher's replacement lock.
  store.tx(()=>{
    assertWorkAllowed(store,role);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    let fd:number;
    try {fd=openSync(path,'wx',0o600);} catch(error) {
      if((error as NodeJS.ErrnoException).code==='EEXIST') throw new Error(`Launch lock exists for ${role}. Another launcher may be active. Use launch-unlock only after checking it has stopped.`);
      throw error;
    }
    try {writeFileSync(fd,JSON.stringify({pid:process.pid,identity:processIdentity(process.pid),token,created_at:now()}));fsyncSync(fd);} finally {closeSync(fd);}
  });
  return ()=>store.tx(()=>{
    if(!existsSync(path))return;
    const lock=JSON.parse(readFileSync(path,'utf8'));
    check(lock.token===token,'Launch lock was externally replaced; leaving the replacement intact',4);
    unlinkSync(path);
  });
}
export function unlockLaunch(store:Store,roles:string[]):{unlocked:string[]} {
  store.requireHuman();check(roles.length>0,'Name a role to unlock');
  return store.tx(()=>{
    const unlocked:string[]=[];
    for(const role of roles) {
      store.role(role);const path=lockPath(store,role);if(!existsSync(path))continue;
      let lock:{pid?:number;identity?:string};
      try{lock=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error(`Unreadable launch lock for ${role}; inspect ${path} manually`);}
      check(Number.isInteger(lock.pid)&&!!lock.identity,`Unverifiable lock for ${role}; inspect ${path} manually`,4);
      check(processIdentity(lock.pid!)!==lock.identity,`Launcher for ${role} is still running`,4);
      unlinkSync(path);unlocked.push(role);
    }
    return {unlocked};
  });
}
function verifyExecutable(executable:string,env:NodeJS.ProcessEnv):void {
  const result=spawnSync(executable,['--version'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],shell:false,env});
  check(!result.error&&result.status===0,`Cannot run ${executable}. Install it or use launch --dry-run. ${result.error?.message??''}`,3);
}
async function terminateUnconfirmed(child:ReturnType<typeof spawn>,exited:Promise<unknown>):Promise<void> {
  child.kill('SIGTERM');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const gone=await Promise.race([exited.then(()=>true),new Promise<boolean>(resolveDelay=>{timer=setTimeout(()=>resolveDelay(false),500);})]);
  if(timer)clearTimeout(timer);
  if(!gone){child.kill('SIGKILL');await exited;}
}
async function runNative(store:Store,plan:LaunchPlan,options:LaunchOptions,runtime?:LaunchRuntime):Promise<void> {
  check(store.path!==':memory:','Launching requires a persistent database');
  check(process.platform==='linux','Verified native launch currently requires Linux/WSL. On other systems, launch the provider manually and run sassato context.',3);
  const release=acquire(store,plan.role);
  let environment:ReturnType<typeof runtimeEnvironment>|undefined;
  try {
    check(!plan.stopFile||!existsSync(plan.stopFile),`Stop signal exists at ${plan.stopFile}; leave it intact until the operator clears it`,4);
    // Re-plan inside the role lock: two concurrent launchers cannot both pass this check.
    const fresh=planLaunch(store,[plan.role],nativeOptions(options))[0];
    if(fresh.status==='already-running') {plan.status='already-running';notifyStartup(runtime,startedResponse(store,plan.role,'already-running'));return;}
    if(runtime?.startup)checkStartup(runtime.startup);
    check(!runtime||runtime.provider===fresh.provider,'Provider configuration changed during launch; retry the preview',4);
    fresh.executable=resolveExecutable(runtime?.executable??fresh.executable,true);plan.executable=fresh.executable;
    environment=runtimeEnvironment(store,plan.role,runtime?.path??process.env.PATH??'');
    verifyExecutable(fresh.executable,environment.env);
    const child=store.tx(()=>{
      assertWorkAllowed(store,fresh.role);
      if(runtime?.startup)checkStartup(runtime.startup);
      return spawn(fresh.executable,fresh.args,{cwd:fresh.cwd,stdio:'inherit',shell:false,env:environment!.env});
    });
    const exited=new Promise<{code:number|null;error?:Error}>(resolveExit=>{
      child.once('exit',code=>resolveExit({code}));child.once('error',error=>resolveExit({code:null,error}));
    });
    await new Promise<void>((resolveSpawn,reject)=>{child.once('spawn',()=>resolveSpawn());child.once('error',reject);});
    const onInterrupt=()=>{child.kill('SIGINT');},onTerminate=()=>{child.kill('SIGTERM');};
    process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
    let registered:number|undefined;
    try {
      // spawn fires before a script's interpreter has necessarily finished exec. Only register
      // a provider-verified process, with a bounded retry that notices immediate exits.
      let registrationError:unknown;
      for(let attempt=0;attempt<25&&child.exitCode===null&&child.signalCode===null;attempt++) {
        const previousActor=store.actor;store.actor=fresh.role;
        try {
          registered=store.tx(()=>{
            const current=store.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? AND ended_at IS NULL',store.ws,fresh.role);
            const external=current&&current.pid===child.pid&&current.provider===fresh.provider&&current.external_id ? String(current.external_id) : fresh.sessionId??undefined;
            return id(registerSession(store,{provider:fresh.provider,external_id:external,pid:child.pid,replace:true}).id,'S');
          });
          break;
        }catch(error){registrationError=error;}
        finally{store.actor=previousActor;}
        await new Promise(resolveDelay=>setTimeout(resolveDelay,20));
      }
      if(!registered&&child.exitCode===null&&child.signalCode===null) {
        await terminateUnconfirmed(child,exited);
        throw registrationError??new Error('Could not register the newly started provider');
      }
      if(registered) {
        plan.runtimeSessionId=`S${registered}`;plan.pid=child.pid;
        try {if(runtime?.startup)notifyStartup(runtime,startedResponse(store,plan.role,'started',registered));}
        catch(error) {
          await terminateUnconfirmed(child,exited);
          throw error;
        }
      }
      const result=await exited;
      if(registered) store.tx(()=>{
        // SessionStart may replace the row after /clear. End only this child's currently
        // registered row, using PID plus fingerprint so no successor process can be touched.
        const row=store.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? AND ended_at IS NULL',store.ws,fresh.role);
        const original=store.get('SELECT process_start FROM sessions WHERE workspace_id=? AND id=?',store.ws,registered!);
        if(row&&row.pid===child.pid&&row.process_start===original?.process_start) {
          store.run('UPDATE sessions SET ended_at=?,last_seen_at=? WHERE workspace_id=? AND id=?',now(),now(),store.ws,row.id);
          store.event('session',`S${row.id}`,'launcher-exited',{role:fresh.role,exit_code:result.code});
        }
      });
      plan.status='exited';
      check(!result.error&&result.code===0,`${fresh.provider} exited with ${result.code??'a signal'}. The role's work is intact; check its saved session or use --fresh.`,4);
    }finally{process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);}
  } finally {if(environment)rmSync(environment.directory,{recursive:true,force:true});release();}
}
export async function launch(store:Store,roles:string[],options:LaunchOptions={}):Promise<LaunchPlan[]> {return launchInternal(store,roles,options);}
async function launchInternal(store:Store,roles:string[],options:LaunchOptions,runtime?:LaunchRuntime):Promise<LaunchPlan[]> {
  const plans=planLaunch(store,roles,options);
  if(options.dryRun)return plans;
  store.requireHuman();
  for(const plan of plans) {
    if(plan.status==='already-running'){notifyStartup(runtime,startedResponse(store,plan.role,'already-running'));continue;}
    check(!plan.stopFile||!existsSync(plan.stopFile),`Stop signal exists at ${plan.stopFile}; the launcher never removes it`,4);
    if(plan.terminal==='native') await runNative(store,plan,options,runtime);
    else {
      check(process.platform==='linux'&&!!process.env.WSL_DISTRO_NAME,'Windows Terminal launch must run inside WSL',3);
      plan.executable=resolveExecutable(plan.provider,true);
      const startup=startupRequest(store,plan.role);
      try {
        // Transport a resolved provider and the caller's PATH through an encoded payload.
        // wsl.exe --exec need not load a login shell and no path becomes shell source.
        const childRuntime:LaunchRuntime={provider:plan.provider,executable:plan.executable,path:process.env.PATH??'',startup};
        const args=windowsTerminalArgs(store,plan,options,childRuntime);
        const child=store.tx(()=>{assertWorkAllowed(store,plan.role);return spawn('wt.exe',args,{stdio:'ignore',shell:false});});
        await new Promise<void>((res,rej)=>{child.once('spawn',()=>res());child.once('error',rej);});
        child.unref();
        const response=await awaitStartup(store,plan.role,startup,child);
        plan.status=response.status as 'started'|'already-running';plan.runtimeSessionId=response.session_id;plan.pid=response.pid;
      } finally {rmSync(startup.directory,{recursive:true,force:true});}
    }
  }
  return plans;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--run-token') {
  let store:Store|undefined,runtime:LaunchRuntime|undefined;
  try {
    check(process.argv[3]?.length<=64_000,'Invalid launch payload');
    const payload=JSON.parse(Buffer.from(process.argv[3],'base64url').toString('utf8'));
    const db=text(payload.db,'database'),workspace=name(payload.workspace),role=name(payload.role),candidate:LaunchRuntime=payload.runtime;
    check(candidate&&(candidate.provider==='claude'||candidate.provider==='codex')&&isAbsolute(candidate.executable),'Missing resolved provider in terminal launch payload');
    check(typeof candidate.path==='string'&&candidate.path.length<=32_000&&!candidate.path.includes('\0'),'Invalid launch PATH');
    const startup=candidate.startup;
    check(startup&&uuid.test(startup.token)&&dirname(resolve(startup.directory))===resolve(`${db}.launch`,workspace)&&basename(startup.directory).startsWith(`.startup-${role}-`),'Invalid startup acknowledgement path');
    runtime=candidate;checkStartup(startup);process.env.PATH=runtime.path;
    store=new Store(db,name(payload.actor));store.use(workspace);
    await launchInternal(store,[role],nativeOptions({...payload.options,dryRun:false}),runtime);
  }catch(error){
    const message=error instanceof Error?error.message:'Launch failed';
    try{notifyStartup(runtime,{status:'failed',message});}catch { /* Parent already exited or timed out. */ }
    console.error(message);process.exitCode=2;
  }finally{store?.close();}
}
