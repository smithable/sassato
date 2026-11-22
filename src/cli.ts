import { launchWatch, reconcileWatch, watchStatus } from './launch-watch.js';
import { wake as wakeCommand } from './wake.js';
import { formatDigest } from './wait-digest.js';
import { parseArgs } from 'node:util';
import { readFileSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { unchangedIdleText, waitForWork, type WaitResult } from './mail-wait.js';
import { Store, databasePath, SCHEMA_VERSION, type Row } from './storage.js';
import { humanWaits } from './humans.js';
import { AppError, check, integer } from './errors.js';
import * as a from './admin.js';
import * as t from './tasks.js';
import * as c from './coordination.js';
import * as fb from './feedback.js';
import * as m from './migration.js';
import * as l from './launch.js';
import * as lw from './launch-watched.js';
import { retitleImportedTasks } from './retitle.js';
import { setup } from './setup.js';
import { promptSetup } from './setup-prompt.js';
import { loadConfig, configPath } from './config.js';
import { workspaceSettings, setWorkspaceSettings, setRoleAutocompact, roleAutocompact, setRoleAdvisor, roleAdvisor, validAdvisor, acceptCodexVersion, type WorkspaceSettings } from './workspace-settings.js';
import * as control from './control.js';
import { stop } from './stop.js';
import { getCheckpoint } from './checkpoints.js';
import { getNotificationProgress, parseIdleReceipt, parseScoredReceipt, saveNotificationProgress } from './notification-progress.js';
import { saveCheckpoint } from './recovery-write.js';
import * as jobs from './jobs.js';
import * as supervisor from './supervisor-monitor.js';
import * as attended from './attended.js';
import { waitWithManagedObservation } from './managed-wait.js';
import * as checkouts from './checkouts.js';
import * as briefs from './task-briefs.js';

const HELP = `sassato (sas) — local agent coordination

Code map:   index build [--repo PATH] | index update --diff BASE..HEAD
            index find WORD | index show FILE|FUNCTION|MODULE [--repo PATH] [--limit N]
            [--cache PATH] (standalone; no workspace, daemon or model)

Setup:      init (interactive in a terminal) | init --workspace NAME
            [--humans NAME[,NAME] | --config FILE] [--dry-run]
            [--interactive | --no-interactive] [--launch builder,reviewer --new-window --as HUMAN]
            workspace attach PATH --as HUMAN
            workspace settings | workspace set --default-human NAME | --wake-mode legacy|scored | --speed slow|normal|fast
            workspace wake-audit [--limit N] --as HUMAN
            workspace set --feedback-closers ROLE,ROLE|none --as HUMAN (roles besides humans that close feedback)
            codex versions | codex accept VERSION [--replace] --as HUMAN (the Codex CLI versions launch accepts)
            roles | role set NAME [--provider claude|codex] [--model MODEL] [--dir PATH]
            [--kind human|agent] [--effort LEVEL] [--permission-mode MODE] [--sandbox MODE] [--approval POLICY]
            [--autocompact TOKENS|auto] (Claude roles; a human sets it; launch passes --autocompact)
            [--advisor MODEL|off] (Claude roles; a human sets it; launch passes --advisor)
Tasks:      add TITLE [--body TEXT] [--for ROLE] [--owner ROLE] [--human-only] [--spare]
            tasks [--status open,doing,blocked,review|all] [--available] [--spare] [--limit N] [--after T1]
              (spare tasks are listed apart and offered only to an idle role; update T1 --spare|--no-spare)
            show T1 | take T1 [--hours 4] | renew T1 | note T1 TEXT
            update T1 --expect VERSION [--title TEXT] [--body TEXT]
            retitle [--owner ROLE] [--apply] (preview imported titles by default)
            handoff T1 ROLE SUMMARY | release T1 REASON
            submit T1 SUMMARY [--reviewer ROLE[,ROLE]] | review T1 --approve|--reject --expect VERSION --note TEXT
            done T1 [--ref COMMIT] | drop T1 REASON | reopen T1 REASON
            after T1 T2 | unafter T1 T2
Blockers:   block T1 TEXT --kind agent|human|external|other --waits-on NAME
            blockers [--task T1 | --chain T1] | resolve B1 REASON
Decisions:  ask-human T1 QUESTION (or ask-human --new TITLE QUESTION) [--for HUMAN] [--options 'one|two'] [--recommend TEXT]
            [--command TEXT] | humans [--for HUMAN] [--untouched] | answer H1 ANSWER (or answer T1 ANSWER, or answer --asked QUESTION --on T1|--new TITLE ANSWER) [--close] [--relayed-by ROLE]
            withdraw H1 REASON (the asker, the task's creator or a human)
Mail:       send ROLE[,ROLE]|all TEXT [--re T1] [--urgency 0..10] [--reason TEXT] [--urgent | --now]
            wait [--since EVENT_CURSOR] [--timeout SECONDS] [--settle SECONDS] [--settle-max SECONDS]
            ack M1 [M2 ...] (up to 100; atomic)
            agents settle 120s, maximum 600s; --settle 0 returns the first wake
            inbox [--peek] [--unread | --state unread|read|done] (newest first) | sent (or outbox) | ack M1
            wake [--pending | --since CURSOR] [--ack M1,M2] [--idle-minutes N] [--timeout S]: wait, then print everything to act on
              (STOP, each entry's full text, mail to acknowledge), save the cursor, and end with the re-arm command
Knowledge:  fact set KEY TEXT --source LOCATION [--expect VERSION]
            fact get KEY | fact history KEY | facts
Feedback:   feedback add workflow|tokens|untested|sampleusers|sassato TEXT [--re T1] (one line; wakes nobody)
            feedback list [--kind K] [--author ROLE] [--all] [--limit N] [--after K1]
            feedback close K1 --task T1 | --fact KEY | --dropped REASON (a human, or a role in --feedback-closers)
WIP:        wip [show ROLE] | wip set --current TEXT --next TEXT --notes TEXT
            (updates require --expect VERSION)
Recovery:   checkpoint show [ROLE]
            checkpoint save --current TEXT --next TEXT --notes TEXT [--expect WIP_VERSION] [--evidence FILE]
            progress show [ROLE] | progress save --cursor N --expect VERSION [--scored-receipt JSON | --idle-receipt JSON]
Checkouts:  checkout register --dir PATH | checkout list | checkout show ID
            checkout bind ID --dir PATH --task T1 --provider NAME --session-id ID [--mode coding|review]
            checkout resolve PATH [--task T1] | checkout release
Briefs:     brief save T1 --file JSON --expect TASK_VERSION | brief show T1
            handoff T1 ROLE SUMMARY --brief-file JSON_FILE --expect TASK_VERSION (pending retirement)
Supervisor: supervise [status] | supervise ping ROLE | supervise ack NONCE --generation N
            supervise enroll --role ROLE --file JSON (human, attended only)
            supervise --attended --role ROLE | supervise attach --role ROLE (human terminals)
            supervise assignment | supervise reconcile --session-id ID
            supervise ready --file JSON --expect TASK_VERSION (last worker tool call)
            (observation only; real provider management remains disabled)
Sessions:   session register --provider NAME [--session-id ID] [--pid PID]
            [--replace] | session heartbeat [--session-id ID] | session end
            sessions | usage TEXT [--until DATE]
Control:    stop [ROLE...] [--all] [--timeout SECONDS | --no-wait | --force]
            stop-status [ROLE...] [--quiet] [--stop-file PATH] | stopped R1 | resume-work [ROLE...] [--all]
Jobs:       job run --kind KIND [--wait | --no-wait] [--job-version TEXT] [--load more|same|less]
            [--mem MB] -- COMMAND [ARGS...] (heavy work: waits for room, measured)
            job list | job stats
Read:       context [--brief] [--since EVENT_CURSOR] [--line-length N] | status [--line-length N]
            search TEXT [--type task,message,fact,feedback,event] [--phrase|--prefix]
Migration:  import --backlog FILE --wip FILE --actions DIR --sessions FILE
            --dry-run (preview), then same paths --confirm DIGEST [--repair]
            export NEW_DIRECTORY
Launch:     launch ROLE [--fresh|--resume] [--dry-run] [--no-prompt]; launch --watched ROLE...|--all [--close-stale] [--dry-run] (as the human)
            [--terminal native|windows-terminal] [--new-window] [--all] | launch-unlock ROLE
            launch-watch ROLE --remote unix:///PATH --session-id UUID | watch-status ROLE | watch-close ROLE --epoch N
Maintenance: migrate | doctor | backup NEW_FILE --as HUMAN | restore BACKUP --db NEW_FILE
             machine (system load only)

Global: --db PATH --workspace NAME --as ROLE --json --help
Identity defaults: SASSATO_DB, SASSATO_WORKSPACE, SASSATO_ROLE; attached paths
select workspace when not explicit. Writes require --as; human actions require a human role.
Lists default to bounded results; --limit N. Context never consumes inbox receipts.
Exit codes: 0 success/no matches; 1 storage/runtime; 2 input; 3 identity/access; 4 conflict; 5 mail-wait timeout.
`;
export const strings = ['reviewer','feedback-closers','author','fact','dropped','spare-work','spare-providers','new','asked','remote','epoch','role','line-length','settle','settle-max','generation','repo','cache','diff','brief-file','mode','file','job-version','open-work-roles','load','mem','db','workspace','as','config','default-human','import-timezone','humans','launch','provider','model','effort','permission-mode','sandbox','approval','dir','kind','body','title','for','owner','priority','status','limit','hours','expect','ref','note','waits-on','task','chain','options','recommend','command','re','state','source','checked-at','current','next','notes','session-id','pid','until','since','type','backlog','wip','actions','sessions','confirm','terminal','distro','window','stop-file','busy-checks','import-answer-markers','import-role-aliases','import-timezone-aliases','timeout','before-event','after','evidence','cursor','relayed-by','on','answers','idle-minutes','digest-skip','ack','autocompact','advisor','wake-mode','speed','wake-roles','urgency','reason','scored-receipt','idle-receipt'];
export const booleans = ['watched','close-stale','spare','no-spare','pending','untouched','unread','attended','now','json','help','version','human-only','agent-allowed','review-required','no-review','available','approve','reject','peek','replace','brief','phrase','prefix','dry-run','fresh','resume','all','no-prompt','new-window','force','no-wait','wait','urgent','needs-reply','close','repair','interactive','no-interactive','quiet','apply'];
export const globalFlags = ['db','workspace','as','json','help'];
export const allowed: Record<string,string[]> = {
  'index build':['repo','cache'],'index update':['repo','cache','diff'],'index find':['repo','cache','limit'],'index show':['repo','cache','limit'],
  init:['config','humans','interactive','no-interactive','launch','dry-run','fresh','resume','no-prompt','terminal','distro','window','stop-file','new-window'], 'workspace attach':[], 'workspace settings':[], 'workspace wake-audit':['limit'], 'workspace set':['default-human','import-timezone','stop-file','busy-checks','import-answer-markers','import-role-aliases','import-timezone-aliases','open-work-roles','digest-skip','wake-mode','speed','wake-roles','spare-work','spare-providers','feedback-closers'],roles:[], 'role set':['provider','model','effort','permission-mode','sandbox','approval','dir','kind','autocompact','advisor'],
  add:['title','body','for','owner','priority','human-only','review-required','spare'],tasks:['status','owner','for','available','limit','after','spare'],show:['limit','before-event'],
  take:['hours'],renew:['hours'],note:[],update:['expect','title','body','priority','for','human-only','agent-allowed','review-required','no-review','spare','no-spare'],handoff:['brief-file','expect'],release:[],submit:['reviewer'],review:['approve','reject','note','expect'],done:['ref'],drop:[],reopen:[],after:[],unafter:[],block:['kind','waits-on','on'],blockers:['task','chain','limit','all'],resolve:[],
  'ask-human':['for','options','recommend','command','new'],answer:['close','relayed-by','asked','on','new'],withdraw:[],humans:['for','limit','untouched'],send:['re','urgent','needs-reply','now','urgency','reason'],wait:['urgent','timeout','stop-file','since','idle-minutes','settle','settle-max'],inbox:['peek','state','limit','unread'],wake:['pending','since','ack','timeout','stop-file','idle-minutes','settle','settle-max'],outbox:['limit'],sent:['limit'],retitle:['owner','apply'],ack:[],
  'fact set':['source','checked-at','expect','answers'],'feedback add':['re'],'feedback list':['kind','author','all','limit','after'],'feedback close':['task','fact','dropped'],'fact get':[],'fact history':[],'codex accept':['replace'],'codex versions':[],facts:['limit'],
  'wip show':[],'wip set':['current','next','notes','expect'],sessions:[], 'session register':['provider','session-id','pid','replace'],'session heartbeat':['session-id'],'session end':['session-id'],usage:['until'],
  stop:['all','timeout','no-wait','force'],'stop-status':['quiet','stop-file'],stopped:[],'resume-work':['all'],
  context:['brief','since','limit','line-length'],status:['line-length'],'job run':['kind','wait','no-wait','job-version','load','mem'],'job list':[],'job stats':[],search:['type','owner','status','since','limit','phrase','prefix'],
  'supervise attended':['attended','role'],'supervise enroll':['role','file'],'supervise attach':['role'],'supervise assignment':[],'supervise reconcile':['session-id'],'supervise ready':['file','expect'],'supervise status':[],'supervise ping':[],'supervise ack':['generation'],
  'checkout register':['dir'],'checkout list':[],'checkout show':[],'checkout bind':['dir','task','provider','session-id','mode'],'checkout resolve':['task'],'checkout release':[],'brief save':['file','expect'],'brief show':[],
  'checkpoint show':[], 'checkpoint save':['current','next','notes','expect','evidence'], 'progress show':[], 'progress save':['cursor','expect','scored-receipt','idle-receipt','stop-file'],
  import:['backlog','wip','actions','sessions','dry-run','confirm','repair'],export:[],launch:['fresh','resume','dry-run','no-prompt','terminal','distro','window','stop-file','all','new-window','watched','close-stale'],'launch-watch':['remote','session-id'],'watch-roles':[],'watch-status':[],'watch-close':['epoch'],'launch-unlock':[],migrate:[],doctor:[],backup:[],restore:[],machine:[]
};
function checkpointEvidence(path: string | undefined): unknown {
  if (path===undefined) return undefined;
  let fd:number;
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK);} catch {check(false,'Evidence file could not be opened; provide a readable regular JSON file');}
  try {
    check(fstatSync(fd).isFile(),'Evidence must be a regular JSON file');
    const buffer=Buffer.alloc(32_769);let size=0;
    while(size<buffer.length) {
      const read=readSync(fd,buffer,size,buffer.length-size,null);
      if(!read)break;size+=read;
    }
    check(size<=32_768,'Evidence file must be at most 32768 bytes');
    try {return JSON.parse(buffer.subarray(0,size).toString('utf8'));}
    catch {check(false,'Evidence file must contain valid JSON');}
  } catch(error) {
    if(error instanceof AppError)throw error;
    check(false,'Evidence file could not be read; provide a readable regular JSON file');
  } finally {closeSync(fd);}
}
function humanOutput(value: unknown, command?: string): string {
  if(Array.isArray(value)&&command==='ack')return `Acknowledged ${value.map((row:Row)=>row.message_id).join(', ')}.`;
  if(Array.isArray(value)&&(command==='sent'||command==='outbox')) {
    return value.length?value.map((message:Row)=>`${message.id}: ${String(message.body).replace(/\s+/g,' ').slice(0,240)}\n  ${message.receipts.map((r:Row)=>`${r.recipient}: ${r.state==='done'?'acked':r.state}`).join(', ')}`).join('\n'):'No sent messages.';
  }
  if(Array.isArray(value)&&command==='retitle') {
    return value.length?value.map((row:Row)=>`${row.id}${row.applied?' updated':' preview'}: ${row.before} → ${row.title}`).join('\n'):'No imported titles need cleanup.';
  }
  if(value && typeof value==='object' && command==='feedback list') {
    const page=value as {items:Row[];has_more:boolean;next_after:string|null};
    const lines=page.items.map(k=>`${k.id} · ${k.kind} · ${k.author} · ${String(k.created_at).slice(0,16).replace('T',' ')}${k.task_id?` · ${k.task_id}`:''}: ${k.body}${k.open?'':` (closed: ${k.outcome} ${k.outcome_ref})`}`);
    return (lines.length?lines.join('\n'):'No feedback.')+(page.has_more?`\nMore exist; continue with --after ${page.next_after}.`:'');
  }
  if(value && typeof value==='object' && command==='done') {
    const task=value as Row;
    return `${task.id} done: ${String(task.title).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,220)}`;
  }
  if(value && typeof value==='object' && command==='send') {
    const mail=value as Row;
    return `${mail.id} sent to ${mail.recipients.join(', ')} · ${mail.urgency} points${mail.now?' · immediate':''}`;
  }
  if(value && typeof value==='object' && command==='resolve') {
    const blocker=value as Row;
    return `${blocker.id} resolved for ${blocker.task_id}.`;
  }
  // The attended runner's result also has role and reason; it is not a wait event.
  if(value && typeof value==='object' && command==='supervise attended') {
    const r=value as Row;
    return `Attended ${r.role}: generation ${r.generation} ${r.state}${r.reason?` (${r.reason})`:''}; unattended mode ${r.unattended_enabled?'ON':'OFF'}.`;
  }
  if(value && typeof value==='object' && 'reason' in value && 'role' in value) {
    const event=value as WaitResult;
    let summary:string;
    if(event.reason==='digest')return formatDigest(event.digest!,event.cursor);
    const unchanged=unchangedIdleText(event.idle??event.scored?.idle);
    if(unchanged&&(event.reason==='own-work'||event.reason==='open-work'||event.reason==='spare-work'))summary=unchanged;
    else if(event.reason==='supervisor-ping') summary=`PING generation ${event.generation}, nonce ${event.nonce}: acknowledge through sassato supervise ack NONCE --generation GENERATION after reconciling current state`;
    else if(event.reason==='urgent') summary=`URGENT ${event.message!.id} from ${event.message!.sender}: ${event.message!.summary}`;
    else if(event.reason==='reply-needed') summary=`REPLY ${event.message!.id} from ${event.message!.sender} asks for your reply: ${event.message!.summary}`;
    else if(event.reason==='open-work') summary=`OPEN WORK ${(event.tasks??[]).slice(0,8).join(', ')} for ${event.role}, none taken, with nothing written for a while: take one (sassato take ${(event.tasks??[])[0]}), or say why not.`;
    else if(event.reason==='spare-work') summary=`SPARE WORK ${(event.tasks??[]).join(', ')} offered to ${event.role}, which has nothing else to do: take one if you have room (sassato take ${(event.tasks??[])[0]}), or leave them.`;
    else if(event.reason==='own-work') summary=`OWN WORK ${(event.tasks??[]).slice(0,8).join(', ')} held by ${event.role} with nothing written for a while: carry on, or block or release what waits on others.`;
    else if(event.reason==='stop') summary=event.stop!.file?`STOP ${event.stop!.file} for ${event.role}: follow repository stop instructions.`:`STOP ${event.stop!.id} for ${event.role}: check context and stop work.`;
    else if(event.reason==='answer') summary=`ANSWER ${event.question} for ${event.task}: read the human answer.`;
    else if(event.reason==='blocker-assigned') summary=`BLOCKER ${event.blocker} on ${event.task} waits on ${event.role}: inspect the blocker.`;
    else if(event.reason==='dependency-dropped') summary=`DEPENDENCY ${event.task} dropped; inspect affected tasks ${(event.tasks??[]).join(', ')}.`;
    else if(event.reason==='blocker-resolved') summary=`BLOCKER ${event.blocker} resolved for ${event.task}: check remaining work.`;
    else if(event.reason==='review-submitted') summary=`REVIEW ${event.task} needs review (version ${event.version}): read the current task before reviewing.`;
    else if(event.reason==='review-approved') summary=`REVIEW ${event.task} approved (version ${event.version}): check context before completing.`;
    else if(event.reason==='review-rejected') summary=`REVIEW ${event.task} rejected (version ${event.version}): read the review and revise.`;
    else if(event.reason==='task-assigned') summary=`TASK ${event.task} assigned to ${event.role}: check context.`;
    else if(event.reason==='task-ready') {const tasks=event.tasks??[event.task!];summary=`TASK ${tasks.slice(0,8).join(', ')} ready for ${event.role}${tasks.length>8?` (+${tasks.length-8} more; inspect context/tasks)`:''}.`;}
    else summary=`Timed out waiting for work notifications for ${event.role}.`;
    return `${summary}${event.cursor===undefined||event.cursor===null?'':` · cursor ${event.cursor}`}${event.message?.inbox_command?`\nRead full mail: ${event.message.inbox_command}`:""}${event.digest?'\n'+formatDigest(event.digest,event.cursor):''}`;
  }
  if(value && typeof value==='object' && 'items' in value && 'has_more' in value) {
    const page=value as t.TaskPage;
    return (page.items.length||!page.spare?.length?humanOutput(page.items):'No other tasks.')+(page.spare?.length?`\nSpare, offered only to an idle role:\n${humanOutput(page.spare)}`:'')+(page.has_more?`\nMore tasks exist. Continue with the same filters and --after ${page.next_after} (adjust --limit if needed).`:'');
  }
  if(value && typeof value==='object' && 'statuses' in value && 'timed_out' in value) {
    const report=value as Row;
    const lines=[report.force?'Force stop requested.':report.timed_out?'Timed out; stop requests remain active.':report.interrupted?'Stop wait interrupted; inspect stop-status.':report.complete?'All selected roles have stopped or are inactive.':'Stop requested; agents are still stopping.'];
    for(const row of report.statuses) lines.push(`${row.id} ${row.role}: ${row.state}`);
    for(const item of report.busy_checks??[]) lines.push(`Busy check ${item.name}: ${item.state} (${item.reason})`);
    if(report.machine_quiet===true)lines.push('Selected roles stopped; configured busy checks are idle.');
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
      const waited = r.age_days === undefined ? '' : ` (${[r.asked_by ? `asked by ${r.asked_by}` : null, `${r.age_days} d`, r.untouched ? 'untouched' : null].filter(Boolean).join(', ')})`;
      if (r.kind === 'question' || r.question) return `${r.id} ${r.task_id ?? ''} ${r.question}${waited}\n${r.options?.length ? `  Options: ${r.options.map((o: string,i: number)=>`${i+1}. ${o}`).join(' | ')}\n` : ''}${r.recommendation ? `  Recommend: ${r.recommendation}\n` : ''}${r.command ? `  Command: ${r.command}\n` : ''}`;
      if (r.title || r.body || r.snippet) return [r.id,r.now?'NOW':r.urgent?'URGENT':null,r.status ?? r.state,r.owner ?? r.sender ?? r.role,r.title ?? r.key, String(r.snippet ?? r.body ?? '').replace(/\s+/g,' ').slice(0,220), r.answered_in ? `answered in ${r.answered_in}` : null, waited ? waited.trim() : null].filter(v=>v!==null&&v!==undefined&&v!=='').join(' · ');
      return JSON.stringify(r);
    }).join('\n');
  }
  return JSON.stringify(value,null,2);
}
/** A saved WIP or checkpoint that names a wait on a human gets a warning line on stderr and in its JSON. Read before the save, so nothing after it can fail. */
function withWarnings(result: unknown, warnings: string[]): unknown {
  for (const line of warnings) console.error(`sassato: warning: ${line}`);
  return warnings.length && result && typeof result === 'object' ? { ...result, warnings } : result;
}
/** Where the version a command's --expect takes is shown. */
function expectSource(command: string): string {
  if (command==='wip set'||command==='checkpoint save') return 'the WIP version, from sassato wip show (or version= on the wip line of context).';
  if (command==='progress save') return 'the progress version, from sassato progress show.';
  if (command==='fact set') return 'the fact version, from sassato fact get KEY.';
  return 'the item version, from sassato show ID.';
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
    const num=(key:string):number|undefined=>str(key)===undefined?undefined:key==='expect'&&!/^-?[0-9]+$/.test(str(key)!)?(check(false,`--expect takes the current version as a number: ${expectSource(command)}`) as never):key==='priority'&&str(key)==='now'?t.NOW:key==='priority'&&str(key)==='normal'?0:integer(str(key),key);
    const bool=(key:string):boolean=>v[key]===true;
    const expectNum=():number=>{need('expect');return num('expect')!;};
    const need=(key:string):string=>{const val=str(key);check(val!==undefined,`Missing --${key}`);return val;};
    const filled=(key:string):string=>{const val=need(key);check(val.trim()!=="",`--${key} is empty; write what applies, or "none" when there is nothing to add`);return val;};
    if (bool('help') || !positionals.length && !bool('version')) {console.log(bool('json')?JSON.stringify({help:HELP}):HELP);return;}
    if (bool('version')) {const build=JSON.parse(readFileSync(new URL('./build-info.json',import.meta.url),'utf8'));console.log(bool('json')?JSON.stringify({...build,schema:SCHEMA_VERSION}):`${build.version} (build ${build.build})`);return;}
    const p=[...positionals];let command=p.shift()!;
    if (command==='task') command=p.shift()??'tasks';
    if (['workspace','role','fact','feedback','session','job','checkout','brief','index','codex'].includes(command)) command+=' '+(p.shift()??'');
    if (command==='supervise') command+=' '+(p.shift()??(bool('attended')?'attended':'status'));
    if (command==='checkpoint' || command==='progress') command+=' '+(p.shift()??'show');
    // wip get is an alias of wip show, which prints the version that wip set --expect takes.
    if (command==='wip') command+=' '+(p[0]==='show'||p[0]==='set'?p.shift():p[0]==='get'?(p.shift(),'show'):'show');
    check(command in allowed,`Unknown command ${command}. Run sassato --help.`);
    for (const key of Object.keys(v)) check(globalFlags.includes(key)||allowed[command].includes(key),`--${key} does not apply to ${command}`);
    const arg=(label:string):string=>{const x=p.shift();check(x!==undefined,`Missing ${label}`);return x;};
    const rest=(label:string):string=>{const x=p.join(' ');p.length=0;check(x.length>0,`Missing ${label}`);return x;};
    const empty=()=>check(p.length===0,`Unexpected argument: ${p[0]}`);
    const db=databasePath(str('db')),workspace=str('workspace')??(process.env.SASSATO_WORKSPACE||undefined),actor=str('as')??(process.env.SASSATO_ROLE||undefined);
    const launchOptions: l.LaunchOptions={fresh:bool('fresh'),resume:bool('resume'),all:bool('all'),noPrompt:bool('no-prompt'),dryRun:bool('dry-run'),terminal:str('terminal') as l.LaunchOptions['terminal'],distro:str('distro'),window:str('window'),stopFile:str('stop-file'),newWindow:bool('new-window'),watched:bool('watched')};
    const jsonLaunch=()=>check(!bool('json')||bool('dry-run')||str('terminal')==='windows-terminal'||bool('new-window')&&str('terminal')!=='native','Interactive native launch cannot use --json; use --dry-run --json to inspect');
    let result: unknown;
    if(command.startsWith('index ')) {
      const index=await import('./index.js');
      const options={repo:str('repo'),cache:str('cache'),limit:num('limit')};
      if(command==='index build') {empty();result=index.buildIndex(options);}
      else if(command==='index update') {empty();result=index.buildIndex(options,need('diff'));}
      else {const query=rest('index name or path');result=(command==='index find'?index.findIndex:index.showIndex)(query,options);}
      console.log(bool('json')?JSON.stringify(result,null,2):'items' in (result as object)?index.formatIndex(result as import('./index-types.js').IndexResult):JSON.stringify(result,null,2));
      return;
    }
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
      const reads=['watch-status','supervise assignment','supervise status','checkout list','checkout show','checkout resolve','brief show','job list','job stats','tasks','show','blockers','humans','outbox','sent','fact get','fact history','feedback list','codex versions','facts','wip show','sessions','roles','workspace settings','workspace wake-audit','wait','stop-status','context','status','search','export','doctor','checkpoint show','progress show'];
      const readonly=reads.includes(command)||command==='retitle'&&!bool('apply')||command==='inbox'&&bool('peek')||['launch','import'].includes(command)&&bool('dry-run');
      store=new Store(db,actor,{readonly,managedWriteMode:command==='supervise reconcile'?'reconcile':command==='supervise ack'?'normal':command==='stopped'?'stop-ack':'normal'});
      const s=store;
      if(command!=='migrate') s.use(workspace);
      switch(command) {
        case 'migrate': empty();result={schema:SCHEMA_VERSION,database:s.path};break;
        case 'workspace attach': {const path=arg('path');empty();result=a.attachWorkspace(s,path);break;}
        case 'workspace settings': empty();result=workspaceSettings(s);break;
        case 'codex versions': empty();result={accepted:workspaceSettings(s).codex_versions};break;
        case 'codex accept': {const version=arg('version');empty();result={accepted:acceptCodexVersion(s,version,bool('replace'))};break;}
        case 'workspace wake-audit': empty();result=c.wakeAudit(s,num('limit'));break;
        case 'workspace set': {
          empty();const patch:Partial<WorkspaceSettings>={};
          if(str('default-human')!==undefined)patch.default_human=str('default-human')==='none'?null:str('default-human')!;
          if(str('import-timezone')!==undefined)patch.import_timezone=str('import-timezone')!;
          if(str('stop-file')!==undefined)patch.stop_file=str('stop-file')==='none'?null:configPath(str('stop-file')!);
          for(const [flag,key] of [['busy-checks','busy_checks'],['import-answer-markers','import_answer_markers'],['import-role-aliases','import_role_aliases'],['import-timezone-aliases','import_timezone_aliases']] as const) if(str(flag)!==undefined) {
            try {patch[key]=JSON.parse(str(flag)!);}catch {check(false,`--${flag} must be valid JSON`);}
          }
          if(str('digest-skip')!==undefined)try{patch.digest_skip=JSON.parse(str('digest-skip')!);}catch{check(false,'--digest-skip must be valid JSON');}
          if(str('open-work-roles')!==undefined)patch.open_work_roles=str('open-work-roles')==='all'?null:str('open-work-roles')!.split(',').map(role=>role.trim()).filter(Boolean);
          if(str('spare-work')!==undefined){check(['on','off'].includes(str('spare-work')!),'--spare-work takes on or off');patch.spare_work=str('spare-work')==='on';}
          if(str('spare-providers')!==undefined){const list=str('spare-providers')==='any'?[]:str('spare-providers')!.split(',').map(p=>p.trim());check(list.every(Boolean),'--spare-providers takes provider names separated by commas, or any');patch.spare_providers=list;}
          if(str('feedback-closers')!==undefined)patch.feedback_closers=str('feedback-closers')==='none'?[]:str('feedback-closers')!.split(',').map(r=>r.trim());
          if(str('wake-mode')!==undefined)patch.wake_mode=str('wake-mode') as WorkspaceSettings['wake_mode'];
          if(str('speed')!==undefined)patch.speed=str('speed') as WorkspaceSettings['speed'];
          if(str('wake-roles')!==undefined)try{patch.wake_roles=JSON.parse(str('wake-roles')!);}catch{check(false,'--wake-roles must be valid JSON');}
          result=setWorkspaceSettings(s,patch);break;
        }
        case 'roles': {empty();const settings=workspaceSettings(s);result=c.roles(s).map(row=>row.provider==='claude'?{...row,autocompact:roleAutocompact(settings,String(row.name)),advisor:roleAdvisor(settings,String(row.name))}:row);break;}
        case 'role set': {const role=arg('role');empty();
          // A bad --autocompact is refused before anything is saved; the window is set after the role, so a
          // provider change in the same command is seen (T980).
          const compactValue=str('autocompact');
          if(compactValue!==undefined)check(compactValue==='auto'||(/^[0-9]+$/.test(compactValue)&&Number(compactValue)>=100_000&&Number(compactValue)<=10_000_000),'--autocompact takes a whole number of tokens from 100000 to 10000000, or auto');
          const advisorValue=str('advisor');
          if(advisorValue!==undefined)check(advisorValue==='off'||validAdvisor(advisorValue),'--advisor takes a model name such as opus or claude-opus-5-5, or off');
          // Refused before the role is saved, so --provider codex --advisor opus changes nothing (T1224).
          if(advisorValue!==undefined&&advisorValue!=='off')check((str('provider')??s.get('SELECT provider FROM roles WHERE workspace_id=? AND name=?',s.ws,role)?.provider)==='claude',`advisor is for Claude roles; ${role} would not be one`);
          result=c.setRole(s,role,{provider:str('provider'),model:str('model'),reasoning_effort:str('effort'),permission_mode:str('permission-mode'),sandbox_mode:str('sandbox'),approval_policy:str('approval'),working_dir:str('dir'),kind:str('kind') as 'agent'|'human'|undefined});
          if(compactValue!==undefined)result={...(result as Row),autocompact:setRoleAutocompact(s,role,compactValue)};
          if(advisorValue!==undefined)result={...(result as Row),advisor:setRoleAdvisor(s,role,advisorValue)};
          break;}
        case 'add': {const title=str('title')??rest('title');empty();result=t.addTask(s,{title,body:str('body'),owner:str('owner'),forRole:str('for'),priority:num('priority'),humanOnly:bool('human-only'),reviewRequired:bool('review-required'),spare:bool('spare')||undefined});break;}
        case 'tasks': empty();result=t.listTaskPage(s,{status:str('status'),owner:str('owner'),forRole:str('for'),available:bool('available'),limit:num('limit'),after:str('after'),spare:bool('spare')||undefined});break;
        case 'show': {const task=arg('task');empty();result=task.startsWith('T')?t.showTask(s,task,{historyLimit:num('limit'),beforeEvent:num('before-event')}):a.showRecord(s,task);break;}
        case 'retitle': empty();result=retitleImportedTasks(s,{owner:str('owner'),apply:bool('apply')});break;
        case 'take': case 'renew': {const task=arg('task');empty();result=(command==='take'?t.takeTask:t.renewTask)(s,task,{hours:num('hours')});break;}
        case 'submit': {const task=arg('task'),note=rest('note');result=t.submitTask(s,task,note,str('reviewer')?.split(','));break;}
        case 'note': case 'release': case 'drop': case 'reopen': {const task=arg('task'),note=rest('note');result=({note:t.noteTask,release:t.releaseTask,drop:t.dropTask,reopen:t.reopenTask}[command]!)(s,task,note);break;}
        case 'update': {const task=arg('task');empty();check(!(bool('spare')&&bool('no-spare')),'Conflicting spare flags');check(!(bool('human-only')&&bool('agent-allowed')),'Conflicting human flags');check(!(bool('review-required')&&bool('no-review')),'Conflicting review flags');result=t.updateTask(s,task,{version:integer(expectNum(),'expect',1),title:str('title'),body:str('body'),priority:num('priority'),forRole:str('for')==='none'?null:str('for'),humanOnly:bool('human-only')?true:bool('agent-allowed')?false:undefined,reviewRequired:bool('review-required')?true:bool('no-review')?false:undefined,spare:bool('spare')?true:bool('no-spare')?false:undefined});break;}
        case 'handoff': {const task=arg('task'),to=arg('role'),summary=rest('summary');check(str('brief-file')!==undefined || str('expect')===undefined,'--expect on handoff requires --brief-file');result=str('brief-file')===undefined?t.handoffTask(s,task,to,summary):briefs.pendingBoundHandoff(s,task,to,summary,checkpointEvidence(need('brief-file')),expectNum());break;}
        case 'review': {const task=arg('task');empty();check(bool('approve')!==bool('reject'),'Choose --approve or --reject');result=t.reviewTask(s,task,{approve:bool('approve'),note:need('note'),expected_version:integer(expectNum(),'expected version',1)});break;}
        case 'done': {const task=arg('task');empty();result=t.doneTask(s,task,{ref:str('ref')});break;}
        case 'after': case 'unafter': {const task=arg('task'),dep=arg('dependency');empty();result=(command==='after'?t.addDependency:t.removeDependency)(s,task,dep);break;}
        // block --on TASK waits on another task, such as the human-only task that holds a decision:
        // a dependency, so the task is ready and its owner woken when that task is done (T675).
        case 'block': {const task=arg('task'),on=str('on');if(on!==undefined){check(str('kind')===undefined&&str('waits-on')===undefined,'Use --on TASK or --kind with --waits-on, not both');empty();result=t.addDependency(s,task,on);}else result=t.blockTask(s,task,{body:rest('reason'),kind:need('kind'),waitingOn:need('waits-on')});break;}
        case 'blockers': empty();result=t.listBlockers(s,{task:str('task'),chain:str('chain'),open:!bool('all'),limit:num('limit')});break;
        case 'resolve': {const blocker=arg('blocker');result=t.resolveBlocker(s,blocker,rest('resolution'));break;}
        case 'ask-human': {const title=str('new');if(title!==undefined){check(!/^T[0-9]+$/.test(p[0]??''),'Give either --new TITLE or a task id, not both');result=t.askHumanNew(s,title,{question:rest('question'),forRole:str('for'),options:str('options')?.split('|'),recommendation:str('recommend'),command:str('command')});break;}const task=arg('task');result=t.askHuman(s,task,{question:rest('question'),forRole:str('for'),options:str('options')?.split('|'),recommendation:str('recommend'),command:str('command')});break;}
        case 'withdraw': {const question=arg('question');result=t.withdrawQuestion(s,question,rest('reason'));break;}
        case 'answer': {const asked=str('asked');if(asked!==undefined){const relayedBy=str('relayed-by');check(relayedBy!==undefined,'--asked records a question nobody recorded: say who heard it with --relayed-by ROLE');result=t.recordAnswered(s,{question:asked,task:str('on'),title:str('new'),answer:rest('answer'),relayedBy,close:bool('close')});break;}check(str('on')===undefined&&str('new')===undefined,'--on and --new go with --asked');const question=arg('question or task');result=t.answerQuestion(s,question,rest('answer'),{close:bool('close'),relayedBy:str('relayed-by')});break;}
        case 'humans': empty();result=t.humanQueue(s,{limit:num('limit'),forRole:str('for'),untouched:bool('untouched')});break;
        case 'send': {const to=arg('recipient');result=c.send(s,to==='all'?'all':to.split(','),rest('message'),{task:str('re'),urgent:bool('urgent'),needsReply:bool('needs-reply'),now:bool('now'),urgency:str('urgency'),reason:str('reason')});break;}
        case 'wait': {empty();result=await waitWithManagedObservation(s,{timeout:num('timeout'),stopFile:str('stop-file'),since:num('since'),idleMinutes:num('idle-minutes'),settle:num('settle'),settleMax:num('settle-max')});if((result as WaitResult).reason==='timeout')process.exitCode=5;break;}
        case 'inbox': empty();check(!(bool('unread')&&str('state')),'Give --unread or --state, not both');result=c.inbox(s,{peek:bool('peek'),state:(bool('unread')?'unread':str('state')) as 'unread'|'read'|'done'|undefined,limit:num('limit')});break;
        case 'wake': {
          empty();
          const pending=bool('pending');
          const out=await wakeCommand(s,{
            pending,timeout:num('timeout'),stopFile:str('stop-file'),since:num('since'),idleMinutes:num('idle-minutes'),
            settle:num('settle'),settleMax:num('settle-max'),ack:str('ack')?.split(',').map(x=>x.trim()).filter(Boolean),
          });
          if(pending){
            const payload=bool('json') ? JSON.stringify({result:out.result,text:out.text}) : out.text;
            await new Promise<void>((resolve,reject)=>process.stdout.write(payload+'\n',error=>error?reject(error):resolve()));
            const receipt=out.commit?.();
            if(receipt && !receipt.saved)throw new AppError(receipt.line,4);
            if(receipt && !bool('json'))console.log(receipt.line);
            return;
          }
          if(out.result.scored||out.result.idle){
            const payload=bool('json')?JSON.stringify({...out.result,acknowledged:out.acknowledged,text:out.text}):out.text;
            await new Promise<void>((resolve,reject)=>process.stdout.write(payload+'\n',error=>error?reject(error):resolve()));
            const receipt=out.commit?.();
            if(receipt&&!receipt.saved)throw new AppError(receipt.line,4);
            if(receipt&&!bool('json'))console.log(receipt.line);
            return;
          }
          if(bool('json')){
            const saved=out.commit?.();
            if(saved&&!saved.saved)process.exitCode=4;
            result={...out.result,saved:saved?.saved??false,acknowledged:out.acknowledged,text:out.text+(saved?'\n'+saved.line:'')};
          }else{
            console.log(out.text);
            const saved=out.commit?.();
            if(saved){console.log(saved.line);if(!saved.saved)process.exitCode=4;}
            return;
          }
          break;
        }
        case 'sent': case 'outbox': empty();result=c.outbox(s,{limit:num('limit')});break;
        case 'ack': {const messages=[arg('message'),...p.splice(0)];const rows=c.acknowledgeMany(s,messages);result=messages.length===1?rows[0]:rows;break;}
        case 'fact set': {const key=arg('key'),answers=str('answers');const set=()=>c.setFact(s,key,{body:rest('fact'),source:need('source'),checked_at:str('checked-at'),expected_version:num('expect')});
          result=answers===undefined?set():s.tx(()=>{const fact=set();t.markFactAnswer(s,answers,{id:fact.id,key:fact.key});return {...fact,answers};});break;}
        case 'fact get': case 'fact history': {const key=arg('key');empty();result=command==='fact get'?c.facts(s,{key}):c.factHistory(s,key);break;}
        case 'feedback add': {const kind=arg('kind');result=fb.addFeedback(s,kind,rest('feedback'),{re:str('re')});break;}
        case 'feedback list': empty();result=fb.listFeedback(s,{kind:str('kind'),author:str('author'),all:bool('all'),limit:num('limit'),after:str('after')});break;
        case 'feedback close': {const k=arg('feedback');empty();result=fb.closeFeedback(s,k,{task:str('task'),fact:str('fact'),dropped:str('dropped')});break;}
        case 'facts': empty();result=c.facts(s,{limit:num('limit')});break;
        case 'wip show': {const role=p.shift();empty();result=c.getWip(s,role);break;}
        case 'wip set': empty();{const warnings=humanWaits(s,{current:str('current'),next:str('next'),notes:str('notes')});result=withWarnings(c.setWip(s,{current:str('current'),next:str('next'),notes:str('notes'),expected_version:num('expect')}),warnings);}break;
        case 'sessions': empty();result=c.sessions(s);break;
        case 'session register': empty();result=c.registerSession(s,{provider:need('provider'),external_id:str('session-id'),pid:num('pid'),replace:bool('replace')});break;
        case 'session heartbeat': case 'session end': empty();result=(command==='session heartbeat'?c.heartbeat:c.endSession)(s,str('session-id'));break;
        case 'stop': {
          const cancellation=new AbortController(),cancel=()=>cancellation.abort();
          process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
          try {
            result=await stop(s,p.splice(0),{all:bool('all'),force:bool('force'),noWait:bool('no-wait'),timeout:num('timeout'),signal:cancellation.signal,onProgress:bool('json')?undefined:(rows,checks)=>{
              const remaining=[...rows.filter(row=>row.state==='waiting').map(row=>`${row.role}: ${row.state}`),...checks.filter(item=>item.state!=='idle').map(item=>`${item.name}: ${item.state} (${item.reason})`)];
              if(remaining.length)console.error('Waiting: '+remaining.join(', '));
            }});
          }finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
          if((result as Row).timed_out||(result as Row).interrupted||(result as Row).signals?.some((signal: Row)=>signal.status==='refused'))process.exitCode=4;break;
        }
        case 'stop-status': {
          check(bool('quiet')||str('stop-file')===undefined,'--stop-file requires --quiet for stop-status');
          if(bool('quiet')) {process.exitCode=control.activeStop(s,p.splice(0),str('stop-file'))?4:0;return;}
          result=control.stopStatus(s,p.splice(0));break;
        }
        case 'stopped': {const request=arg('stop request');empty();result=control.acknowledgeStop(s,request);break;}
        case 'resume-work': result=control.resumeWork(s,p.splice(0),{all:bool('all')});break;
        case 'usage': result=c.setUsage(s,rest('usage note'),str('until'));break;
        case 'context': empty();result=c.context(s,{since:num('since'),limit:num('limit'),brief:bool('brief'),lineLength:num('line-length')});break;
        case 'supervise attended': empty();check(bool('attended'),'Attended execution requires --attended');check(!bool('json'),'Interactive attended execution cannot use --json');result=await attended.runAttended(s,need('role'));break;
        case 'supervise enroll': empty();result=attended.enrollAttended(s,need('role'),checkpointEvidence(need('file')));break;
        case 'supervise attach': empty();check(!bool('json'),'Terminal attach cannot use --json');await attended.attachAttended(s,need('role'));break;
        case 'supervise assignment': empty();result=attended.attendedAssignment(s);break;
        case 'supervise reconcile': empty();result=attended.reconcileAttended(s,need('session-id'));break;
        case 'supervise ready': empty();result=attended.readyAttended(s,checkpointEvidence(need('file')),expectNum());break;
        case 'supervise status': empty();result=supervisor.supervisorStatus(s);break;
        case 'supervise ping': {const role=arg('worker role');empty();result=supervisor.requestSupervisorPing(s,role);break;}
        case 'supervise ack': {const nonce=arg('ping nonce');empty();result=supervisor.acknowledgeSupervisorPing(s,nonce,integer(need('generation'),'worker generation'));break;}
        case 'checkout register': empty();result=checkouts.registerCheckout(s,need('dir'));break;
        case 'checkout list': empty();result=checkouts.listCheckouts(s);break;
        case 'checkout show': {const checkout=arg('checkout');empty();result={...checkouts.registeredCheckout(s,checkout),observed:checkouts.inspectCheckout(s,checkout)};break;}
        case 'checkout bind': {const checkout=arg('checkout');empty();result=checkouts.bindCheckout(s,{checkout,directory:need('dir'),task:need('task'),provider:need('provider'),session:need('session-id'),mode:str('mode') as 'coding'|'review'|undefined});break;}
        case 'checkout resolve': {const path=arg('repository relative path');empty();result=checkouts.resolveWorkerPath(s,path,str('task'));break;}
        case 'checkout release': empty();result=checkouts.releaseCheckout(s);break;
        case 'brief save': {const task=arg('task');empty();result=briefs.saveTaskBrief(s,task,checkpointEvidence(need('file')),expectNum());break;}
        case 'brief show': {const task=arg('task');empty();result=briefs.showTaskBrief(s,task);break;}
        case 'checkpoint show': {const role=p.shift();empty();result=getCheckpoint(s,role);break;}
        case 'checkpoint save': empty();{const warnings=humanWaits(s,{current:str('current'),next:str('next'),notes:str('notes')});result=withWarnings(saveCheckpoint(s,{current:filled('current'),next:filled('next'),notes:filled('notes'),expected_version:num('expect'),evidence:checkpointEvidence(str('evidence'))}),warnings);}break;
        case 'progress show': {const role=p.shift();empty();result=getNotificationProgress(s,role);break;}
        case 'progress save': {
          empty();
          const cursor=integer(need('cursor'),'cursor'),expected_version=integer(expectNum(),'expect');
          const receipt=str('scored-receipt');
          const scored=receipt===undefined?undefined:parseScoredReceipt(receipt);
          const idleJson=str('idle-receipt');
          check(receipt===undefined||idleJson===undefined,'Choose a scored or legacy idle receipt');
          const idle=idleJson===undefined?undefined:parseIdleReceipt(idleJson);
          if(scored||idle){
            result=s.tx(()=>{
              check(!control.activeStop(s,[s.requireActor()],str('stop-file')),'STOP requested; wake receipt not saved',4);
              return saveNotificationProgress(s,{cursor,expected_version,scored,idle});
            });
          }else{
            check(str('stop-file')===undefined,'--stop-file requires a wake receipt');
            result=saveNotificationProgress(s,{cursor,expected_version});
          }
          break;
        }
        case 'status': empty();result=a.status(s);break;
        case 'job run': {check(!(bool('wait')&&bool('no-wait')),'Choose --wait or --no-wait');process.exitCode=await jobs.runJob(s,{kind:need('kind'),wait:!bool('no-wait'),command:p.splice(0),estimate:{version:str('job-version'),load:str('load') as jobs.Estimate['load'],mem:num('mem')}});return;}
        case 'job list': empty();result=jobs.listJobs(s);break;
        case 'job stats': empty();result=jobs.jobStats(s);break;
        case 'search': result=a.search(s,rest('query'),{type:str('type'),role:str('owner'),status:str('status'),since:str('since'),limit:num('limit'),phrase:bool('phrase'),prefix:bool('prefix')});break;
        case 'import': empty();{const input={backlog:str('backlog'),wip:str('wip'),actions:str('actions'),sessions:str('sessions'),repair:bool('repair')};check(bool('dry-run')!==!!str('confirm'),'Use --dry-run to preview or --confirm DIGEST to apply');result=bool('dry-run')?m.previewImport(s,input):m.applyImport(s,input,need('confirm'));}break;
        case 'export': {const path=arg('new directory');empty();result=m.exportMarkdown(s,path);break;}
        case 'launch': {
          if(bool('watched')){
            check(!bool('fresh')&&!str('terminal')&&!bool('new-window')&&!str('window'),'--watched resumes each role in its own Windows Terminal tab; drop --fresh, --terminal, --window and --new-window');
            result=await lw.launchWatched(s,p.splice(0),{all:bool('all'),closeStale:bool('close-stale'),dryRun:bool('dry-run'),distro:str('distro')});break;
          }
          check(!bool('close-stale'),'--close-stale applies to --watched only');
          jsonLaunch();result=await l.launch(s,p.splice(0),launchOptions);break;
        }
        case 'watch-roles': result=await lw.watchRoles(s,p.splice(0));break;
        case 'launch-watch': {
          const role=arg('role');empty();
          result=await launchWatch(s,role,need('remote'),need('session-id'));
          break;
        }
        case 'watch-status': {const role=arg('role');empty();result=watchStatus(s,role);break;}
        case 'watch-close': {
          const role=arg('role');empty();result=reconcileWatch(s,role,integer(need('epoch'),'epoch',1));break;
        }
        case 'launch-unlock': result=l.unlockLaunch(s,p.splice(0));break;
        case 'doctor': empty();result=a.doctor(s);if(!(result as Row).ok)process.exitCode=1;break;
        case 'backup': {const path=arg('backup destination');empty();result=await a.backupDatabase(s,path);break;}
      }
    }
    console.log(bool('json')?JSON.stringify(result):command==='context'?c.renderContext(result as c.ContextData):command==='status'?a.renderStatus(result as Row,num('line-length')):humanOutput(result,command));
  } catch(error) {
    const code=error instanceof AppError?error.code:typeof (error as NodeJS.ErrnoException)?.code==='string'&&(error as NodeJS.ErrnoException).code!.startsWith('ERR_PARSE_ARGS')?2:1;
    const message=error instanceof Error?error.message:'Unexpected failure';
    console.error(wantsJson?JSON.stringify({error:message,code}):`sassato: ${message}`);process.exitCode=code;
  } finally {store?.close();}
}
