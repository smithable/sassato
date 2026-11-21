import { lstatSync,readdirSync,realpathSync,statSync } from 'node:fs';
import { join } from 'node:path';
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
  const workspaces=new Set(registered);
  try {
    for(const entry of readdirSync(root,{withFileTypes:true})) {
      if(entry.isDirectory()||entry.isSymbolicLink()) workspaces.add(entry.name);
    }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const workspace of workspaces) {
    const path=join(root,workspace,file);
    try {lstatSync(path);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const location=registered.has(workspace)?`workspace ${workspace}`:`unregistered workspace directory ${JSON.stringify(workspace)}`;
    check(false,`A pending ordinary launcher reserves this role in ${location}; reconcile it before managed launch`,4);
  }
}
