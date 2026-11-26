import { type Store, type Row } from './storage.js';
import { check, name, text } from './errors.js';
import { WAKE_SPEEDS, validateRoleWakePolicy, type RoleWakePolicy, type WakeMode, type WakeSpeed } from './wake-policy.js';
import { validateBusyChecks, type BusyCheck } from './busy-checks.js';

export interface WorkspaceSettings { default_human: string | null; import_timezone: string; stop_file: string | null; busy_checks:BusyCheck[]; import_answer_markers:string[]; import_role_aliases:Record<string,string>; import_timezone_aliases:Record<string,string>; open_work_roles:string[]|null; digest_skip:Record<string,string[]>; autocompact:Record<string,number>; advisor:Record<string,string>; wake_mode:WakeMode; speed:WakeSpeed; wake_roles:Record<string,RoleWakePolicy>; codex_versions:string[]; spare_work:boolean; spare_providers:string[]; feedback_closers:string[]; rule_relays:string[]; pull_repositories:Record<string,string>; nudge_minutes:number; nudge_escalate:string|null; nudge_off:string[] }
function standardTimezone(zone:string):boolean {
  try {new Intl.DateTimeFormat('en',{timeZone:zone});return true;} catch {return false;}
}
function aliases(value:unknown,label:string,validate:(key:string,target:string)=>void):Record<string,string> {
  check(value!==null&&typeof value==='object'&&!Array.isArray(value),`${label} must be an object`);
  const entries=Object.entries(value);check(entries.length<=32,`${label} must have at most 32 entries`);
  const seen=new Set<string>();
  return Object.fromEntries(entries.map(([key,value])=>{
    check(!/[\u0000-\u001f\u007f]/.test(key),`${label} keys must be single-line labels without control characters`);
    const alias=text(key,label+' key',100).trim().toLowerCase(),target=text(value,label+' target',100);
    check(!seen.has(alias),`${label} contains duplicate aliases`);seen.add(alias);validate(alias,target);return [alias,target];
  }));
}
export function validateTimezone(value: unknown): string {
  const zone = text(value,'import time zone',100);
  try {new Intl.DateTimeFormat('en',{timeZone:zone});} catch {check(false,'Use an IANA import time zone such as UTC or America/New_York');}
  return zone;
}
export function validateSettings(s: Store, input: Row): WorkspaceSettings {
  const wakeMode=input.wake_mode??'legacy',speed=input.speed??'normal',wakeRoles=input.wake_roles??{};
  check(wakeMode==='legacy'||wakeMode==='scored','Wake mode must be legacy or scored');
  check(WAKE_SPEEDS.some(profile=>profile===speed),'Workspace speed must be slow, normal or fast');
  check(wakeRoles&&typeof wakeRoles==='object'&&!Array.isArray(wakeRoles)&&Object.keys(wakeRoles).length<=64,'wake_roles must map up to 64 role names to settings');
  const wake_roles=Object.fromEntries(Object.entries(wakeRoles).map(([role,value])=>{
    s.role(name(role));return [role,validateRoleWakePolicy(value)];
  }));
  const human = input.default_human ?? null;
  if (human !== null) check(s.role(name(human)).kind === 'human','Default decision recipient must be a human role',3);
  const markers=input.import_answer_markers??[];
  check(Array.isArray(markers)&&markers.length<=32,'import_answer_markers must be an array of at most 32 strings');
  const roleAliases=aliases(input.import_role_aliases??{},'import_role_aliases',(key,target)=>{
    s.role(name(target));
    check(!s.get('SELECT 1 FROM roles WHERE workspace_id=? AND name=? AND name!=?',s.ws,key,target),'An import alias cannot override another configured role');
  });
  const timezoneAliases=aliases(input.import_timezone_aliases??{},'import_timezone_aliases',(key,target)=>{
    check(/^[a-z][a-z _-]*$/.test(key)&&key!=='z'&&!standardTimezone(key),'Time zone aliases must be labels, not standard zones or offsets');validateTimezone(target);
  });
  const openWork=input.open_work_roles??null;
  if(openWork!==null) {
    check(Array.isArray(openWork)&&openWork.length<=64,'open_work_roles must be null or an array of at most 64 role names');
    for(const role of openWork)s.role(name(role));
  }
  // digest_skip (T977): per role, the digest entry kinds that role never acts on; they do not wake it.
  const skip=input.digest_skip??{};
  check(skip&&typeof skip==='object'&&!Array.isArray(skip)&&Object.keys(skip).length<=64,'digest_skip must be an object of role names to arrays of entry kinds');
  for(const [role,kinds] of Object.entries(skip)) {
    s.role(name(role));
    check(Array.isArray(kinds)&&kinds.length<=32&&kinds.every(k=>typeof k==='string'&&DIGEST_SKIPPABLE.includes(k)),`digest_skip.${role} must list kinds among: ${DIGEST_SKIPPABLE.join(', ')}`);
  }
  // autocompact (T980): per Claude role, the auto-compact window launch passes as --autocompact; unset means
  // Claude Code's own default. Set by a human (role set ROLE --autocompact N|auto).
  const compact=input.autocompact??{};
  check(compact&&typeof compact==='object'&&!Array.isArray(compact)&&Object.keys(compact).length<=64,'autocompact must be an object of role names to token counts');
  // An entry for a role that is no longer a Claude role (or no longer exists) is dropped, never a reason to
  // refuse an unrelated settings change; setRoleAutocompact refuses setting one for a non-Claude role.
  const claude=new Set(s.all("SELECT name FROM roles WHERE workspace_id=? AND provider='claude'",s.ws).map(r=>String(r.name)));
  const kept:Record<string,number>={};
  for(const [role,tokens] of Object.entries(compact)) {
    if(!claude.has(role))continue;
    check(validCompact(tokens),`autocompact.${role} must be a whole number of tokens from 100000 to 10000000`);
    kept[role]=tokens as number;
  }
  // advisor (T1224): per Claude role, the advisor model launch passes as --advisor; unset means none. A human
  // sets it (role set ROLE --advisor MODEL|off). Entries for roles that are not Claude roles are dropped.
  const advice=input.advisor??{};
  check(advice&&typeof advice==='object'&&!Array.isArray(advice)&&Object.keys(advice).length<=64,'advisor must be an object of role names to model names');
  const advisor:Record<string,string>={};
  for(const [role,model] of Object.entries(advice)) {
    if(!claude.has(role))continue;
    check(validAdvisor(model),`advisor.${role} must be a model name such as opus or claude-opus-5-5`);
    advisor[role]=model as string;
  }
  // codex_versions (T1098): the Codex CLI versions a human has marked tested; a record only since T1193.
  const codex=input.codex_versions??DEFAULT_CODEX_VERSIONS;
  check(Array.isArray(codex)&&codex.length>=1&&codex.length<=16&&codex.every(v=>typeof v==='string'&&CODEX_VERSION.test(v)),'codex_versions must list 1 to 16 exact versions such as 0.167.0');
  // Spare tasks (T1102): offered to an idle role when spare_work is on, only to providers in spare_providers (empty: any).
  const spareWork=input.spare_work??true,spareProviders=input.spare_providers??[];
  check(typeof spareWork==='boolean','spare_work must be true or false');
  check(Array.isArray(spareProviders)&&spareProviders.length<=8&&spareProviders.every(p=>typeof p==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(p)),'spare_providers must list at most 8 provider names such as codex');
  // feedback_closers (T1113): the roles besides humans that close feedback; set by a human.
  const closers=input.feedback_closers??[];
  check(Array.isArray(closers)&&closers.length<=16,'feedback_closers must list at most 16 role names');
  for(const role of closers)s.role(name(role));
  // rule_relays (T1276): the roles that relay a human's answer to a rule proposal; any other relay is refused.
  const relays=input.rule_relays??[];
  check(Array.isArray(relays)&&relays.length<=8,'rule_relays must list at most 8 role names');
  for(const role of relays)check(s.role(name(role)).kind!=='human','rule_relays lists the agent roles that relay a human\'s answer, not humans');
  // pull_repositories: short names for the repositories whose pull requests task text names; set by a human.
  const repositories=input.pull_repositories??{};
  check(repositories!==null&&typeof repositories==='object'&&!Array.isArray(repositories)&&Object.keys(repositories).length<=16,'pull_repositories must map at most 16 short names to owner/repo');
  for(const [short,repo] of Object.entries(repositories))check(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(short)&&typeof repo==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(repo),'pull_repositories must map short names to owner/repo');
  // nudge_minutes (T1253): a role that has written nothing for this long is asked why, apart from the waiter's
  // --idle-minutes; 0 turns it off. nudge_escalate: the role told when two nudges go unanswered (null: nobody).
  const nudge=input.nudge_minutes??DEFAULT_NUDGE_MINUTES,escalate=input.nudge_escalate??null;
  check(Number.isSafeInteger(nudge)&&nudge>=0&&nudge<=1440,'nudge_minutes must be a whole number of minutes from 0 (off) to 1440');
  if(escalate!==null)s.role(name(escalate));
  // nudge_off (T1539): roles never nudged, such as a role on demand for a human; a human sets it (role set ROLE
  // --nudge off). An entry for a role that no longer exists is dropped.
  const off=input.nudge_off??[];
  check(Array.isArray(off)&&off.length<=64&&off.every(r=>typeof r==='string'),'nudge_off must list at most 64 role names');
  const roleNames=new Set(s.all('SELECT name FROM roles WHERE workspace_id=?',s.ws).map(r=>String(r.name)));
  return {pull_repositories:{...repositories},nudge_minutes:nudge,nudge_escalate:escalate,nudge_off:[...new Set((off as string[]).filter(r=>roleNames.has(r)))],feedback_closers:[...new Set(closers as string[])],rule_relays:[...new Set(relays as string[])],spare_work:spareWork,spare_providers:[...new Set(spareProviders as string[])],codex_versions:[...new Set(codex as string[])],wake_mode:wakeMode,speed,wake_roles,autocompact:kept,advisor,digest_skip:Object.fromEntries(Object.entries(skip).map(([role,kinds])=>[role,[...new Set(kinds as string[])]])),open_work_roles:openWork===null?null:[...new Set((openWork as unknown[]).map(String))],default_human:human,import_timezone:validateTimezone(input.import_timezone ?? 'UTC'),stop_file:input.stop_file == null ? null : text(input.stop_file,'stop file',4096),busy_checks:validateBusyChecks(input.busy_checks??[]),import_answer_markers:markers.map(marker=>text(marker,'import answer marker',200)),import_role_aliases:roleAliases,import_timezone_aliases:timezoneAliases};
}
/** Digest entries a role may choose not to be woken by. Urgent mail, replies, answers, blockers, reviews and
 * stops are never skippable: they always need the role. */
