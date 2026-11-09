import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Store, type Row } from './storage.js';
import { check, now, safe, text } from './errors.js';
import { humanRole } from './humans.js';
import { workspaceSettings, validateTimezone } from './workspace-settings.js';
import { legacyHuman, legacyRoleAliases, legacyTimezoneAliases } from './legacy.js';

export interface ImportOptions { backlog?: string; wip?: string; actions?: string; sessions?: string; repair?: boolean }
interface Source { path: string; kind: 'backlog' | 'wip' | 'action' | 'sessions'; digest: string; raw: string }
interface Item {
  source: string; line: number; sourceKey: string; digest: string; kind: 'task' | 'session' | 'wip';
  title: string; body: string; owner: string | null; status: 'open' | 'blocked' | 'done' | 'dropped';
  humanOnly: boolean; warnings: string[]; decision: 'create' | 'skip' | 'conflict' | 'repair';
  pendingQuestion?: boolean; answerEvidence?: {line:number;excerpt:string}; externalId?: string; provider?: string;
  taskId?: string; sourceUpdatedAt?: string; stateDigest?: string; before?: Row; after?: Row;
}
export interface ImportPreview { digest: string; files: {path:string; kind:string; digest:string; bytes:number}[]; items: Item[]; warnings: string[]; summary: {create:number;skip:number;conflict:number;reconcile:number;repair:number} }
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const title = (body: string): string => body.replace(/^#+\s*/,'').split('\n')[0].slice(0,180);
const terminal = (status: string): boolean => status==='done'||status==='dropped';
function load(options: ImportOptions): Source[] {
  const sources: Source[] = [];
  function add(path: string, kind: Source['kind']): void {
    const absolute = realpathSync(resolve(path)); safe(absolute);
    check(statSync(absolute).isFile(), `Not a regular file: ${absolute}`);
    check(statSync(absolute).size <= 10_000_000, `Import file exceeds 10 MB: ${absolute}`);
    const raw = readFileSync(absolute, 'utf8'); safe(raw);
    check(!raw.includes('\0'), `NUL in import file: ${absolute}`);
    sources.push({ path: absolute, kind, raw, digest: hash(raw) });
  }
  if (options.backlog) add(options.backlog,'backlog');
  if (options.wip) add(options.wip,'wip');
  if (options.sessions) add(options.sessions,'sessions');
  if (options.actions) for (const entry of readdirSync(realpathSync(resolve(options.actions)),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.md')) add(join(options.actions,entry.name),'action');
  }
  check(sources.length, 'Specify --backlog, --wip, --actions, or --sessions');
  check(new Set(sources.map(s=>s.path)).size===sources.length, 'A source file was selected more than once');
  return sources;
}
function completion(body: string): Item['status'] | undefined {
  const first=body.split('\n')[0].trim(),plain=first.replace(/^[\s#>*_~`]+/,'');
  const annotation=/^\(\s*[*_~`]*(done|closed|moved|built|completed|dropped|cancelled|canceled)\b/i.exec(plain);
  const explicit=/^(done|closed|moved|built|completed|dropped|cancelled|canceled)(?:[*_~`]+)?(?:\s*[:,;]|\s+\d{4}-\d{2}-\d{2}|\s*$)/i.exec(plain);
  const state=(annotation??explicit)?.[1].toLowerCase();
  if(state) return /^(dropped|cancelled|canceled)$/.test(state)?'dropped':'done';
  // Old records also append a terminal annotation after the title. Only accept a complete
  // final parenthesis group, not a mention such as "core (done), adapter still waiting".
  for(const match of first.matchAll(/\(\s*(?:\*\*|__)?(done|closed|moved|built|completed|dropped|cancelled|canceled)\b/gi)) {
    let depth=0,end=-1;
    for(let i=match.index!;i<first.length;i++){if(first[i]==='(')depth++;else if(first[i]===')'&&--depth===0){end=i;break;}}
    if(end>=0&&/^[\s*_~`]*$/.test(first.slice(end+1))) return /^(dropped|cancelled|canceled)$/i.test(match[1])?'dropped':'done';
  }
  return undefined;
}
function answeredAction(raw: string, humanNames: string[]): Item['answerEvidence'] {
  const lines=raw.split(/\r?\n/);
  const person='(?:'+humanNames.join('|')+')';
  const normalize=(value:string):string=>value.trim().replace(/^(?:[-*]\s+)?(?:#{1,6}\s+)?/,'').replace(/[*_~`]/g,'').trim();
  const substantive=(value:string):boolean=>!!value&&!/^(?:[-*]\s*)?(?:tbd|todo|pending|not yet|not answered|unanswered|awaiting|please (?:answer|decide)|write (?:your|the) answer|<[^>]*>|\[(?:(?:your\s+)?answer|yes.no|pending|todo|tbd)[^\]]*\])(?:\b|$)/i.test(value)&&!/^[-—.\s]+$/.test(value);
  for(let i=0;i<lines.length;i++) {
    const line=normalize(lines[i]);
    if(!new RegExp(`^(?:Answered\\b|Answer\\s*:|Decision\\s*:|${person}(?:['’]s\\s+answers?\\b|\\s+answered\\b|\\s*:\\s*|\\s*[,(]\\s*(?:\\d|["“'])|\\s+(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}:\\d|yesterday\\b|today\\b)))`,'i').test(line))continue;
    let evidence='';
    const direct=new RegExp(`^(?:Answer(?:ed)?|Decision|${person})\\s*:\\s*(.*)$`,'i').exec(line);
    if(direct)evidence=direct[1];
    else if(new RegExp(`^${person}\\s+answered\\b`,'i').test(line))evidence=line.replace(new RegExp(`^${person}\\s+answered\\s*`,'i'),'');
    else if(/:\s/.test(line))evidence=line.split(/:\s+/).at(-1)!.trim();
    if(!evidence) {
      const next=lines.slice(i+1).find(value=>value.trim());
      if(next&&!/^\s*#{1,6}\s/.test(next))evidence=normalize(next);
    }
    if(substantive(evidence))return {line:i+1,excerpt:lines[i].trim().slice(0,300)};
  }
  return undefined;
}
const dateLabel='(\\d{4}-\\d{2}-\\d{2})(?:[T\\s]+~?(\\d{1,2}):([x\\d]{2}))?(?:\\s*(UTC|Z|[+-]\\d{2}:\\d{2}|[A-Za-z_]+/[A-Za-z_/]+|'+Object.keys(legacyTimezoneAliases).join('|')+'))?';
function sourceTime(date:string,hours:string|undefined,minutes:string|undefined,zone:string|undefined,defaultZone:string):number|undefined {
  const hour=Number(hours??'0'),minute=Number((minutes??'00').replace(/x/gi,'9'));
  if(hour>23||minute>59)return undefined;
  let time=Date.parse(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`);
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date)return undefined;
  const selected=zone ? legacyTimezoneAliases[zone]??zone : defaultZone;
  const numeric=/^([+-])(\d{2}):(\d{2})$/.exec(selected);
  if(numeric) {
    if(Number(numeric[2])>23||Number(numeric[3])>59)return undefined;
    time-=(numeric[1]==='+'?1:-1)*(Number(numeric[2])*60+Number(numeric[3]))*60_000;
  } else if(!['UTC','Z'].includes(selected.toUpperCase())) {
    try {validateTimezone(selected);} catch {return undefined;}
    const zoneName=new Intl.DateTimeFormat('en',{timeZone:selected,timeZoneName:'shortOffset'}).formatToParts(new Date(time)).find(p=>p.type==='timeZoneName')?.value;
    const offset=/GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(zoneName??'');
    if(offset)time-=(offset[1]==='+'?1:-1)*(Number(offset[2])*60+Number(offset[3]??0))*60_000;
  }
  return time;
}
function wipStamp(line:string,roleLabel:string,timezone:string):{label:string;time:number}|undefined {
  const header=line.replace(/^\s*[-*]\s+/,'');
  // Match only the author in a dated header, never a role mentioned in the body
  // or a subagent whose name merely starts with an existing role.
  const first=new RegExp(`^${dateLabel}\\s+\\(${roleLabel}(?:,[^)]*)?\\)\\s*(?::|$)`,'i').exec(header);
  if(first){const time=sourceTime(first[1],first[2],first[3],first[4],timezone);if(time!==undefined)return {label:first[5],time};}
  const roleFirst=new RegExp(`^${roleLabel}\\s+(?:\\(\\s*)?${dateLabel}\\s*(?:\\)|:|$)`,'i').exec(header)
    ??new RegExp(`^\\(${roleLabel}\\s*,\\s*${dateLabel}\\s*(?:,|\\))`,'i').exec(header);
  if(roleFirst){const time=sourceTime(roleFirst[2],roleFirst[3],roleFirst[4],roleFirst[5],timezone);if(time!==undefined)return {label:roleFirst[1],time};}
  const stopped=new RegExp(`\\(stopped\\s*,?\\s*${dateLabel}\\s*\\)`,'i').exec(header);
  if(stopped) {
    const before=header.slice(0,stopped.index),after=header.slice(stopped.index+stopped[0].length);
    const label=new RegExp(`^${roleLabel}\\s*:?\\s*$`,'i').exec(before)?.[1]
      ??new RegExp(`^${dateLabel}\\s+\\(${roleLabel}(?:,[^)]*)?\\)\\s*:\\s*$`,'i').exec(before)?.[5]
      ??new RegExp(`^\\s*\\(?${roleLabel}\\s*(?:\\)|:|$)`,'i').exec(after)?.[1];
    const time=sourceTime(stopped[1],stopped[2],stopped[3],stopped[4],timezone);
    if(label&&time!==undefined)return {label,time};
  }
  return undefined;
}
function wipBlock(lines:string[],start:number,legacy=false):string {
  const parts=[lines[start]];let next=start+1;
  while(next<lines.length&&!(legacy?/^\s*[-*]\s|^#{1,6}\s/:/^[-*]\s|^#{1,6}\s/).test(lines[next]))parts.push(lines[next++]);
  return parts.join('\n').trim();
}
function parse(store: Store, sources: Source[]): {items:Item[]; warnings:string[]} {
  const items:Item[]=[],warnings:string[]=[];
  const roles=new Set(store.all('SELECT name FROM roles WHERE workspace_id=?',store.ws).map(r=>String(r.name)));
  const role=(value:string):string|null=>{const normalized=legacyRoleAliases[value.toLowerCase()]??value.toLowerCase();return roles.has(normalized)?normalized:null;};
  const labels=[...roles,...Object.keys(legacyRoleAliases).filter(alias=>roles.has(legacyRoleAliases[alias]))].sort((a,b)=>b.length-a.length).join('|');
  const roleLabel='(?:Opus\\s+|session\\s+)?('+labels+')';
  const humanNames=store.all("SELECT name FROM roles WHERE workspace_id=? AND kind='human'",store.ws).map(r=>String(r.name));
  const timezone=workspaceSettings(store).import_timezone;
  const add=(source:Source,line:number,key:string,body:string,owner:string|null,flags:string[]=[],kind:Item['kind']='task',externalId?:string):Item=>{
    const trimmed=body.trim(),finished=completion(trimmed),answerEvidence=source.kind==='action'?answeredAction(source.raw,humanNames):undefined;
    let status:Item['status']=finished??'open';
    if(kind==='task'&&!finished) {
      if(source.kind==='action') {status=answerEvidence?'open':'blocked';if(!answerEvidence)flags.push('Legacy human action: review the remaining decision in the preserved source');}
      else {
        if(/\b(?:done|merged|taken|waits?|waiting|moved|blocked|closed|superseded|after|hold)\b/i.test(trimmed))flags.push('Status or dependency needs reconciliation');
        if(!owner)flags.push('Owner is unknown or shared; reconcile before claiming');
        if(flags.length)status='blocked';
      }
    }
    const item:Item={source:source.path,line,sourceKey:`${source.path}#${key}`,digest:'',kind,title:title(trimmed)||basename(source.path),body:trimmed,owner,status,humanOnly:source.kind==='action',warnings:[...new Set(flags)],decision:'create',externalId,provider:kind==='session'?'claude':undefined};
    if(source.kind==='action'){item.pendingQuestion=status==='blocked'&&!answerEvidence;item.answerEvidence=answerEvidence;}
    items.push(item);return item;
  };
  for(const source of sources) {
    const lines=source.raw.split(/\r?\n/);
    if(source.kind==='wip') {
      const latest=new Map<string,{line:number;body:string;time:number}>();
      for(let i=0;i<lines.length;i++) {
        const stamp=wipStamp(lines[i],roleLabel,timezone);if(!stamp)continue;
        const owner=role(stamp.label);if(!owner){warnings.push(`${source.path}:${i+1}: dated entry has no recognized role; preserved only`);continue;}
        const previous=latest.get(owner);if(!previous||stamp.time>=previous.time)latest.set(owner,{line:i+1,body:wipBlock(lines,i),time:stamp.time});
      }
      for(const [owner,entry] of latest)add(source,entry.line,`wip/${owner}`,entry.body,owner,[],'wip').sourceUpdatedAt=new Date(entry.time).toISOString();
      warnings.push(`${source.path}: raw history preserved; only the newest dated entry per role is offered as WIP (undesignated times use ${timezone}; approximate minutes use their latest possible minute)`);
      continue;
    }
    if(source.kind==='action'){add(source,1,'action',source.raw,humanRole(store,undefined,'--as HUMAN'));continue;}
    if(source.kind==='sessions') {
      lines.forEach((line,i)=>{
        if(!line.trim())return;
        const match=/^\s*(claude|codex)\s+(?:--resume|resume)\s+([a-zA-Z0-9][a-zA-Z0-9._:-]{0,199})\s+#\s*(.*)$/i.exec(line);
        const label=match?.[3].match(new RegExp(`(?:^|[,;]\\s*)(?:session\\s+|role\\s+)?(${labels})(?=$|[\\s,(])`,'i'));
        const owner=label?role(label[1]):null;
        if(!match||!owner){warnings.push(`${source.path}:${i+1}: unrecognized session mapping preserved only`);return;}
        const item=add(source,i+1,`session/${owner}`,line,owner,[],'session',match[2]);item.provider=match[1].toLowerCase();
      });continue;
    }
    let section='',owner:string|null=null;const counts=new Map<string,number>();
    for(let i=0;i<lines.length;i++) {
      const heading=/^##\s+(.+)$/.exec(lines[i]);if(heading){section=heading[1];const m=new RegExp(`^(${labels})(?=$|[\\s(])`,'i').exec(section);owner=m?role(m[1]):null;continue;}
      const match=/^(\d+)\.\s+(.+)$/.exec(lines[i]);if(!match)continue;
      const start=i,parts=[match[2]];while(i+1<lines.length&&!/^#{1,6}\s|^\d+\.\s/.test(lines[i+1]))parts.push(lines[++i]);
      const key=`${section}/${match[1]}`,occurrence=(counts.get(key)??0)+1;counts.set(key,occurrence);
      add(source,start+1,`backlog/${key}/${occurrence}`,parts.join('\n'),owner);
    }
    for(const item of items.filter(i=>i.source===source.path)) {
      const key=item.sourceKey.replace(/^.*#backlog\//,'').replace(/\/\d+$/,'');
      if((counts.get(key)??0)>1){item.warnings.push('Duplicate legacy item number; reconcile identity');if(item.status==='open')item.status='blocked';}
    }
  }
  const identities=new Map<string,number>();for(const item of items)identities.set(item.sourceKey,(identities.get(item.sourceKey)??0)+1);
  for(const item of items) {
    // Keep the historical task digest shape when the interpretation itself has not changed.
    item.digest=hash(JSON.stringify({body:item.body,owner:item.owner,status:item.status,kind:item.kind,externalId:item.externalId,warnings:item.warnings}));
    if((identities.get(item.sourceKey)??0)>1){item.decision='conflict';item.warnings.push('Duplicate source identity; reconcile manually');}
  }
  return {items,warnings};
}
function metadata(task:Row,blockers:Row[],questions:Row[]):Row {
  return {task:{id:`T${task.id}`,status:task.status,version:task.version,completed_at:task.completed_at},blockers:blockers.map(b=>({id:`B${b.id}`,kind:b.kind,waiting_on:b.waiting_on,body:b.body,status:b.status})),questions:questions.map(q=>({id:`H${q.id}`,status:q.status,answer:q.answer}))};
}
function route(store:Store,item:Item):{kind:string;waiting_on:string} {
  const owner=item.owner?store.role(item.owner):undefined;
  return owner?{kind:owner.kind,waiting_on:owner.name}:{kind:'human',waiting_on:humanRole(store,undefined,'--as HUMAN')};
}
const blockerBody=(item:Item):string=>item.warnings.join('; ')||'Reconcile imported item';
const importedQuestion=(item:Item):string=>`Review this imported action and record the remaining decision. Existing answers are preserved in the task body.\n\n${item.title}`;
const existingAnswer=(item:Item):string=>`Import reconciliation: an existing answer is preserved at ${item.source}:${item.answerEvidence?.line??1}. ${item.answerEvidence?.excerpt??'See the original action record.'}`;
function planRepair(store:Store,item:Item,prior:Row):void {
  const task=prior.task_id?store.get('SELECT * FROM tasks WHERE workspace_id=? AND id=?',store.ws,prior.task_id):undefined;
  const refuse=(reason:string)=>{item.decision='conflict';item.warnings.push(reason);};
  if(!task){refuse('Imported task is missing; manual reconciliation required');return;}
  item.taskId=`T${task.id}`;
  const blockers=store.all('SELECT * FROM blockers WHERE workspace_id=? AND task_id=? ORDER BY id',store.ws,task.id),questions=store.all('SELECT * FROM questions WHERE workspace_id=? AND task_id=? ORDER BY id',store.ws,task.id);
  const events=store.all("SELECT * FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? ORDER BY id",store.ws,item.taskId);
  item.stateDigest=hash(JSON.stringify({prior,task,blockers,questions,events}));item.before=metadata(task,blockers,questions);
  const initial=events[0];let detail:Row;
  try{detail=JSON.parse(initial?.detail??'null');}catch{refuse('Import provenance is unreadable');return;}
  if(initial?.action!=='imported'||detail?.source_key!==item.sourceKey||events.some(e=>!['imported','import-repaired'].includes(e.action))||task.version!==events.length){refuse('Task changed after import; preserve user/agent work');return;}
  const sourceDigest=/\nSource digest: ([a-f0-9]{64})$/.exec(task.body)?.[1];
  const original=sourceDigest?store.get('SELECT raw FROM imports WHERE workspace_id=? AND path=? AND digest=?',store.ws,item.source,sourceDigest):undefined;
  const expectedBody=`${item.body}\n\nImported from ${item.source}:${detail.line}\nSource digest: ${sourceDigest}`;
  if(!original||task.body!==expectedBody||!String(original.raw).replace(/\r\n/g,'\n').includes(item.body)||task.title!==item.title||task.owner!==item.owner||task.human_only!==(item.humanOnly?1:0)||task.for_role!==(item.humanOnly?item.owner:null)||task.priority!==0||task.review_required||task.reviewed_by||task.review_note||task.lease_until){refuse('Source content or imported task fields changed; metadata repair will not overwrite them');return;}
  const repairs=events.filter(e=>e.action==='import-repaired');
  if(repairs.length) {
    const last=JSON.parse(repairs.at(-1)!.detail);
    if(JSON.stringify(last.after)!==JSON.stringify(item.before)){refuse('Imported metadata changed since its last repair');return;}
  } else {
    if(blockers.length>1||questions.length>1||blockers.some(b=>b.created_by!==task.creator||b.created_at!==task.created_at||b.status!=='open'||!((b.kind==='human'&&b.waiting_on===task.creator&&store.role(task.creator).kind==='human')||(b.kind===route(store,item).kind&&b.waiting_on===route(store,item).waiting_on))||b.body!==(detail.warnings?.join('; ')||'Reconcile imported item'))||questions.some(q=>!item.humanOnly||q.asked_by!==task.creator||q.created_at!==task.created_at||q.status!=='pending'||q.answer!==null||q.question!==importedQuestion(item)||q.options!=='[]'||q.recommendation!==null||q.command!==null)){refuse('Blockers or questions changed after import; preserve them');return;}
  }
  const target=route(store,item),after:Row=structuredClone(item.before);
  after.task.status=item.status;after.task.completed_at=terminal(item.status)?task.completed_at??task.created_at:null;
  for(const b of after.blockers) {
    if(item.status==='blocked'){Object.assign(b,target,{body:blockerBody(item),status:'open'});}else if(b.status==='open')b.status='resolved';
  }
  if(item.status==='blocked'&&!after.blockers.length)after.blockers.push({id:null,...target,body:blockerBody(item),status:'open'});
  for(const q of after.questions)if(!item.pendingQuestion&&q.status==='pending'){q.status='answered';q.answer=existingAnswer(item);}
  if(item.pendingQuestion&&!after.questions.length)after.questions.push({id:null,status:'pending',answer:null});
  if(prior.digest===item.digest&&JSON.stringify(after)===JSON.stringify(item.before)){item.decision='skip';return;}
  after.task.version=task.version+1;item.after=after;item.decision='repair';
}
const wipNotes=(source:string,line:number,legacy=false):string=>`Imported newest ${legacy?'stopped':'dated'} entry from ${source}:${line}. Source history remains in the import record.`;
const wipMetadata=(row:Row):Row=>({wip:{role:row.role,current:row.current,next:row.next,notes:row.notes,version:row.version,updated_at:row.updated_at}});
function planWipRepair(store:Store,item:Item,prior:Row,existing:Row):void {
  const events=store.all("SELECT * FROM events WHERE workspace_id=? AND entity='wip' AND entity_id=? ORDER BY id",store.ws,item.owner!);
  item.stateDigest=hash(JSON.stringify({prior,existing,events}));item.before=wipMetadata(existing);
  const refuse=(reason:string)=>{item.decision='conflict';item.warnings.push(reason);};
  const desired={role:item.owner,current:item.body,next:'',notes:wipNotes(item.source,item.line),version:existing.version,updated_at:item.sourceUpdatedAt};
  // A repeated repair is a no-op, including the version-2 snapshot created by a prior repair.
  // This does not authorize replacing any subsequent manual update.
  if(prior.digest===item.digest&&JSON.stringify(item.before.wip)===JSON.stringify(desired)){item.decision='skip';return;}
  let detail:Row;try{detail=JSON.parse(events[0]?.detail??'null');}catch{refuse('WIP import provenance is unreadable');return;}
  if(existing.version!==1||events.length!==1||events[0].action!=='imported'||detail?.source_key!==item.sourceKey||detail.source!==item.source||!Number.isSafeInteger(detail.line)||detail.line<1||prior.task_id!==null){refuse('WIP changed after import or lacks exact import provenance; preserve user/agent work');return;}
  const originalNotes=wipNotes(item.source,detail.line,detail.after===undefined);
  const originalDigest=hash(JSON.stringify({body:existing.current,owner:item.owner,status:'open',kind:'wip',warnings:[]}));
  if(existing.next!==''||existing.notes!==originalNotes||prior.digest!==originalDigest||(detail.after&&JSON.stringify(detail.after)!==JSON.stringify(item.before))){refuse('WIP fields changed after import; preserve user/agent work');return;}
  const records=store.all('SELECT digest,raw FROM imports WHERE workspace_id=? AND path=? ORDER BY id',store.ws,item.source);
  const original=records.find(record=>{
    if(detail.source_digest&&record.digest!==detail.source_digest)return false;
    const lines=String(record.raw).split(/\r?\n/),start=detail.line-1;
    return hash(record.raw)===record.digest&&start<lines.length&&wipBlock(lines,start,detail.after===undefined)===existing.current;
  });
  if(!original){refuse('Original WIP source record does not match; reconcile manually');return;}
  item.stateDigest=hash(JSON.stringify({prior,existing,events,source_digest:original.digest}));
  item.after={wip:{...desired,version:existing.version+1}};item.decision='repair';
}
function preview(store:Store,sources:Source[],options:ImportOptions):ImportPreview {
  const {items,warnings}=parse(store,sources);
  for(const item of items) {
    if(item.decision==='conflict')continue;
    const prior=store.get('SELECT * FROM import_items WHERE workspace_id=? AND source_key=?',store.ws,item.sourceKey);
    item.decision=prior?prior.digest===item.digest?'skip':'conflict':'create';
    if(item.kind==='wip') {
      const existing=store.get('SELECT * FROM wip WHERE workspace_id=? AND role=?',store.ws,item.owner!);
      item.stateDigest=hash(JSON.stringify({prior,existing}));
      if(options.repair&&prior&&existing)planWipRepair(store,item,prior,existing);
      else if(existing&&!(prior?.digest===item.digest)){item.decision='conflict';item.warnings.push('WIP already exists; it will not be overwritten');}
      if(prior&&!existing){item.decision='conflict';item.warnings.push('Previously imported WIP is missing; reconcile manually');}
      if(item.body.length>10_000){item.decision='conflict';item.warnings.push('Dated entry exceeds 10000 characters; preserve raw source and reconcile manually');}
    }else if(item.kind==='session') {
      if(item.decision==='create'&&store.get('SELECT id FROM sessions WHERE workspace_id=? AND role=? LIMIT 1',store.ws,item.owner!)){item.decision='conflict';item.warnings.push('A runtime session already exists; legacy mapping will not replace it');}
    }else if(options.repair&&prior)planRepair(store,item,prior);
  }
  const fingerprint={format:2,workspace:store.workspace,repair:!!options.repair,sources:sources.map(s=>({path:s.path,kind:s.kind,digest:s.digest})),items:items.map(i=>({key:i.sourceKey,digest:i.digest,...(i.sourceUpdatedAt?{source_updated_at:i.sourceUpdatedAt}:{}),...(i.kind==='task'&&i.status==='blocked'?{routing:route(store,i)}:{}),...(options.repair?{decision:i.decision,state:i.stateDigest,before:i.before,after:i.after}:{})}))};
  return {digest:hash(JSON.stringify(fingerprint)),files:sources.map(s=>({path:s.path,kind:s.kind,digest:s.digest,bytes:Buffer.byteLength(s.raw)})),items,warnings,summary:{create:items.filter(i=>i.decision==='create').length,skip:items.filter(i=>i.decision==='skip').length,conflict:items.filter(i=>i.decision==='conflict').length,reconcile:items.filter(i=>i.status==='blocked').length,repair:items.filter(i=>i.decision==='repair').length}};
}
export function previewImport(store:Store,options:ImportOptions):ImportPreview{return store.snapshot(()=>preview(store,load(options),options));}
function indexTask(store:Store,task:Row):void{store.index('task',`T${task.id}`,task.title,task.body,{role:task.owner,status:task.status});}
function addBlocker(store:Store,taskId:number,item:Item,actor:string,at:string):number {
  const target=route(store,item),body=blockerBody(item);
  const n=store.run('INSERT INTO blockers(workspace_id,task_id,kind,waiting_on,body,created_by,created_at) VALUES(?,?,?,?,?,?,?)',store.ws,taskId,target.kind,target.waiting_on,body,actor,at).lastInsertRowid;
  store.index('blocker',`B${n}`,item.title,body,{role:target.waiting_on,status:'open'});return n;
}
function addQuestion(store:Store,taskId:number,blockerId:number,item:Item,actor:string,at:string):number {
  const n=store.run('INSERT INTO questions(workspace_id,task_id,blocker_id,asked_by,question,created_at) VALUES(?,?,?,?,?,?)',store.ws,taskId,blockerId,actor,importedQuestion(item),at).lastInsertRowid;
  store.index('question',`H${n}`,item.title,item.body,{role:route(store,item).waiting_on,status:'pending'});return n;
}
function repairItem(store:Store,item:Item,actor:string,at:string):void {
  const taskId=Number(item.taskId!.slice(1)),after=item.after!;
  store.run('UPDATE tasks SET status=?,completed_at=?,version=?,updated_at=? WHERE workspace_id=? AND id=?',after.task.status,after.task.completed_at,after.task.version,at,store.ws,taskId);
  let blockerId:number|undefined;
  for(const b of after.blockers) {
    if(!b.id){blockerId=addBlocker(store,taskId,item,actor,at);continue;}
    blockerId=Number(b.id.slice(1));
    store.run('UPDATE blockers SET kind=?,waiting_on=?,body=?,status=?,resolved_at=? WHERE workspace_id=? AND id=?',b.kind,b.waiting_on,b.body,b.status,b.status==='resolved'?at:null,store.ws,blockerId);
    store.index('blocker',b.id,item.title,b.body,{role:b.waiting_on,status:b.status});
  }
  for(const q of after.questions) {
    if(!q.id){addQuestion(store,taskId,blockerId!,item,actor,at);continue;}
    const existing=store.get('SELECT * FROM questions WHERE workspace_id=? AND id=?',store.ws,Number(q.id.slice(1)))!;
    if(existing.status!==q.status){
      store.run('UPDATE questions SET status=?,answer=?,answered_by=?,answered_at=? WHERE workspace_id=? AND id=?',q.status,q.answer,actor,at,store.ws,existing.id);
      store.event('question',q.id,'import-repaired',{task:item.taskId,source:item.source,answer:q.answer});
    }
    store.index('question',q.id,item.title,`${item.body}\n${q.answer??''}`,{role:store.get('SELECT waiting_on FROM blockers WHERE workspace_id=? AND id=?',store.ws,existing.blocker_id)!.waiting_on,status:q.status});
  }
  store.run('UPDATE import_items SET digest=? WHERE workspace_id=? AND source_key=?',item.digest,store.ws,item.sourceKey);
  const task=store.task(item.taskId!);indexTask(store,task);
  const blockers=store.all('SELECT * FROM blockers WHERE workspace_id=? AND task_id=? ORDER BY id',store.ws,taskId),questions=store.all('SELECT * FROM questions WHERE workspace_id=? AND task_id=? ORDER BY id',store.ws,taskId);
  store.event('task',item.taskId!,'import-repaired',{source:item.source,line:item.line,source_key:item.sourceKey,before:item.before,after:metadata(task,blockers,questions)});
}
export function applyImport(store:Store,options:ImportOptions,confirmDigest:string):ImportPreview&{created:string[];repaired:string[];importedWip:string[];repairedWip:string[]} {
  const sources=load(options);
  return store.tx(()=>{
    const actor=store.requireHuman(),plan=preview(store,sources,options);
    check(confirmDigest===plan.digest,'Import preview changed or confirmation missing; run --dry-run and pass its digest to --confirm',4);
    const created:string[]=[],repaired:string[]=[],importedWip:string[]=[],repairedWip:string[]=[],at=now();
    for(const source of sources) {
      const record=store.run('INSERT OR IGNORE INTO imports(workspace_id,path,digest,raw,created_at) VALUES(?,?,?,?,?)',store.ws,source.path,source.digest,source.raw,at);
      if(record.changes){store.index('import',`I${record.lastInsertRowid}`,basename(source.path),source.raw);store.event('import',`I${record.lastInsertRowid}`,'preserved',{path:source.path,digest:source.digest});}
    }
    for(const item of plan.items) {
      if(item.decision==='repair'){
        if(item.kind==='wip') {
          const wip=item.after!.wip;
          const changed=store.run('UPDATE wip SET current=?,next=?,notes=?,version=?,updated_at=? WHERE workspace_id=? AND role=? AND version=?',wip.current,wip.next,wip.notes,wip.version,wip.updated_at,store.ws,item.owner!,item.before!.wip.version);
          check(changed.changes===1,'WIP changed since import preview',4);
          store.run('UPDATE import_items SET digest=? WHERE workspace_id=? AND source_key=?',item.digest,store.ws,item.sourceKey);
          store.index('wip',item.owner!,`${item.owner} WIP`,`${wip.current}\n${wip.notes}`,{role:item.owner});
          store.event('wip',item.owner!,'import-repaired',{source:item.source,line:item.line,source_key:item.sourceKey,source_digest:sources.find(s=>s.path===item.source)!.digest,source_updated_at:item.sourceUpdatedAt,before:item.before,after:item.after});
          repairedWip.push(item.owner!);
        }else{repairItem(store,item,actor,at);repaired.push(item.taskId!);}
        continue;
      }
      if(item.decision!=='create')continue;
      if(item.kind==='session') {
        store.run('INSERT INTO sessions(workspace_id,role,provider,external_id,started_at,last_seen_at,ended_at) VALUES(?,?,?,?,?,?,?)',store.ws,item.owner!,item.provider!,item.externalId!,at,at,at);
        store.run('INSERT INTO import_items(workspace_id,source_key,digest) VALUES(?,?,?)',store.ws,item.sourceKey,item.digest);
        store.event('session',item.owner!,'imported-resume-hint',{source:item.source,line:item.line,external_id:item.externalId});continue;
      }
      if(item.kind==='wip') {
        const notes=wipNotes(item.source,item.line);
        store.run('INSERT INTO wip(workspace_id,role,current,next,notes,updated_at) VALUES(?,?,?,?,?,?)',store.ws,item.owner!,item.body,'',notes,item.sourceUpdatedAt!);
        store.run('INSERT INTO import_items(workspace_id,source_key,digest) VALUES(?,?,?)',store.ws,item.sourceKey,item.digest);
        store.index('wip',item.owner!,`${item.owner} WIP`,`${item.body}\n${notes}`,{role:item.owner});
        store.event('wip',item.owner!,'imported',{source:item.source,line:item.line,source_key:item.sourceKey,source_digest:sources.find(s=>s.path===item.source)!.digest,source_updated_at:item.sourceUpdatedAt,after:wipMetadata(store.get('SELECT * FROM wip WHERE workspace_id=? AND role=?',store.ws,item.owner!)!)});importedWip.push(item.owner!);continue;
      }
      const body=`${item.body}\n\nImported from ${item.source}:${item.line}\nSource digest: ${sources.find(s=>s.path===item.source)!.digest}`;
      const n=store.run('INSERT INTO tasks(workspace_id,title,body,owner,status,human_only,for_role,creator,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',store.ws,item.title,body,item.owner,item.status,item.humanOnly?1:0,item.humanOnly?item.owner:null,actor,at,at,terminal(item.status)?at:null).lastInsertRowid;
      const task=`T${n}`;created.push(task);
      store.run('INSERT INTO import_items(workspace_id,source_key,digest,task_id) VALUES(?,?,?,?)',store.ws,item.sourceKey,item.digest,n);
      indexTask(store,store.task(task));store.event('task',task,'imported',{source:item.source,line:item.line,source_key:item.sourceKey,warnings:item.warnings});
      if(item.status==='blocked'){const blocker=addBlocker(store,n,item,actor,at);if(item.pendingQuestion)addQuestion(store,n,blocker,item,actor,at);}
    }
    return {...plan,created,repaired,importedWip,repairedWip};
  });
}
function markdownTask(t: Row): string { return `### T${t.id}: ${t.title}\n\nOwner: ${t.owner??'unassigned'} · Status: ${t.status}${t.human_only?' · Human only':''}\n\n${t.body}\n`; }
export function exportMarkdown(store: Store, outDirectory: string): {directory:string; files:string[]} {
  const directory=resolve(text(outDirectory,'output directory'));
  check(!existsSync(directory),'Export destination must be a new directory; existing files are never overwritten',4);
  const documents=store.snapshot(()=>{
    const tasks=store.all('SELECT * FROM tasks WHERE workspace_id=? ORDER BY owner,priority DESC,id',store.ws);
    const events=store.all("SELECT * FROM events WHERE workspace_id=? AND entity='task' ORDER BY id",store.ws);
    const questions=store.all('SELECT q.*,b.waiting_on AS for_role FROM questions q JOIN blockers b ON b.workspace_id=q.workspace_id AND b.id=q.blocker_id WHERE q.workspace_id=? ORDER BY q.id',store.ws);
    const wip=store.all('SELECT * FROM wip WHERE workspace_id=? ORDER BY role',store.ws);
    const out:Record<string,string>={
      'backlog.md':`# ${store.workspace}: backlog\n\nExported ${now()}. These are snapshots; edit through Sassato.\n\n`+tasks.filter(t=>!['done','dropped'].includes(t.status)).map(markdownTask).join('\n'),
      'wip.md':`# ${store.workspace}: work in progress\n\n`+tasks.filter(t=>['doing','blocked','review'].includes(t.status)).map(markdownTask).join('\n')+'\n'+wip.map(w=>`## ${w.role}\n\nCurrent: ${w.current}\n\nNext: ${w.next}\n\n${w.notes}\n`).join('\n'),
      'humans.md':`# ${store.workspace}: human decisions\n\n`+questions.filter(q=>q.status==='pending').map(q=>`## H${q.id} · T${q.task_id}\n\nFor: ${q.for_role}\n\n${q.question}\n\nOptions: ${q.options}\n\nRecommendation: ${q.recommendation??'none'}\n\nCommand (reference only):\n\n\`\`\`text\n${q.command??'none'}\n\`\`\`\n`).join('\n'),
    };
    if(store.get("SELECT name FROM roles WHERE workspace_id=? AND name=? AND kind='human'",store.ws,legacyHuman))out[`${legacyHuman}.md`]=out['humans.md'];
    const eventsByTask=new Map<string,Row[]>(), questionsByTask=new Map<number,Row[]>();
    for(const event of events) {const group=eventsByTask.get(event.entity_id)??[];group.push(event);eventsByTask.set(event.entity_id,group);}
    for(const question of questions) {const group=questionsByTask.get(question.task_id)??[];group.push(question);questionsByTask.set(question.task_id,group);}
    for(const t of tasks) {
      const history=(eventsByTask.get(`T${t.id}`)??[]).map(e=>`- ${e.created_at} · ${e.actor} · ${e.action}: ${e.detail}`).join('\n');
      const answers=(questionsByTask.get(t.id)??[]).map(q=>`### H${q.id}: ${q.status}\n\n${q.question}\n\nAnswer (${q.answered_at??'pending'}; ${q.answered_by??'—'}): ${q.answer??'—'}\n`).join('\n');
      out[`items/T${t.id}.md`]=markdownTask(t)+`\n## Decisions\n\n${answers}\n## History\n\n${history}\n`;
    }
    return out;
  });
  mkdirSync(directory,{mode:0o700}); mkdirSync(join(directory,'items'),{mode:0o700});
  for(const [file,body] of Object.entries(documents)) writeFileSync(join(directory,file),body,{flag:'wx',mode:0o600});
  return {directory,files:Object.keys(documents)};
}
