import { type Store, type Row } from './storage.js';
import { check, name, text } from './errors.js';
import { validateBusyChecks, type BusyCheck } from './busy-checks.js';

export interface CodexWatchSettings { remote:string }
export interface WorkspaceSettings { codex_watch:Record<string,CodexWatchSettings>; default_human: string | null; import_timezone: string; stop_file: string | null; busy_checks:BusyCheck[]; import_answer_markers:string[]; import_role_aliases:Record<string,string>; import_timezone_aliases:Record<string,string> }
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
export function validateCodexWatch(s:Store,value:unknown):Record<string,CodexWatchSettings> {
  check(value!==null&&typeof value==='object'&&!Array.isArray(value),'codex_watch must be an object keyed by role');
  const entries=Object.entries(value);check(entries.length<=32,'codex_watch supports at most 32 roles');
  return Object.fromEntries(entries.map(([role,setting])=>{
    const configured=s.role(name(role));
    check(configured.kind==='agent'&&configured.provider==='codex','Watch settings require a Codex agent role');
    check(setting!==null&&typeof setting==='object'&&!Array.isArray(setting),'Watch setting must contain remote');
    const object=setting as Record<string,unknown>;
    check(Object.keys(object).length===1&&Object.hasOwn(object,'remote'),'Watch setting accepts only remote');
    const remote=text(object.remote,'Codex remote endpoint',4096);
    // Local endpoints only for the first experimental release. Never accept credentials in URLs.
    check(/^unix:\/\/(?:\/[^\s]+)?$/.test(remote)||/^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(remote),'Use a local unix:// endpoint or ws://localhost:PORT');
    if(remote.startsWith('ws:')){const port=Number(new URL(remote).port);check(port>0&&port<=65535,'Invalid remote port');}
    return [role,{remote}];
  }));
}
export function validateSettings(s: Store, input: Row): WorkspaceSettings {
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
  return {codex_watch:validateCodexWatch(s,input.codex_watch??{}),default_human:human,import_timezone:validateTimezone(input.import_timezone ?? 'UTC'),stop_file:input.stop_file == null ? null : text(input.stop_file,'stop file',4096),busy_checks:validateBusyChecks(input.busy_checks??[]),import_answer_markers:markers.map(marker=>text(marker,'import answer marker',200)),import_role_aliases:roleAliases,import_timezone_aliases:timezoneAliases};
}
/** Workspace configuration is recorded in its existing append-only audit history. */
export function workspaceSettings(s: Store): WorkspaceSettings {
  const event=s.get("SELECT actor,detail FROM events WHERE workspace_id=? AND entity='workspace' AND action IN ('created','settings-updated') ORDER BY id DESC LIMIT 1",s.ws);
  if (!event) return {codex_watch:{},default_human:null,import_timezone:'UTC',stop_file:null,busy_checks:[],import_answer_markers:[],import_role_aliases:{},import_timezone_aliases:{}};
  const detail=JSON.parse(event.detail);
  if (detail.settings) {
    // Older builds allowed aliases such as EST/CET. Ignore those overrides on
    // read so standard meanings win and unrelated settings remain editable.
    const settings={codex_watch:{},busy_checks:[],import_answer_markers:[],import_role_aliases:{},import_timezone_aliases:{},...detail.settings};
    settings.import_timezone_aliases=Object.fromEntries(Object.entries(settings.import_timezone_aliases).filter(([key])=>!standardTimezone(key)));
    return settings;
  }
  // Preserve the recorded bootstrap human; unconfigured imports use generic UTC.
  const human=s.get("SELECT name FROM roles WHERE workspace_id=? AND name=? AND kind='human'",s.ws,event.actor)?.name ?? null;
  return {codex_watch:{},default_human:human,import_timezone:'UTC',stop_file:null,busy_checks:[],import_answer_markers:[],import_role_aliases:{},import_timezone_aliases:{}};
}
export function setWorkspaceSettings(s: Store, patch: Partial<WorkspaceSettings>): WorkspaceSettings {
  return s.tx(()=>{
    s.requireHuman();check(Object.keys(patch).length,'Provide a workspace setting');
    const before=workspaceSettings(s),settings=validateSettings(s,{...before,...patch});
    s.event('workspace',s.workspace,'settings-updated',{before,settings});return settings;
  });
}