// Never skippable either: task-ready and dependency-dropped, since both can concern the role's own work.
const validCompact=(tokens:unknown):boolean=>Number.isSafeInteger(tokens)&&(tokens as number)>=100_000&&(tokens as number)<=10_000_000;
/** A Claude role's auto-compact window (T980): a number of tokens, or 'auto' to clear it. A human sets it; the
 * map is read and written in one transaction, so changes for different roles never overwrite each other. */
export function setRoleAutocompact(s:Store,role:string,value:string):number|null {
  check(value==='auto'||/^[0-9]+$/.test(value),'--autocompact takes a number of tokens (at least 100000) or auto');
  const tokens=value==='auto'?null:Number(value);
  check(tokens===null||validCompact(tokens),'--autocompact must be a whole number of tokens from 100000 to 10000000');
  return s.tx(()=>{
    s.requireHuman();
    check(tokens===null||s.role(name(role)).provider==='claude',`autocompact is for Claude roles; ${role} is not one`);
    const compact={...(workspaceSettings(s).autocompact??{})};
    if(tokens===null)delete compact[role];else compact[role]=tokens;
    setWorkspaceSettings(s,{autocompact:compact});
    return tokens;
  });
}
/** Whether a role is nudged when quiet (T1539): on by default, off for a role a human exempts. */
export function setRoleNudge(s:Store,role:string,value:string):boolean {
  check(value==='on'||value==='off','--nudge takes on or off');
  return s.tx(()=>{
    s.requireHuman(); s.role(name(role));
    const off=new Set(workspaceSettings(s).nudge_off??[]);
    if(value==='off')off.add(role);else off.delete(role);
    setWorkspaceSettings(s,{nudge_off:[...off]});
    return value==='on';
  });
}
export const roleNudged=(settings:WorkspaceSettings,role:string):boolean=>!(settings.nudge_off??[]).includes(role);
/** A model name for --advisor: letters, digits and . _ : [ ] -, never starting with a dash (so never a flag). */
export const validAdvisor=(model:unknown):boolean=>typeof model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,199}$/.test(model);
/** A Claude role's advisor model (T1224): a model name, or 'off' to clear it. A human sets it. */
export function setRoleAdvisor(s:Store,role:string,value:string):string|null {
  check(value==='off'||validAdvisor(value),'--advisor takes a model name such as opus or claude-opus-5-5, or off');
  const model=value==='off'?null:value;
  return s.tx(()=>{
    s.requireHuman();
    check(model===null||s.role(name(role)).provider==='claude',`advisor is for Claude roles; ${role} is not one`);
    const advisor={...(workspaceSettings(s).advisor??{})};
    if(model===null)delete advisor[role];else advisor[role]=model;
    setWorkspaceSettings(s,{advisor});
    return model;
  });
}
export const roleAdvisor=(settings:WorkspaceSettings,role:string):string|null=>settings.advisor&&Object.hasOwn(settings.advisor,role)?settings.advisor[role]:null;
/** Own entries only: a role named like an Object property never inherits a value. */
export const roleAutocompact=(settings:WorkspaceSettings,role:string):number|null=>settings.autocompact&&Object.hasOwn(settings.autocompact,role)?settings.autocompact[role]:null;
/** The Codex CLI version every build before T1098 pinned: the list until a human accepts another. */
export const DEFAULT_CODEX_VERSIONS:readonly string[]=['0.167.0'];
const CODEX_VERSION=/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
/** A human accepts a Codex CLI version (adds it, or with replace makes it the only one); the change is a
 * settings-updated event like any other, so the history shows who accepted what and when. */
