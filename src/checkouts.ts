import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute,resolve } from 'node:path';
import { type Store, type Row } from './storage.js';
import { check, id, name, now, text } from './errors.js';
import { assertWorkAllowed } from './control.js';
import { sessionState } from './coordination.js';
import { probeRepositoryIdentity, repositoryFingerprint, checkoutFingerprint, insideCheckout, type RepositoryIdentity } from './repository-identity.js';

export function registerCheckout(s:Store,directory:string):Row {
  const actor=s.requireActor(),identity=probeRepositoryIdentity(directory);
  return s.tx(()=>{
    assertWorkAllowed(s,actor);
    // Check again under the registry write lock; folder replacement cannot silently
    // retarget an existing identity. No Git refs or worktree registration are mutated.
    const fresh=probeRepositoryIdentity(directory);
    check(checkoutFingerprint(identity)===checkoutFingerprint(fresh),'Checkout changed during registration; retry',4);
    let project=s.get('SELECT * FROM registry_projects WHERE workspace_id=?',s.ws);
    if(!project) {project={id:randomUUID()};s.run('INSERT INTO registry_projects VALUES(?,?)',project.id,s.ws);}
    let repository=s.get('SELECT * FROM registry_repositories WHERE common_dir=?',identity.git_common_dir);
    const repositoryKey=repositoryFingerprint(identity),checkoutKey=checkoutFingerprint(identity);
    check(!repository || repository.fingerprint===repositoryKey,'Registered repository was replaced; explicit rebind is required',4);
    if(!repository) {
      repository={id:randomUUID()};
      s.run('INSERT INTO registry_repositories VALUES(?,?,?,?,?)',repository.id,repositoryKey,identity.git_common_dir,JSON.stringify(identity),now());
    }
    let checkout=s.get('SELECT * FROM registry_checkouts WHERE root=? OR git_dir=?',identity.checkout_root,identity.git_dir);
    check(!checkout || checkout.fingerprint===checkoutKey,'Registered checkout moved or was replaced; explicit rebind is required',4);
    if(!checkout) {
      checkout={id:randomUUID()};
      s.run('INSERT INTO registry_checkouts VALUES(?,?,?,?,?,?,?)',checkout.id,repository.id,checkoutKey,identity.checkout_root,identity.git_dir,JSON.stringify(identity),now());
    }
    const linked=s.run('INSERT OR IGNORE INTO project_checkouts VALUES(?,?)',project.id,checkout.id);
    if(linked.changes)s.event('checkout',checkout.id,'registered',{project_id:project.id,repository_id:repository.id,identity});
    return {project_id:project.id,repository_id:repository.id,checkout_id:checkout.id,identity};
  });
}
export function registeredCheckout(s:Store,checkoutId:string):Row {
  const row=s.get('SELECT c.*,p.id AS project_id FROM registry_checkouts c JOIN project_checkouts pc ON pc.checkout_id=c.id JOIN registry_projects p ON p.id=pc.project_id WHERE p.workspace_id=? AND c.id=?',s.ws,text(checkoutId,'checkout id',100));
  check(row,'Checkout is not registered in this project',3);return row;
}
export function inspectCheckout(s:Store,checkoutId:string,directory?:string):RepositoryIdentity {
  const row=registeredCheckout(s,checkoutId),identity=probeRepositoryIdentity(directory??row.root);
  check(checkoutFingerprint(identity)===row.fingerprint,'Checkout identity changed; explicit rebind is required',4);
  return identity;
}
export function listCheckouts(s:Store):Row[] {
  return s.all('SELECT p.id AS project_id,c.id AS checkout_id,c.repository_id,c.root,c.git_dir,c.fingerprint,c.created_at FROM registry_checkouts c JOIN project_checkouts pc ON pc.checkout_id=c.id JOIN registry_projects p ON p.id=pc.project_id WHERE p.workspace_id=? ORDER BY c.root LIMIT 1000',s.ws);
}
export interface BindCheckoutInput {checkout:string;directory:string;task:string;provider:string;session:string;mode?:'coding'|'review'}
export function bindCheckout(s:Store,input:BindCheckoutInput):Row {
  const actor=s.requireActor(),provider=name(input.provider),session=text(input.session,'provider session id',200),mode=input.mode??'coding';
  check(['coding','review'].includes(mode),'Binding mode must be coding or review');
  const identity=inspectCheckout(s,input.checkout,input.directory);
  return s.tx(()=>{
    assertWorkAllowed(s,actor);
    const task=s.task(input.task);
    check(task.owner===actor && ['doing','review'].includes(task.status),'Only the current active task owner can bind its checkout',3);
    check(!task.human_only || s.role(actor).kind==='human','Human-only work cannot be bound by an agent',3);
    const configured=s.role(actor).provider;
    check(configured===null || configured===provider,'Provider differs from the configured role',4);
    inspectCheckout(s,input.checkout,input.directory);
    const prior=s.get('SELECT * FROM checkout_bindings WHERE role=? AND released_at IS NULL',actor);
    if(prior) {
      check(prior.workspace_id===s.ws && prior.task_id===task.id && prior.checkout_id===input.checkout && prior.working_dir===identity.working_dir && prior.provider===provider && prior.provider_session_id===session && prior.mode===mode,'Role already has an active checkout reservation',4);
      return prior;
    }
    check(!s.get('SELECT id FROM checkout_bindings WHERE checkout_id=? AND released_at IS NULL',input.checkout),'Checkout already has an active worker; use a separate checkout',4);
    const binding={id:randomUUID(),workspace_id:s.ws,task_id:task.id,role:actor,checkout_id:input.checkout,working_dir:identity.working_dir,provider,provider_session_id:session,mode,created_at:now(),released_at:null};
    s.run('INSERT INTO checkout_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?)',binding.id,s.ws,task.id,actor,input.checkout,binding.working_dir,provider,session,mode,binding.created_at,null);
    s.event('checkout-binding',binding.id,'reserved',{...binding,identity});return binding;
  });
}
export function currentBinding(s:Store,task?:string):Row {
  const row=s.get('SELECT * FROM checkout_bindings WHERE workspace_id=? AND role=? AND released_at IS NULL'+(task?' AND task_id=?':''),s.ws,s.requireActor(),...(task?[id(task,'T')]:[]));
  check(row,'No active checkout binding for this role/task',3);return row;
}
export function resolveWorkerPath(s:Store,relativePath:string,task?:string):Row {
  const binding=currentBinding(s,task),identity=inspectCheckout(s,binding.checkout_id,binding.working_dir);
  text(relativePath,'repository relative path',4096);
  check(!isAbsolute(relativePath),'Path must be repository relative');
  const path=realpathSync(resolve(identity.checkout_root,relativePath));
  check(insideCheckout(identity.checkout_root,path),'Resolved path escapes the registered checkout',3);
  return {path,project_id:registeredCheckout(s,binding.checkout_id).project_id,repository_id:registeredCheckout(s,binding.checkout_id).repository_id,checkout_id:binding.checkout_id,head:identity.head,working_dir:identity.working_dir};
}
export function releaseCheckout(s:Store):Row {
  return s.tx(()=>{
    const row=currentBinding(s);
    const sessions=s.all('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY id DESC',s.ws,s.requireActor());
    check(sessions.some(session=>session.external_id===row.provider_session_id && session.provider===row.provider) && sessions.every(session=>session.pid && session.process_start && ['ended','stale'].includes(sessionState(session))),'A live or unknown session still owns this reservation; verified retirement is required',4);
    check(!s.get("SELECT id FROM jobs WHERE workspace_id=? AND role=? AND status IN ('waiting','running')",s.ws,s.requireActor()),'Settle owned jobs before releasing the checkout',4);
    const at=now();s.run('UPDATE checkout_bindings SET released_at=? WHERE id=? AND released_at IS NULL',at,row.id);
    s.event('checkout-binding',row.id,'released',{});return {...row,released_at:at};
  });
}
