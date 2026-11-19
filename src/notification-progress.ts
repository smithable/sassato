import { type Store } from './storage.js';
import { check, integer, name } from './errors.js';
import { DIGEST_LIMIT } from './wait-digest.js';
import { WAKE_SPEEDS, type WakeScore } from './wake-policy.js';

export interface NotificationProgress {
  id: string;
  role: string;
  cursor: number;
  version: number;
  saved_at: string;
}
export interface ScoredDelivery { event_ids:number[]; through?:number; score:WakeScore }
export interface NotificationProgressInput { cursor: number; expected_version: number; scored?:ScoredDelivery }

/** Accept the compact scored receipt from `wait --json`, without copying the digest into the audit. */
export function parseScoredReceipt(json:string):ScoredDelivery {
  check(json.length<=8192,'--scored-receipt is too long');
  let value;
  try {value=JSON.parse(json);} catch {check(false,'--scored-receipt must be valid JSON');}
  const score=value?.score;
  check(Array.isArray(value?.event_ids)&&value.event_ids.length<=DIGEST_LIMIT&&score&&
    WAKE_SPEEDS.includes(score.speed)&&['immediate','age','threshold','continuation','idle'].includes(score.reason),
  'Use the scored receipt from wait --json');
  const {trigger,immediate_cause,age_limit_seconds}=score;
  check(trigger===undefined||typeof trigger==='string'&&/^(?:[A-Z][0-9]+|[a-z][a-z0-9_-]{0,63})$/.test(trigger),'Invalid scored receipt trigger');
  check(immediate_cause===undefined||['supervisor-ping','answer','now'].includes(immediate_cause),'Invalid immediate wake reason');
  return {
    event_ids:value.event_ids.map((id:unknown)=>integer(id,'delivered event',1)),
    ...(value.through===undefined?{}:{through:integer(value.through,'scored batch boundary')}),
    score:{reason:score.reason,speed:score.speed,total:integer(score.total,'total'),threshold:integer(score.threshold,'threshold',1),
      ...(trigger===undefined?{}:{trigger}),...(immediate_cause===undefined?{}:{immediate_cause}),
      ...(age_limit_seconds===undefined?{}:{age_limit_seconds:integer(age_limit_seconds,'age limit',1)})},
  };
}

/** A page can deliver newer urgent items before older ones. Keep those receipts with the
 * cursor and remember the upper boundary of the batch until every page has been delivered. */
export function scoredDeliveryState(s:Store,role:string,cursor:number) {
  const progress=getNotificationProgress(s,role);
  if (!progress || progress.cursor!==cursor) return {seen:new Set<number>(),through:undefined};
  const event=s.get('SELECT detail FROM events WHERE workspace_id=? AND id=?',s.ws,Number(progress.id.slice(1)))!;
  const through:unknown=JSON.parse(event.detail).scored_through;
  return {
    seen:new Set(s.all('SELECT event_id FROM scored_wake_delivery WHERE workspace_id=? AND role=? AND event_id>?',s.ws,role,cursor).map(row=>Number(row.event_id))),
    through:typeof through==='number'&&Number.isSafeInteger(through)&&through>cursor?through:undefined,
  };
}

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
    if (!input.scored && old && cursor===old.cursor && (expected===old.version || expected===old.version-1)) return old;
    check(expected===(old?.version??0),'Notification progress changed; read it and retry with --expect',4);
    check(!old || cursor>=old.cursor,'Notification cursor cannot move backwards; use wait --since for an explicit replay',4);
    const latest=Number(s.get('SELECT coalesce(max(id),0) AS n FROM events WHERE workspace_id=?',s.ws)!.n);
    check(cursor<=latest,'Notification cursor is ahead of this workspace; use a safely handled cursor from this workspace',4);
    const scored=input.scored;
    const through=scored?.through;
    if (through!==undefined) integer(through,'scored batch boundary',cursor,latest);
    for(const eventId of scored?.event_ids??[]) {
      integer(eventId,'delivered event',cursor+1,latest);
      const event=s.get('SELECT id FROM events WHERE workspace_id=? AND id=?',s.ws,eventId);
      check(event,'Delivered event does not belong to this workspace',4);
      s.run('INSERT OR IGNORE INTO scored_wake_delivery(workspace_id,role,event_id) VALUES(?,?,?)',s.ws,role,eventId);
    }
    s.run('DELETE FROM scored_wake_delivery WHERE workspace_id=? AND role=? AND event_id<=?',s.ws,role,cursor);
    const version=(old?.version??0)+1;
    const event=s.event('notification-progress',role,'saved',{format:1,cursor,version,...(through===undefined?{}:{scored_through:through}),...(scored?{scored_score:scored.score}:{})});
    const saved=s.get('SELECT created_at FROM events WHERE workspace_id=? AND id=?',s.ws,event)!;
    return {id:`E${event}`,role,cursor,version,saved_at:saved.created_at};
  });
}
