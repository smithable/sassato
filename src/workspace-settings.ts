import { type Store, type Row } from './storage.js';
import { check, name, text } from './errors.js';
import { legacyImportTimezone, legacyStopFile } from './legacy.js';

export interface WorkspaceSettings { default_human: string | null; import_timezone: string; stop_file: string | null }
export function validateTimezone(value: unknown): string {
  const zone = text(value,'import time zone',100);
  try {new Intl.DateTimeFormat('en',{timeZone:zone});} catch {check(false,'Use an IANA import time zone such as UTC or America/New_York');}
  return zone;
}
export function validateSettings(s: Store, input: Row): WorkspaceSettings {
  const human = input.default_human ?? null;
  if (human !== null) check(s.role(name(human)).kind === 'human','Default decision recipient must be a human role',3);
  return {default_human:human,import_timezone:validateTimezone(input.import_timezone ?? 'UTC'),stop_file:input.stop_file == null ? null : text(input.stop_file,'stop file',4096)};
}
/** Workspace configuration is recorded in its existing append-only audit history. */
export function workspaceSettings(s: Store): WorkspaceSettings {
  const event=s.get("SELECT actor,detail FROM events WHERE workspace_id=? AND entity='workspace' AND action IN ('created','settings-updated') ORDER BY id DESC LIMIT 1",s.ws);
  if (!event) return {default_human:null,import_timezone:'UTC',stop_file:null};
  const detail=JSON.parse(event.detail);
  if (detail.settings) return detail.settings;
  // Pre-configuration databases keep the original bootstrap human and import/stop behavior.
  const human=s.get("SELECT name FROM roles WHERE workspace_id=? AND name=? AND kind='human'",s.ws,event.actor)?.name ?? null;
  return {default_human:human,import_timezone:legacyImportTimezone,stop_file:legacyStopFile()};
}
export function setWorkspaceSettings(s: Store, patch: Partial<WorkspaceSettings>): WorkspaceSettings {
  return s.tx(()=>{
    s.requireHuman();check(Object.keys(patch).length,'Provide a workspace setting');
    const before=workspaceSettings(s),settings=validateSettings(s,{...before,...patch});
    s.event('workspace',s.workspace,'settings-updated',{before,settings});return settings;
  });
}
