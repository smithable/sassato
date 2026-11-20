// Enrollment and delivery are separate generations. A fresh enrollment invalidates the old
// observer without advancing the worker's notification cursor. Only the launcher owns enrollment.
import { activeStop, stopStatus } from './control.js';
import { assertOrdinaryLaunchAllowed } from './launch-admission.js';
import { check } from './errors.js';
import { getNotificationProgress, saveNotificationProgress, type NotificationProgress } from './notification-progress.js';
import type { Store } from './storage.js';
import type { WaitResult } from './mail-wait.js';
import { workspaceSettings } from './workspace-settings.js';

interface Binding { session: number; thread: string }
interface Pending { epoch: number; progress: NotificationProgress; result: WaitResult }
const latest = (s: Store, entity: string) => s.get(
  'SELECT id,action,detail FROM events WHERE workspace_id=? AND entity=? AND entity_id=? ORDER BY id DESC LIMIT 1',
  s.ws, entity, s.requireActor());

function bound(s: Store, binding: Binding): void {
  const role = s.requireActor();
  assertOrdinaryLaunchAllowed(s, role);
  const row = s.get('SELECT * FROM sessions WHERE workspace_id=? AND role=? ORDER BY id DESC LIMIT 1', s.ws, role);
  check(row && !row.ended_at && row.id === binding.session && row.provider === 'codex' && binding.thread &&
    row.external_id === binding.thread, 'Codex wake session binding changed', 4);
}

export function pendingStop(s: Store): WaitResult | undefined {
  const role = s.requireActor();
  const request = stopStatus(s,[role])[0];
  const stop = request ? { id: request.id } : activeStop(s,[role]) ? { file: workspaceSettings(s).stop_file } : null;
  if (stop) return { role, reason: 'stop', cursor: getNotificationProgress(s)?.cursor ?? 0, stop };
}

/** Latch an observed file stop for the enrolled caller, even if the file is later removed. */
export function workerStop(s: Store, thread: string | undefined): WaitResult | undefined {
  const stop=pendingStop(s);
  if (stop?.stop?.file) {
    const row=latest(s,'wake-enrollment');
    if (row?.action==='opened' && JSON.parse(row.detail).thread===thread)
      closePendingWake(s,row.id);
  }
  return stop;
}

export function enrollPendingWake(s: Store, binding: Binding): number {
  return s.tx(() => {
    bound(s,binding);
    check(!pendingStop(s),'STOP prevents waiter enrollment',4);
    const previous = latest(s,'wake-enrollment');
    check(!previous || previous.action === 'closed','Close the existing waiter enrollment before replacing it',4);
    return s.event('wake-enrollment',s.requireActor(),'opened',{...binding,stopGeneration:lastStop(s)});
  });
}

function lastStop(s: Store): number {
  return Number(s.get('SELECT coalesce(max(id),0) AS id FROM stop_requests WHERE workspace_id=? AND role=?',
    s.ws,s.requireActor())?.id);
}

export function enrollment(s: Store, epoch: number): Binding {
  const row = latest(s,'wake-enrollment');
  check(row?.id === epoch && row.action === 'opened','Waiter enrollment changed',4);
  const binding: Binding & {stopGeneration:number} = JSON.parse(row.detail);
  check(lastStop(s)===binding.stopGeneration,'STOP invalidated this enrollment; reconcile before re-enrolling',4);
  bound(s,binding);
  return binding;
}

export function closePendingWake(s: Store, epoch: number): void {
  s.tx(() => {
    const row=latest(s,'wake-enrollment');
    check(row?.id===epoch && row.action==='opened','Waiter enrollment changed',4);
    s.event('wake-enrollment',s.requireActor(),'closed',{epoch});
  });
}

function originalProgress(s: Store, progress: NotificationProgress): void {
  const current=getNotificationProgress(s);
  check(current && current.version===progress.version && current.cursor===progress.cursor,
    'Pending wake progress changed; reconcile from saved progress',4);
}

export function stagePendingWake(s: Store, epoch: number, progress: NotificationProgress, result: WaitResult): number {
  return s.tx(() => {
    enrollment(s,epoch);
    originalProgress(s,progress);
    check(!pendingStop(s),'STOP prevents staging a work digest',4);
    check(result.role===s.requireActor() && result.reason!=='timeout' && result.reason!=='stop' &&
      result.cursor>=progress.cursor && Number.isSafeInteger(result.cursor) &&
      result.cursor<=Number(s.get('SELECT max(id) AS id FROM events WHERE workspace_id=?',s.ws)?.id),'Invalid pending wake',4);
    const previous=latest(s,'wake-delivery');
    check(previous?.action!=='pending' || JSON.parse(previous.detail).epoch!==epoch,'A wake is already pending',4);
    // Message text stays in the messages table. Store just the routing and ordering metadata.
    const stored={...result};
    if (result.message) {
      const {summary: _text,...message}=result.message;
      stored.message=message;
    }
    if (result.digest) stored.digest={...result.digest,entries:result.digest.entries.map(entry=>
      entry.id.startsWith('M') ? {...entry,summary:''} : entry)};
    return s.event('wake-delivery',result.role,'pending',{epoch,progress,result:stored});
  });
}

export function readPendingWake(s: Store, thread: string | undefined) {
  return s.snapshot(() => {
    const row=latest(s,'wake-delivery');
    check(row?.action==='pending','No pending wake for this role',4);
    const pending: Pending=JSON.parse(row.detail);
    if (pending.result.message) {
      const message=pending.result.message;
      message.summary=s.get('SELECT substr(body,1,2000) AS body FROM messages WHERE workspace_id=? AND id=?',
        s.ws,Number(String(message.id).slice(1)))?.body ?? '';
    }
    const checkBinding=()=>check(enrollment(s,pending.epoch).thread===thread,'Pending wake belongs to a different Codex thread',4);
    checkBinding();
    originalProgress(s,pending.progress);
    const commit=()=>s.tx(()=>{
      checkBinding();
      check(latest(s,'wake-delivery')?.id===row.id,'Pending wake already consumed or replaced',4);
      originalProgress(s,pending.progress);
      if (workerStop(s,thread)) return {saved:false,line:'STOP requested during delivery; checkpoint and do not start work.'};
      saveNotificationProgress(s,{cursor:pending.result.cursor,expected_version:pending.progress.version,scored:pending.result.scored,idle:pending.result.idle});
      s.event('wake-delivery',s.requireActor(),'consumed',{epoch:pending.epoch,pending:row.id});
      return {saved:true,line:`Cursor ${pending.result.cursor} saved. Pending wake consumed.`};
    });
    return {...pending,commit};
  });
}
