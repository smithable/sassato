import type { Row, Store } from './storage.js';

export const DIGEST_LIMIT=100;
export const DIGEST_GROUPS=['needs-a-decision','review-requested','finished','other'] as const;
export type DigestGroup=typeof DIGEST_GROUPS[number];
export interface DigestEntry {id:string;event_id?:string;from:string;kind:string;task?:string;summary:string;group:DigestGroup;}
export interface WaitDigest {entries:DigestEntry[];total:number;flush:'quiet'|'max'|'deadline'|'capacity'|'immediate';settle:number;settle_max:number;}
export const digestText=(value:unknown):string=>Array.from(String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,160).join('');
/** Monotonic quiet/max policy shared by the runtime and timestamp replay. */
export class DigestWindow {
  first:number|undefined;last:number|undefined;
  constructor(readonly settle:number,readonly maximum:number){}
  add(at:number):void {this.first??=at;this.last=at;}
  deadline():number {return this.first===undefined?Infinity:Math.min(this.last!+this.settle*1000,this.first+this.maximum*1000);}
  reason(at:number):'quiet'|'max'|undefined {
    if(this.first===undefined)return undefined;
    if(at>=this.first+this.maximum*1000)return 'max';
    return at>=this.last!+this.settle*1000?'quiet':undefined;
  }
}
/** New flags live beside recipients in the immutable canonical send audit event. */
export function messageSent(s:Store,messageId:string):Row|undefined {
  return s.get("SELECT id,actor,detail,created_at FROM events WHERE workspace_id=? AND entity='message' AND entity_id=? AND action='sent' ORDER BY id LIMIT 1",s.ws,messageId);
}
export function messageIsNow(s:Store,messageId:string):boolean {
  const event=messageSent(s,messageId);if(!event)return false;
  try{return JSON.parse(event.detail).now===true;}catch{return false;}
}
export function digestGroup(kind:string):DigestGroup {
  if(['answer','reply-needed','blocker-assigned','dependency-dropped'].includes(kind))return 'needs-a-decision';
  if(kind==='review-submitted')return 'review-requested';
  if(['task-finished','review-approved','blocker-resolved'].includes(kind))return 'finished';
  return 'other';
}
export function formatDigest(digest:WaitDigest,cursor:number):string {
  const lines=[`Work digest: ${digest.total} notifications (${digest.flush}) · cursor ${cursor}`];
  for(const group of DIGEST_GROUPS) {
    const entries=digest.entries.filter(entry=>entry.group===group);if(!entries.length)continue;
    lines.push(group+':');
    for(const entry of entries)lines.push(`${entry.event_id??entry.id} ${entry.id} · from ${entry.from} · ${entry.kind}${entry.task?' · '+entry.task:''} · ${entry.summary}`);
  }
  if(digest.flush==='capacity')lines.push('Digest limit reached; handle these entries, save this cursor, then wait again for the remainder.');
  lines.push('Read full records by id; receipts and notification progress are unchanged.');
  return lines.join('\n');
}

/** Indexed by the public message id; legacy/imported sends without the flag are false. */
export const MESSAGE_NOW_SQL=`coalesce((SELECT CASE WHEN json_valid(e.detail) THEN json_extract(e.detail,'$.now')=1 ELSE 0 END
  FROM events e WHERE e.workspace_id=m.workspace_id AND e.entity='message' AND e.entity_id='M'||m.id AND e.action='sent' ORDER BY e.id LIMIT 1),0)`;
