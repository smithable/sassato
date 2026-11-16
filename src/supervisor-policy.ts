import type { Store,Row } from './storage.js';
import { check,name,safe,text } from './errors.js';
import { isAbsolute } from 'node:path';

export interface SupervisorPolicy {
  version:1;controller_id:string;controller_role:string;worker_roles:string[];repository_ids:string[];
  controller_lock:string;maintenance_lock:string;maximum_workers:number;
}
export function getSupervisorPolicy(s:Store):SupervisorPolicy|null {
  const row=s.get("SELECT detail FROM events WHERE workspace_id=? AND entity='supervisor-policy' AND action='configured' ORDER BY id DESC LIMIT 1",s.ws);
  return row?JSON.parse(row.detail).policy:null;
}
export function setSupervisorPolicy(s:Store,input:unknown):SupervisorPolicy {
  s.requireHuman();check(input && typeof input==='object' && !Array.isArray(input),'Supervisor policy must be an object');safe(input);
  const p=input as Row;check(Object.keys(p).every(key=>['version','controller_id','controller_role','worker_roles','repository_ids','controller_lock','maintenance_lock','maximum_workers'].includes(key)),'Unknown supervisor policy field');
  check(p.version===1 && typeof p.controller_id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.controller_id),'Policy needs version 1 and an explicit controller UUID');
  check(s.role(name(p.controller_role)).kind==='agent','Controller reporting identity must be an agent role');
  check(Array.isArray(p.worker_roles) && p.worker_roles.length>0 && p.worker_roles.length<=16,'Policy needs 1–16 existing worker roles');
  for(const role of p.worker_roles)check(role!==p.controller_role && s.role(name(role)).kind==='agent','Worker and controller identities must be distinct agent roles');
  check(new Set(p.worker_roles).size===p.worker_roles.length,'Duplicate worker role in policy');
  check(Array.isArray(p.repository_ids) && p.repository_ids.length<=32,'Repository policy must be an array of at most 32 IDs');
  for(const repo of p.repository_ids)check(s.get('SELECT 1 FROM registry_repositories r JOIN registry_checkouts c ON c.repository_id=r.id JOIN project_checkouts pc ON pc.checkout_id=c.id JOIN registry_projects p ON p.id=pc.project_id WHERE p.workspace_id=? AND r.id=?',s.ws,text(repo,'repository ID',100)),'Repository is not registered in this project',3);
  for(const field of ['controller_lock','maintenance_lock'])check(isAbsolute(text(p[field],field,4096)),'Supervisor lock paths must be absolute');
  check(p.controller_lock!==p.maintenance_lock,'Controller and maintenance locks must be separate');
  check(Number.isSafeInteger(p.maximum_workers) && p.maximum_workers>0 && p.maximum_workers<=p.worker_roles.length,'Worker limit exceeds the explicit allowed roles');
  return s.tx(()=>{
    s.requireHuman();check(!s.get("SELECT id FROM managed_workers WHERE workspace_id=? AND state NOT IN ('exited','stopped') LIMIT 1",s.ws),'Drain and reconcile existing managed workers before changing policy',4);
    const previous=getSupervisorPolicy(s);
    if(previous && s.get('SELECT id FROM managed_workers WHERE workspace_id=? LIMIT 1',s.ws))check(JSON.stringify(previous)===JSON.stringify(p),'Existing generation tombstones retain their controller and policy; do not orphan them',4);
    check(!s.get("SELECT id FROM jobs WHERE status IN ('waiting','running') OR (orphans IS NOT NULL AND orphans!='[]') LIMIT 1"),'Settle machine-wide jobs before changing supervisor maintenance policy',4);
    s.event('supervisor-policy',p.controller_id,'configured',{policy:p});return p as SupervisorPolicy;
  });
}
