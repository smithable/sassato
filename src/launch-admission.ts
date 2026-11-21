import { lstatSync,readdirSync,realpathSync,statSync,type PathLike } from 'node:fs';
import { join,sep } from 'node:path';
import type { Store } from './storage.js';
import { check,name } from './errors.js';

function launchRoot(database:string):string {
  return `${realpathSync(database)}.launch`;
}
export function launchDirectory(database:string,workspace:string):string {
  return join(launchRoot(database),name(workspace));
}
export function launchLockPath(s:Store,role:string,workspace=s.workspace):string {
  return join(launchDirectory(s.path,workspace),`${name(role)}.lock`);
}
/** Also used for read-only previews; real admission repeats it under BEGIN IMMEDIATE. */
export function assertOrdinaryLaunchAllowed(s:Store,role:string):void {
  check(!s.get('SELECT id FROM managed_workers WHERE role=?',name(role)),
    'Role is reserved by a managed generation; ordinary launch cannot adopt or bypass it',4);
}
/** Call inside the same writer transaction that records the managed reservation.
 * Ordinary native admission and terminal dispatch create their lock inside that
 * writer transaction too. Existence, even stale or unreadable, blocks adoption.
 */
export function assertNoOrdinaryLauncher(s:Store,role:string):void {
  check(statSync(s.path).nlink===1,'Hard-linked coordination databases are unsupported for launch admission',4);
  const root=launchRoot(s.path),file=`${name(role)}.lock`;
  const registered=new Set(s.all('SELECT name FROM workspaces ORDER BY name').map(row=>name(row.name)));
  for(const workspace of registered) {
    check(!lockExists(join(root,workspace,file)),`A pending ordinary launcher reserves this role in workspace ${workspace}; reconcile it before managed launch`,4);
  }
  let entries:Buffer[];
  try{entries=readdirSync(root,{encoding:'buffer'});}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return;
    throw error;
  }
  // Linux permits non-UTF-8 names. Use raw directory bytes for the probe so
  // replacement characters in the diagnostic cannot hide a reservation.
  const prefix=Buffer.from(root+sep),suffix=Buffer.from(sep+file);
  for(const entry of entries) {
    const label=entry.toString('utf8');
    if(registered.has(label)||!lockExists(Buffer.concat([prefix,entry,suffix]),true))continue;
    const location=entry.equals(Buffer.from(label))?JSON.stringify(label):`with filename bytes ${entry.toString('hex')}`;
    check(false,`A pending ordinary launcher reserves this role in unregistered workspace directory ${location}; reconcile it before managed launch`,4);
  }
}
function lockExists(path:PathLike,nonDirectoryIsAbsent=false):boolean {
  try{lstatSync(path);return true;}
  catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='ENOENT'||(nonDirectoryIsAbsent&&code==='ENOTDIR'))return false;
    throw error;
  }
}
