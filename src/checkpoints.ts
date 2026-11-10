import { createHash } from 'node:crypto';
import { type Store, type Row } from './storage.js';
import { name } from './errors.js';
import { inspectRecoveryEvidence } from './recovery-evidence.js';

export const CHECKPOINT_FORMAT=3;
// Recovery metadata does not change the durable-input algorithm used by format 2.
const FINGERPRINT_FORMAT=2;

/** Compare durable recovery inputs, not provider history or estimated token usage. */
export function checkpointFingerprint(s: Store, role: string): string {
  const tasks = s.all('SELECT id,version FROM tasks WHERE workspace_id=? AND (owner=? OR for_role=?) ORDER BY id',s.ws,role,role);
  const blockers = s.all('SELECT b.id,b.status FROM blockers b JOIN tasks t ON t.workspace_id=b.workspace_id AND t.id=b.task_id WHERE b.workspace_id=? AND (t.owner=? OR t.for_role=? OR b.waiting_on=?) ORDER BY b.id',s.ws,role,role,role);
  const questions = s.all('SELECT q.id,q.status,q.answer FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND (t.owner=? OR t.for_role=? OR q.asked_by=?) ORDER BY q.id',s.ws,role,role,role);
  const dependencies = s.all('SELECT d.task_id,p.id,p.version FROM dependencies d JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.task_id JOIN tasks p ON p.workspace_id=d.workspace_id AND p.id=d.depends_on WHERE d.workspace_id=? AND (t.owner=? OR t.for_role=?) ORDER BY d.task_id,p.id',s.ws,role,role);
  const mail = s.all("SELECT message_id,state FROM receipts WHERE workspace_id=? AND recipient=? AND state!='done' ORDER BY message_id",s.ws,role);
  const shared = s.get("SELECT coalesce(max(id),0) AS cursor FROM events WHERE workspace_id=? AND (entity='workspace' OR (entity='role' AND entity_id=? AND action IN ('created','updated')))",s.ws,role);
  const wip = s.get('SELECT version FROM wip WHERE workspace_id=? AND role=?',s.ws,role);
  return `v${FINGERPRINT_FORMAT}:`+createHash('sha256').update(JSON.stringify({tasks,blockers,questions,dependencies,mail,shared,wip})).digest('hex');
}

export function getCheckpoint(s: Store, target?: string): Row | null {
  const role=target ? name(target) : s.requireActor();s.role(role);
  return s.snapshot(()=>{
    const event=s.get("SELECT id,created_at,detail FROM events WHERE workspace_id=? AND entity='checkpoint' AND entity_id=? AND action='saved' ORDER BY id DESC LIMIT 1",s.ws,role);
    if (!event) return null;
    let detail:Row;
    try { const parsed=JSON.parse(event.detail); detail=parsed && typeof parsed==='object' && !Array.isArray(parsed)?parsed:{}; } catch { detail={}; }
    const supported=detail.format===2 || detail.format===CHECKPOINT_FORMAT, reasons:string[]=[];
    const evidence=detail.format===CHECKPOINT_FORMAT?inspectRecoveryEvidence(detail.evidence,{role,event_id:event.id}):{evidence:null,missing:['This older checkpoint has no structured repository, task, validation, job or notification evidence.'],malformed:false};
    if (supported && evidence.malformed) reasons.push('Checkpoint recovery evidence is malformed or unsupported; review and save a new checkpoint.');
    if (!supported) reasons.push(`Checkpoint format ${detail.format??'unknown'} is unsupported; review and save a new checkpoint in format ${CHECKPOINT_FORMAT}.`);
    if (supported && detail.fingerprint!==checkpointFingerprint(s,role)) reasons.push('Saved work, mail, decisions or configuration changed since the checkpoint.');
    if (!Number.isFinite(Date.parse(event.created_at)) || Date.now()-Date.parse(event.created_at)>24*60*60_000) reasons.push('Checkpoint is older than 24 hours; review and refresh it.');
    const wip=detail.wip && typeof detail.wip==='object' && !Array.isArray(detail.wip)?detail.wip:{};
    const version=Number.isSafeInteger(wip.version) && wip.version>0?wip.version:null;
    const recovery=(key:string):string|null=>typeof wip[key]==='string'?wip[key]:null;
    const current=recovery('current'), next=recovery('next'), notes=recovery('notes');
    if (supported && (version===null || current===null || next===null || notes===null)) reasons.push('Checkpoint recovery fields are incomplete or malformed; review and save a new checkpoint.');
    return {id:`E${event.id}`,role,format:detail.format??null,saved_at:event.created_at,wip_version:version,current,next,notes,evidence:evidence.evidence,missing_evidence:evidence.missing,state:!supported?'unsupported':reasons.length?'stale':'current',reasons};
  });
}
