import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { waitForWork, type WaitResult } from './mail-wait.js';
import { Store, databasePath, SCHEMA_VERSION, type Row } from './storage.js';
import { AppError, check, integer } from './errors.js';
import * as a from './admin.js';
import * as t from './tasks.js';
import * as c from './coordination.js';
import * as m from './migration.js';
import * as l from './launch.js';
import { setup } from './setup.js';
import { promptSetup } from './setup-prompt.js';
import { loadConfig, configPath } from './config.js';
import { workspaceSettings, setWorkspaceSettings, type WorkspaceSettings } from './workspace-settings.js';
import * as control from './control.js';
import { stop } from './stop.js';
import { getCheckpoint } from './checkpoints.js';
import { saveCheckpoint } from './recovery-write.js';

const HELP = `sassato (sas) — local agent coordination

Setup:      init (interactive in a terminal) | init --workspace NAME
            [--humans NAME[,NAME] | --config FILE] [--dry-run]
            [--interactive | --no-interactive] [--launch builder,reviewer --new-window --as HUMAN]
            workspace attach PATH --as HUMAN
            workspace settings | workspace set --default-human NAME --as HUMAN
            roles | role set NAME [--provider claude|codex] [--model MODEL] [--dir PATH]
            [--kind human|agent] [--effort LEVEL] [--permission-mode MODE] [--sandbox MODE] [--approval POLICY]
Tasks:      add TITLE [--body TEXT] [--for ROLE] [--owner ROLE] [--human-only]
            tasks [--status open,doing,blocked,review|all] [--available] [--limit N] [--after T1]
            show T1 | take T1 [--hours 4] | renew T1 | note T1 TEXT
            update T1 --expect VERSION [--title TEXT] [--body TEXT]
            handoff T1 ROLE SUMMARY | release T1 REASON
            submit T1 SUMMARY | review T1 --approve|--reject --expect VERSION --note TEXT
            done T1 [--ref COMMIT] | drop T1 REASON | reopen T1 REASON
            after T1 T2 | unafter T1 T2
Blockers:   block T1 TEXT --kind agent|human|external|other --waits-on NAME
            blockers [--task T1 | --chain T1] | resolve B1 REASON
Decisions:  ask-human T1 QUESTION [--for HUMAN] [--options 'one|two'] [--recommend TEXT]
            [--command TEXT] | humans [--for HUMAN] | answer H1 ANSWER (or answer T1 ANSWER) [--close]
Mail:       send ROLE[,ROLE]|all TEXT [--re T1] [--urgent]
            wait [--since EVENT_CURSOR] [--timeout SECONDS] [--urgent]
            inbox [--peek] [--state unread|read|done] | outbox | ack M1
Knowledge:  fact set KEY TEXT --source LOCATION [--expect VERSION]
            fact get KEY | fact history KEY | facts
WIP:        wip [show ROLE] | wip set --current TEXT --next TEXT --notes TEXT
            (updates require --expect VERSION)
Recovery:   checkpoint show [ROLE]
            checkpoint save --current TEXT --next TEXT --notes TEXT [--expect WIP_VERSION]
Sessions:   session register --provider NAME [--session-id ID] [--pid PID]
            [--replace] | session heartbeat [--session-id ID] | session end
            sessions | usage TEXT [--until DATE]
Control:    stop [ROLE...] [--all] [--timeout SECONDS | --no-wait | --force]
            stop-status [ROLE...] | stopped R1 | resume-work [ROLE...] [--all]
Read:       context [--brief] [--since EVENT_CURSOR] | status
            search TEXT [--type task,message,fact,event] [--phrase|--prefix]
Migration:  import --backlog FILE --wip FILE --actions DIR --sessions FILE
            --dry-run (preview), then same paths --confirm DIGEST [--repair]
            export NEW_DIRECTORY
Launch:     launch ROLE [--fresh|--resume] [--dry-run] [--no-prompt]
            [--terminal native|windows-terminal] [--new-window] [--all] | launch-unlock ROLE
Maintenance: migrate | doctor | backup NEW_FILE --as HUMAN | restore BACKUP --db NEW_FILE
             machine (system load only)

Global: --db PATH --workspace NAME --as ROLE --json --help
Identity defaults: SASSATO_DB, SASSATO_WORKSPACE, SASSATO_ROLE; attached paths
select workspace when not explicit. Writes require --as; human actions require a human role.
Lists default to bounded results; --limit N. Context never consumes inbox receipts.
Exit codes: 0 success/no matches; 1 storage/runtime; 2 input; 3 identity/access; 4 conflict; 5 mail-wait timeout.
`;
const strings = ['db','workspace','as','config','default-human','import-timezone','humans','launch','provider','model','effort','permission-mode','sandbox','approval','dir','kind','body','title','for','owner','priority','status','limit','hours','expect','ref','note','waits-on','task','chain','options','recommend','command','re','state','source','checked-at','current','next','notes','session-id','pid','until','since','type','backlog','wip','actions','sessions','confirm','terminal','distro','window','stop-file','timeout','before-event','after'];
const booleans = ['json','help','version','human-only','agent-allowed','review-required','no-review','available','approve','reject','peek','replace','brief','phrase','prefix','dry-run','fresh','resume','all','no-prompt','new-window','force','no-wait','urgent','close','repair','interactive','no-interactive'];
const globalFlags = ['db','workspace','as','json','help'];
const allowed: Record<string,string[]> = {
  init:['config','humans','interactive','no-interactive','launch','dry-run','fresh','resume','no-prompt','terminal','distro','window','stop-file','new-window'], 'workspace attach':[], 'workspace settings':[], 'workspace set':['default-human','import-timezone','stop-file'],roles:[], 'role set':['provider','model','effort','permission-mode','sandbox','approval','dir','kind'],
  add:['title','body','for','owner','priority','human-only','review-required'],tasks:['status','owner','for','available','limit','after'],show:['limit','before-event'],
  take:['hours'],renew:['hours'],note:[],update:['expect','title','body','priority','for','human-only','agent-allowed','review-required','no-review'],handoff:[],release:[],submit:[],review:['approve','reject','note','expect'],done:['ref'],drop:[],reopen:[],after:[],unafter:[],block:['kind','waits-on'],blockers:['task','chain','limit','all'],resolve:[],
  'ask-human':['for','options','recommend','command'],'ask-johan':['options','recommend','command'],answer:['close'],humans:['for','limit'],johan:['limit'],send:['re','urgent'],wait:['urgent','timeout','stop-file','since'],inbox:['peek','state','limit'],outbox:['limit'],ack:[],
  'fact set':['source','checked-at','expect'],'fact get':[],'fact history':[],facts:['limit'],
  'wip show':[],'wip set':['current','next','notes','expect'],sessions:[], 'session register':['provider','session-id','pid','replace'],'session heartbeat':['session-id'],'session end':['session-id'],usage:['until'],
  stop:['all','timeout','no-wait','force'],'stop-status':[],stopped:[],'resume-work':['all'],
  context:['brief','since','limit'],status:[],search:['type','owner','status','since','limit','phrase','prefix'],
  'checkpoint show':[], 'checkpoint save':['current','next','notes','expect'],
  import:['backlog','wip','actions','sessions','dry-run','confirm','repair'],export:[],launch:['fresh','resume','dry-run','no-prompt','terminal','distro','window','stop-file','all','new-window'],'launch-unlock':[],migrate:[],doctor:[],backup:[],restore:[],machine:[]
};
function humanOutput(value: unknown): string {
  if(value && typeof value==='object' && 'reason' in value && 'role' in value) {
    const event=value as WaitResult;
    let summary:string;
    if(event.reason==='urgent') summary=`URGENT ${event.message!.id} from ${event.message!.sender}: ${event.message!.summary}`;
    else if(event.reason==='stop') summary=event.stop!.file?`STOP ${event.stop!.file} for ${event.role}: follow repository stop instructions.`:`STOP ${event.stop!.id} for ${event.role}: check context and stop work.`;
    else if(event.reason==='answer') summary=`ANSWER ${event.question} for ${event.task}: read the human answer.`;
    else if(event.reason==='blocker-resolved') summary=`BLOCKER ${event.blocker} resolved for ${event.task}: check remaining work.`;
    else if(event.reason==='review-submitted') summary=`REVIEW ${event.task} needs review (version ${event.version}): read the current task before reviewing.`;
    else if(event.reason==='review-approved') summary=`REVIEW ${event.task} approved (version ${event.version}): check context before completing.`;
    else if(event.reason==='review-rejected') summary=`REVIEW ${event.task} rejected (version ${event.version}): read the review and revise.`;
    else if(event.reason==='task-assigned') summary=`TASK ${event.task} assigned to ${event.role}: check context.`;
    else if(event.reason==='task-ready') {const tasks=event.tasks??[event.task!];summary=`TASK ${tasks.slice(0,8).join(', ')} ready for ${event.role}${tasks.length>8?` (+${tasks.length-8} more; inspect context/tasks)`:''}.`;}
    else summary=`Timed out waiting for work notifications for ${event.role}.`;
    return `${summary} · cursor ${event.cursor}`;
  }
  if(value && typeof value==='object' && 'items' in value && 'has_more' in value) {
    const page=value as t.TaskPage;
    return humanOutput(page.items)+(page.has_more?`\nMore tasks exist. Continue with the same filters and --after ${page.next_after} (adjust --limit if needed).`:'');
  }
  if(value && typeof value==='object' && 'statuses' in value && 'timed_out' in value) {
    const report=value as Row;
    const lines=[report.force?'Force stop requested.':report.timed_out?'Timed out; stop requests remain active.':report.interrupted?'Stop wait interrupted; inspect stop-status.':report.complete?'All selected roles have stopped or are inactive.':'Stop requested; agents are still stopping.'];
    for(const row of report.statuses) lines.push(`${row.id} ${row.role}: ${row.state}`);
    for(const signal of report.signals) lines.push(`${signal.role} PID ${signal.pid??'unknown'}: ${signal.status} (${signal.reason})`);
    if(report.force) lines.push(...report.limitations);
    lines.push('A human can run sassato resume-work --as <human-role> when ready to allow new work.');
    return lines.join('\n');
  }
  if (value && typeof value==='object' && 'summary' in value && 'items' in value && 'digest' in value) {
    const preview=value as m.ImportPreview;
    const lines=[`Import preview: ${JSON.stringify(preview.summary)}`,`Confirmation digest: ${preview.digest}`];
    for(const item of preview.items.slice(0,100)) {
      lines.push(`${item.decision} ${item.status} ${item.owner??'unassigned'} · ${item.title.replace(/\s+/g,' ')} · ${item.source}:${item.line}${item.warnings.length?' · '+item.warnings.join('; '):''}`);
      if(item.decision==='repair') {
        const r=item as unknown as Row;
        if(item.kind==='wip') {
          lines.push(`  WIP ${item.owner}: ${r.before?.wip?.updated_at} → ${r.after?.wip?.updated_at}`);
          lines.push(`  Before: ${JSON.stringify(r.before?.wip?.current)}\n  After: ${JSON.stringify(r.after?.wip?.current)}`);
        } else lines.push(`  ${r.taskId}: ${r.before?.task?.status} → ${r.after?.task?.status}; blockers ${JSON.stringify(r.before?.blockers)} → ${JSON.stringify(r.after?.blockers)}; questions ${JSON.stringify(r.before?.questions)} → ${JSON.stringify(r.after?.questions)}`);
      }
    }
    if(preview.items.length>100)lines.push(`${preview.items.length-100} additional items; use --json to inspect the complete preview before confirming.`);
    lines.push(...preview.warnings);return lines.join('\n');
  }
  if (Array.isArray(value)) {
    if (!value.length) return 'No matches.';
    return value.map(row => {
      if (!row || typeof row !== 'object') return String(row);
      const r = row as Row;
      if (r.kind === 'question' || r.question) return `${r.id} ${r.task_id ?? ''} ${r.question}\n${r.options?.length ? `  Options: ${r.options.map((o: string,i: number)=>`${i+1}. ${o}`).join(' | ')}\n` : ''}${r.recommendation ? `  Recommend: ${r.recommendation}\n` : ''}${r.command ? `  Command: ${r.command}\n` : ''}`;
      if (r.title || r.body || r.snippet) return [r.id,r.urgent?'URGENT':null,r.status ?? r.state,r.owner ?? r.sender ?? r.role,r.title ?? r.key, String(r.snippet ?? r.body ?? '').replace(/\s+/g,' ').slice(0,220)].filter(v=>v!==null&&v!==undefined&&v!=='').join(' · ');
      return JSON.stringify(r);
    }).join('\n');
  }
  return JSON.stringify(value,null,2);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  process.umask(0o077);
  const wantsJson=argv.includes('--json'); let store: Store | undefined;
  try {
    const opts: Record<string,{type:'string'|'boolean';short?:string}> = {};
    for (const name of strings) opts[name]={type:'string'};
    for (const name of booleans) opts[name]={type:'boolean'};
    opts.help.short='h';
    const {values,positionals}=parseArgs({args:argv,options:opts,allowPositionals:true,strict:true});
    const v=values as Record<string,string|boolean|undefined>;
    const str=(key:string):string|undefined=>typeof v[key]==='string'?v[key] as string:undefined;
    const num=(key:string):number|undefined=>str(key)!==undefined?integer(str(key),key):undefined;
    const bool=(key:string):boolean=>v[key]===true;
    const need=(key:string):string=>{const val=str(key);check(val!==undefined,`Missing --${key}`);return val;};
    if (bool('help') || !positionals.length && !bool('version')) {console.log(bool('json')?JSON.stringify({help:HELP}):HELP);return;}
    if (bool('version')) {const build=JSON.parse(readFileSync(new URL('./build-info.json',import.meta.url),'utf8'));console.log(bool('json')?JSON.stringify({...build,schema:SCHEMA_VERSION}):`${build.version} (build ${build.build})`);return;}
    const p=[...positionals];let command=p.shift()!;
    if (command==='task') command=p.shift()??'tasks';
    if (['workspace','role','fact','session'].includes(command)) command+=' '+(p.shift()??'');
    if (command==='checkpoint') command+=' '+(p.shift()??'show');
    if (command==='wip') command+=' '+(p[0]==='show'||p[0]==='set'?p.shift():'show');
    check(command in allowed,`Unknown command ${command}. Run sassato --help.`);
    for (const key of Object.keys(v)) check(globalFlags.includes(key)||allowed[command].includes(key),`--${key} does not apply to ${command}`);
    const arg=(label:string):string=>{const x=p.shift();check(x!==undefined,`Missing ${label}`);return x;};
    const rest=(label:string):string=>{const x=p.join(' ');p.length=0;check(x.length>0,`Missing ${label}`);return x;};
    const empty=()=>check(p.length===0,`Unexpected argument: ${p[0]}`);
    const db=databasePath(str('db')),workspace=str('workspace')??(process.env.SASSATO_WORKSPACE||undefined),actor=str('as')??(process.env.SASSATO_ROLE||undefined);
    const launchOptions: l.LaunchOptions={fresh:bool('fresh'),resume:bool('resume'),all:bool('all'),noPrompt:bool('no-prompt'),dryRun:bool('dry-run'),terminal:str('terminal') as l.LaunchOptions['terminal'],distro:str('distro'),window:str('window'),stopFile:str('stop-file'),newWindow:bool('new-window')};
    const jsonLaunch=()=>check(!bool('json')||bool('dry-run')||str('terminal')==='windows-terminal'||bool('new-window')&&str('terminal')!=='native','Interactive native launch cannot use --json; use --dry-run --json to inspect');
    let result: unknown;
    if(command==='init') {
      empty();
      check(!(bool('interactive') && bool('no-interactive')), 'Choose --interactive or --no-interactive');
      const interactive = bool('interactive') || (argv.length === 1 && !workspace && !!process.stdin.isTTY && !!process.stdout.isTTY);
      check(!interactive || (!bool('json') && !str('config') && !str('humans')), 'Interactive setup cannot use --json, --config or --humans');
      check(!interactive || (process.stdin.isTTY && process.stdout.isTTY), 'Interactive setup requires a terminal; use --workspace and --humans in scripts');
      const config=str('config') ? loadConfig(str('config')!) : undefined;
      const answers = interactive ? await promptSetup(workspace) : undefined;
      const selectedWorkspace = answers?.workspace ?? workspace ?? config?.workspace;
      check(selectedWorkspace, 'init requires --workspace NAME (or run bare sassato init in a terminal)');
      const launchRoles=str('launch')?.split(',').map(role=>role.trim());
      for(const flag of ['fresh','resume','no-prompt','terminal','distro','window','stop-file','new-window']) check(v[flag]===undefined||launchRoles,`--${flag} requires --launch when used with init`);
      if(launchRoles) jsonLaunch();
      result=await setup({database:db,workspace:selectedWorkspace,actor:actor??answers?.actor,config,humans:answers?.humans??str('humans')?.split(',').map(value=>value.trim()),launchRoles,launchOptions,dryRun:bool('dry-run')});
    }
    else if(command==='restore') {const source=arg('backup');empty();check(str('db'),'Restore requires explicit --db NEW_FILE');result=await a.restoreDatabase(source,db);}
    else if(command==='machine') {empty();result=a.machine();}
    else {
      const reads=['tasks','show','blockers','humans','johan','outbox','fact get','fact history','facts','wip show','sessions','roles','workspace settings','wait','stop-status','context','status','search','export','doctor','checkpoint show'];
      const readonly=reads.includes(command)||command==='inbox'&&bool('peek')||['launch','import'].includes(command)&&bool('dry-run');
      store=new Store(db,actor,{readonly});
      const s=store;
      if(command!=='migrate') s.use(workspace);
      switch(command) {
        case 'migrate': empty();result={schema:SCHEMA_VERSION,database:s.path};break;
        case 'workspace attach': {const path=arg('path');empty();result=a.attachWorkspace(s,path);break;}
        case 'workspace settings': empty();result=workspaceSettings(s);break;
        case 'workspace set': {
          empty();const patch:Partial<WorkspaceSettings>={};
          if(str('default-human')!==undefined)patch.default_human=str('default-human')==='none'?null:str('default-human')!;
          if(str('import-timezone')!==undefined)patch.import_timezone=str('import-timezone')!;
          if(str('stop-file')!==undefined)patch.stop_file=str('stop-file')==='none'?null:configPath(str('stop-file')!);
          result=setWorkspaceSettings(s,patch);break;
        }
        case 'roles': empty();result=c.roles(s);break;
        case 'role set': {const role=arg('role');empty();result=c.setRole(s,role,{provider:str('provider'),model:str('model'),reasoning_effort:str('effort'),permission_mode:str('permission-mode'),sandbox_mode:str('sandbox'),approval_policy:str('approval'),working_dir:str('dir'),kind:str('kind') as 'agent'|'human'|undefined});break;}
        case 'add': {const title=str('title')??rest('title');empty();result=t.addTask(s,{title,body:str('body'),owner:str('owner'),forRole:str('for'),priority:num('priority'),humanOnly:bool('human-only'),reviewRequired:bool('review-required')});break;}
        case 'tasks': empty();result=t.listTaskPage(s,{status:str('status'),owner:str('owner'),forRole:str('for'),available:bool('available'),limit:num('limit'),after:str('after')});break;
        case 'show': {const task=arg('task');empty();result=task.startsWith('T')?t.showTask(s,task,{historyLimit:num('limit'),beforeEvent:num('before-event')}):a.showRecord(s,task);break;}
        case 'take': case 'renew': {const task=arg('task');empty();result=(command==='take'?t.takeTask:t.renewTask)(s,task,{hours:num('hours')});break;}
        case 'note': case 'release': case 'submit': case 'drop': case 'reopen': {const task=arg('task'),note=rest('note');result=({note:t.noteTask,release:t.releaseTask,submit:t.submitTask,drop:t.dropTask,reopen:t.reopenTask}[command]!)(s,task,note);break;}
        case 'update': {const task=arg('task');empty();check(!(bool('human-only')&&bool('agent-allowed')),'Conflicting human flags');check(!(bool('review-required')&&bool('no-review')),'Conflicting review flags');result=t.updateTask(s,task,{version:integer(need('expect'),'expect',1),title:str('title'),body:str('body'),priority:num('priority'),forRole:str('for')==='none'?null:str('for'),humanOnly:bool('human-only')?true:bool('agent-allowed')?false:undefined,reviewRequired:bool('review-required')?true:bool('no-review')?false:undefined});break;}
        case 'handoff': {const task=arg('task'),to=arg('role');result=t.handoffTask(s,task,to,rest('summary'));break;}
        case 'review': {const task=arg('task');empty();check(bool('approve')!==bool('reject'),'Choose --approve or --reject');result=t.reviewTask(s,task,{approve:bool('approve'),note:need('note'),expected_version:integer(need('expect'),'expected version',1)});break;}
        case 'done': {const task=arg('task');empty();result=t.doneTask(s,task,{ref:str('ref')});break;}
        case 'after': case 'unafter': {const task=arg('task'),dep=arg('dependency');empty();result=(command==='after'?t.addDependency:t.removeDependency)(s,task,dep);break;}
        case 'block': {const task=arg('task');result=t.blockTask(s,task,{body:rest('reason'),kind:need('kind'),waitingOn:need('waits-on')});break;}
        case 'blockers': empty();result=t.listBlockers(s,{task:str('task'),chain:str('chain'),open:!bool('all'),limit:num('limit')});break;
        case 'resolve': {const blocker=arg('blocker');result=t.resolveBlocker(s,blocker,rest('resolution'));break;}
        case 'ask-human': case 'ask-johan': {const task=arg('task');result=(command==='ask-johan'?t.askJohan:t.askHuman)(s,task,{question:rest('question'),forRole:str('for'),options:str('options')?.split('|'),recommendation:str('recommend'),command:str('command')});break;}
        case 'answer': {const question=arg('question or task');result=t.answerQuestion(s,question,rest('answer'),{close:bool('close')});break;}
        case 'humans': case 'johan': empty();result=t.humanQueue(s,{limit:num('limit'),forRole:str('for')});break;
        case 'send': {const to=arg('recipient');result=c.send(s,to==='all'?'all':to.split(','),rest('message'),{task:str('re'),urgent:bool('urgent')});break;}
        case 'wait': {empty();result=await waitForWork(s,{timeout:num('timeout'),stopFile:str('stop-file'),since:num('since')});if((result as WaitResult).reason==='timeout')process.exitCode=5;break;}
        case 'inbox': empty();result=c.inbox(s,{peek:bool('peek'),state:str('state') as 'unread'|'read'|'done'|undefined,limit:num('limit')});break;
        case 'outbox': empty();result=c.outbox(s,{limit:num('limit')});break;
        case 'ack': {const message=arg('message');empty();result=c.acknowledge(s,message);break;}
        case 'fact set': {const key=arg('key');result=c.setFact(s,key,{body:rest('fact'),source:need('source'),checked_at:str('checked-at'),expected_version:num('expect')});break;}
        case 'fact get': case 'fact history': {const key=arg('key');empty();result=command==='fact get'?c.facts(s,{key}):c.factHistory(s,key);break;}
        case 'facts': empty();result=c.facts(s,{limit:num('limit')});break;
        case 'wip show': {const role=p.shift();empty();result=c.getWip(s,role);break;}
        case 'wip set': empty();result=c.setWip(s,{current:str('current'),next:str('next'),notes:str('notes'),expected_version:num('expect')});break;
        case 'sessions': empty();result=c.sessions(s);break;
        case 'session register': empty();result=c.registerSession(s,{provider:need('provider'),external_id:str('session-id'),pid:num('pid'),replace:bool('replace')});break;
        case 'session heartbeat': case 'session end': empty();result=(command==='session heartbeat'?c.heartbeat:c.endSession)(s,str('session-id'));break;
        case 'stop': {result=await stop(s,p.splice(0),{all:bool('all'),force:bool('force'),noWait:bool('no-wait'),timeout:num('timeout'),onProgress:bool('json')?undefined:(rows)=>console.error('Waiting: '+rows.map(row=>`${row.role}: ${row.state}`).join(', '))});if((result as Row).timed_out||(result as Row).interrupted||(result as Row).signals?.some((signal: Row)=>signal.status==='refused'))process.exitCode=4;break;}
        case 'stop-status': result=control.stopStatus(s,p.splice(0));break;
        case 'stopped': {const request=arg('stop request');empty();result=control.acknowledgeStop(s,request);break;}
        case 'resume-work': result=control.resumeWork(s,p.splice(0),{all:bool('all')});break;
        case 'usage': result=c.setUsage(s,rest('usage note'),str('until'));break;
        case 'context': empty();result=c.context(s,{since:num('since'),limit:num('limit')});break;
        case 'checkpoint show': {const role=p.shift();empty();result=getCheckpoint(s,role);break;}
        case 'checkpoint save': empty();result=saveCheckpoint(s,{current:need('current'),next:need('next'),notes:need('notes'),expected_version:num('expect')});break;
        case 'status': empty();result=a.status(s);break;
        case 'search': result=a.search(s,rest('query'),{type:str('type'),role:str('owner'),status:str('status'),since:str('since'),limit:num('limit'),phrase:bool('phrase'),prefix:bool('prefix')});break;
        case 'import': empty();{const input={backlog:str('backlog'),wip:str('wip'),actions:str('actions'),sessions:str('sessions'),repair:bool('repair')};check(bool('dry-run')!==!!str('confirm'),'Use --dry-run to preview or --confirm DIGEST to apply');result=bool('dry-run')?m.previewImport(s,input):m.applyImport(s,input,need('confirm'));}break;
        case 'export': {const path=arg('new directory');empty();result=m.exportMarkdown(s,path);break;}
        case 'launch': {jsonLaunch();result=await l.launch(s,p.splice(0),launchOptions);break;}
        case 'launch-unlock': result=l.unlockLaunch(s,p.splice(0));break;
        case 'doctor': empty();result=a.doctor(s);if(!(result as Row).ok)process.exitCode=1;break;
        case 'backup': {const path=arg('backup destination');empty();result=await a.backupDatabase(s,path);break;}
      }
    }
    console.log(bool('json')?JSON.stringify(result):command==='context'?c.renderContext(result as c.ContextData):humanOutput(result));
  } catch(error) {
    const code=error instanceof AppError?error.code:typeof (error as NodeJS.ErrnoException)?.code==='string'&&(error as NodeJS.ErrnoException).code!.startsWith('ERR_PARSE_ARGS')?2:1;
    const message=error instanceof Error?error.message:'Unexpected failure';
    console.error(wantsJson?JSON.stringify({error:message,code}):`sassato: ${message}`);process.exitCode=code;
  } finally {store?.close();}
}
