import { createHash,timingSafeEqual } from 'node:crypto';
import type { Store } from './storage.js';
import { check } from './errors.js';

export interface ManagedCredentials {generation?:string;token?:string}
export type ManagedWriteMode='normal'|'reconcile'|'stop-ack'|'bootstrap';
export function workerTokenHash(token:string):string {
  return createHash('sha256').update(token).digest('hex');
}
/** Authenticate reads as well as writes without changing lifecycle state. */
export function assertManagedIdentity(s:Store,credentials:ManagedCredentials):void {
  if(!s.ws || !s.actor)return;
  const worker=s.get('SELECT workspace_id,generation,token_hash,state FROM managed_workers WHERE role=?',s.actor);
  if(!worker)return;
  check(worker.workspace_id===s.ws,'Managed role is reserved in another workspace',4);
  check(typeof credentials.generation==='string' && /^[1-9][0-9]*$/.test(credentials.generation) && Number.isSafeInteger(Number(credentials.generation)) && Number(credentials.generation)===worker.generation,'Managed worker generation is missing or stale; reconcile the current assignment',4);
  check(typeof credentials.token==='string' && credentials.token.length>=32 && credentials.token.length<=256,'Managed worker authentication is missing',3);
  const supplied=Buffer.from(workerTokenHash(credentials.token),'hex'),expected=Buffer.from(String(worker.token_hash),'hex');
  check(expected.length===supplied.length && timingSafeEqual(supplied,expected),'Managed worker authentication does not match its generation',3);
}
/** Invoked inside BEGIN IMMEDIATE, including for legacy mutation commands. */
export function assertManagedWrite(s:Store,credentials:ManagedCredentials,mode:ManagedWriteMode='normal'):void {
  assertManagedIdentity(s,credentials);
  if(!s.ws || !s.actor)return;
  const worker=s.get('SELECT state FROM managed_workers WHERE role=?',s.actor);if(!worker)return;
  const allowed=mode==='bootstrap'?worker.state==='starting':mode==='reconcile'?worker.state==='reconciling':mode==='stop-ack'?!['exited','starting'].includes(worker.state):['running','draining'].includes(worker.state);
  check(allowed,'Managed worker is frozen; no new writes are allowed in this lifecycle state',4);
}
