import { createHash } from 'node:crypto';
import { readFileSync,realpathSync,statSync } from 'node:fs';
import type { Store,Row } from './storage.js';
import { check,safe } from './errors.js';
import { inspectCheckout } from './checkouts.js';
import { dirtyManifest } from './dirty-manifest.js';
import { getNotificationProgress } from './notification-progress.js';
import { assertPhysicalIdentity } from './repository-identity.js';

export const supervisorDigest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function captureFixtureConfiguration(s:Store,role:string,program:string,files:string[]=[]):Row {
  const paths=[...new Set([program,...files].map(path=>realpathSync(path)))];check(paths.length<=16,'Too many fixture configuration files');
  const records=paths.map(path=>{const bytes=readFileSync(path);check(bytes.length<=1_048_576,'Fixture configuration file exceeds its bound');safe(bytes.toString('utf8'));return {path,sha256:createHash('sha256').update(bytes).digest('hex')};});
  return {evidence_kind:'fixture-only',provider:s.role(role).provider,executable:realpathSync(process.execPath),version:process.version,argv:[realpathSync(program)],files:records,role_settings:s.role(role),environment_provenance:['fixture test process; not a real provider configuration proof']};
}
export function recaptureFixtureConfiguration(s:Store,role:string,configuration:Row):Row {
  check(configuration.evidence_kind==='fixture-only' && Array.isArray(configuration.argv) && Array.isArray(configuration.files),'Only explicit fixture configurations use this protocol',4);
  return captureFixtureConfiguration(s,role,configuration.argv[0],configuration.files.map((file:Row)=>file.path));
}
export function captureSupervisorSnapshot(s:Store,role:string,checkout:string,directory:string,configuration:Row):Row {
  const identity=inspectCheckout(s,checkout,directory),manifest=dirtyManifest(identity.checkout_root);
  const cwd=statSync(identity.working_dir,{bigint:true});
  const task_versions=s.all("SELECT id,version,status,owner FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY id",s.ws,role);
  check(task_versions.length<=100,'Too many tasks for a bounded handoff');
  const progress=getNotificationProgress(s,role);check(progress,'Worker must retain its handled notification cursor before managed launch or handoff',4);
  const current=recaptureFixtureConfiguration(s,role,configuration);
  check(supervisorDigest(configuration)===supervisorDigest(current),'Effective fixture configuration changed',4);
  const second=inspectCheckout(s,checkout,directory);
  const after=statSync(identity.working_dir,{bigint:true});
  check(cwd.dev===after.dev && cwd.ino===after.ino && supervisorDigest(identity)===supervisorDigest(second) && supervisorDigest(manifest)===supervisorDigest(dirtyManifest(identity.checkout_root)),'Files changed during supervisor snapshot capture',4);
  return {checkout_id:checkout,working_dir:identity.working_dir,cwd_device:String(cwd.dev),cwd_inode:String(cwd.ino),identity,manifest,manifest_digest:supervisorDigest(manifest),task_versions,notification_progress:progress,configuration,configuration_digest:supervisorDigest(configuration)};
}
export function assertSupervisorSnapshot(s:Store,role:string,expected:Row):void {
  const current=captureSupervisorSnapshot(s,role,expected.checkout_id,expected.working_dir,expected.configuration);
  const expectedFields=Object.fromEntries(Object.keys(current).map(key=>[key,expected[key]]));
  check(supervisorDigest(current)===supervisorDigest(expectedFields),'Repository, dirty files, settings, tasks or notification progress changed; reconcile before lifecycle work',4);
}
export function assertSupervisorReservation(s:Store,role:string,expected:Row):void {
  assertPhysicalIdentity(expected.identity);const cwd=statSync(expected.working_dir,{bigint:true});
  check(String(cwd.dev)===expected.cwd_device && String(cwd.ino)===expected.cwd_inode,'Working directory identity changed',4);
  const tasks=s.all("SELECT id,version,status,owner FROM tasks WHERE workspace_id=? AND owner=? AND status NOT IN ('done','dropped') ORDER BY id",s.ws,role);
  check(supervisorDigest(tasks)===supervisorDigest(expected.task_versions) && supervisorDigest(getNotificationProgress(s,role))===supervisorDigest(expected.notification_progress) && supervisorDigest(s.role(role))===supervisorDigest(expected.configuration.role_settings),'Tasks, progress or role configuration changed during capture',4);
}