export function acceptCodexVersion(s:Store,version:string,replace=false):string[] {
  check(CODEX_VERSION.test(version),'Give an exact Codex version such as 0.168.0');
  return s.tx(()=>{
    check(s.role(s.requireActor()).kind==='human','Only a human accepts a Codex version',3);
    const before=workspaceSettings(s).codex_versions;
    return setWorkspaceSettings(s,{codex_versions:replace?[version]:before.includes(version)?before:[...before,version]}).codex_versions;
  });
}
/** The oldest Codex CLI launch and launch-watch start on (T664); any newer one starts silently, without a list to
 * pass (T1193, decisions.codex-version-policy). */
export const MIN_CODEX_VERSION='0.167.0';
const versionParts=(version:string)=>version.split('.').map(Number);
const atLeast=(version:string,floor:string)=>{
  const a=versionParts(version),b=versionParts(floor);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return true;
};
/** Reads a Codex CLI's --version output: one older than MIN_CODEX_VERSION is refused, any other starts. codex_versions
 * stays a record of the versions a human marked tested; it no longer gates or warns (T1193). */
export function checkCodexVersion(output:string):{version:string} {
  // A prerelease or build suffix (0.172.0-alpha.1, 0.171.0+abc) is kept in the name; the floor reads the three numbers.
  const [,version,core]=/^codex(?:-cli)? (([0-9]+\.[0-9]+\.[0-9]+)(?:[-+][0-9A-Za-z.+-]{1,64})?)$/.exec(output.trim())??[];
  check(version!==undefined,`Cannot read the Codex CLI version from "${output.trim().slice(0,80)}"`,4);
  check(atLeast(core!,MIN_CODEX_VERSION),`Codex CLI ${version} is older than ${MIN_CODEX_VERSION}, the oldest sassato starts`,4);
  return {version:version!};
}
/** The nudge's default interval (T1253): the rules' fifteen minutes. */
export const DEFAULT_NUDGE_MINUTES=15;
export const DIGEST_SKIPPABLE=['own-work','open-work','spare-work','task-finished','mail'];
/** Workspace configuration is recorded in its existing append-only audit history. */
export function workspaceSettings(s: Store): WorkspaceSettings {
  const event=s.get("SELECT actor,detail FROM events WHERE workspace_id=? AND entity='workspace' AND action IN ('created','settings-updated') ORDER BY id DESC LIMIT 1",s.ws);
  if (!event) return {default_human:null,import_timezone:'UTC',stop_file:null,busy_checks:[],import_answer_markers:[],import_role_aliases:{},import_timezone_aliases:{},open_work_roles:null,digest_skip:{},autocompact:{},advisor:{},wake_mode:'legacy',speed:'normal',wake_roles:{},codex_versions:[...DEFAULT_CODEX_VERSIONS],spare_work:true,spare_providers:[],rule_relays:[],pull_repositories:{},feedback_closers:[],nudge_minutes:DEFAULT_NUDGE_MINUTES,nudge_escalate:null,nudge_off:[]};
  const detail=JSON.parse(event.detail);
  if (detail.settings) {
    // Older builds allowed aliases such as EST/CET. Ignore those overrides on
    // read so standard meanings win and unrelated settings remain editable.
    const settings={busy_checks:[],import_answer_markers:[],import_role_aliases:{},import_timezone_aliases:{},open_work_roles:null,digest_skip:{},autocompact:{},advisor:{},wake_mode:'legacy',speed:'normal',wake_roles:{},codex_versions:[...DEFAULT_CODEX_VERSIONS],spare_work:true,spare_providers:[],rule_relays:[],pull_repositories:{},feedback_closers:[],nudge_minutes:DEFAULT_NUDGE_MINUTES,nudge_escalate:null,nudge_off:[],...detail.settings};
    settings.import_timezone_aliases=Object.fromEntries(Object.entries(settings.import_timezone_aliases).filter(([key])=>!standardTimezone(key)));
    return settings;
  }
  // Preserve the recorded bootstrap human; unconfigured imports use generic UTC.
  const human=s.get("SELECT name FROM roles WHERE workspace_id=? AND name=? AND kind='human'",s.ws,event.actor)?.name ?? null;
  return {default_human:human,import_timezone:'UTC',stop_file:null,busy_checks:[],import_answer_markers:[],import_role_aliases:{},import_timezone_aliases:{},open_work_roles:null,digest_skip:{},autocompact:{},advisor:{},wake_mode:'legacy',speed:'normal',wake_roles:{},codex_versions:[...DEFAULT_CODEX_VERSIONS],spare_work:true,spare_providers:[],rule_relays:[],pull_repositories:{},feedback_closers:[],nudge_minutes:DEFAULT_NUDGE_MINUTES,nudge_escalate:null,nudge_off:[]};
}
export function setWorkspaceSettings(s: Store, patch: Partial<WorkspaceSettings>): WorkspaceSettings {
  return s.tx(()=>{
    s.requireHuman();check(Object.keys(patch).length,'Provide a workspace setting');
    const before=workspaceSettings(s),settings=validateSettings(s,{...before,...patch});
    s.event('workspace',s.workspace,'settings-updated',{before,settings});return settings;
  });
}

export function roleWakePolicy(settings:WorkspaceSettings,role:string):RoleWakePolicy {
  return Object.hasOwn(settings.wake_roles,role)?settings.wake_roles[role]:{};
}
