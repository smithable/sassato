import { type Store } from './storage.js';
import { check, integer, name } from './errors.js';

export interface NotificationProgress {
  id: string;
  role: string;
  cursor: number;
  version: number;
  saved_at: string;
}
export interface NotificationProgressInput { cursor: number; expected_version: number }

/** The caller attests that notifications through cursor have been safely handled. */
export function getNotificationProgress(s: Store, target?: string): NotificationProgress | null {
  const role=target ? name(target) : s.requireActor();s.role(role);
  return s.snapshot(()=>{
    const event=s.get("SELECT id,detail,created_at FROM events WHERE workspace_id=? AND entity='notification-progress' AND entity_id=? AND action='saved' ORDER BY id DESC LIMIT 1",s.ws,role);
    if (!event) return null;
    let detail: unknown;
    try {detail=JSON.parse(event.detail);} catch {detail=null;}
    const value=detail && typeof detail==='object' && !Array.isArray(detail) ? detail as Record<string,unknown> : {};
    check(value.format===1 && Number.isSafeInteger(value.cursor) && Number(value.cursor)>=0 && Number(value.cursor)<event.id &&
      Number.isSafeInteger(value.version) && Number(value.version)>0,
    'Stored notification progress is malformed or unsupported; inspect its audit event before recovering. Use an explicit earlier --since cursor to replay safely.',4);
    return {id:`E${event.id}`,role,cursor:Number(value.cursor),version:Number(value.version),saved_at:event.created_at};
  });
}

/** Role-owned, monotonic compare-and-set; identical retries never advance progress twice. */
export function saveNotificationProgress(s: Store, input: NotificationProgressInput): NotificationProgress {
  const cursor=integer(input.cursor,'notification cursor'), expected=integer(input.expected_version,'expected progress version');
  return s.tx(()=>{
    const role=s.requireActor(), old=getNotificationProgress(s);
    if (old && cursor===old.cursor && (expected===old.version || expected===old.version-1)) return old;
    check(expected===(old?.version??0),'Notification progress changed; read it and retry with --expect',4);
    check(!old || cursor>=old.cursor,'Notification cursor cannot move backwards; use wait --since for an explicit replay',4);
    const latest=Number(s.get('SELECT coalesce(max(id),0) AS n FROM events WHERE workspace_id=?',s.ws)!.n);
    check(cursor<=latest,'Notification cursor is ahead of this workspace; use a safely handled cursor from this workspace',4);
    const version=(old?.version??0)+1;
    const event=s.event('notification-progress',role,'saved',{format:1,cursor,version});
    const saved=s.get('SELECT created_at FROM events WHERE workspace_id=? AND id=?',s.ws,event)!;
    return {id:`E${event}`,role,cursor,version,saved_at:saved.created_at};
  });
}
