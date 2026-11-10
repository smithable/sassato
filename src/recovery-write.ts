import { type Store, type Row } from './storage.js';
import { text } from './errors.js';
import { setWip, type WipInput } from './coordination.js';
import { CHECKPOINT_FORMAT, checkpointFingerprint } from './checkpoints.js';

export function saveCheckpoint(s: Store, input: WipInput): Row {
  // All fields must be supplied: silently carrying old notes into a recovery record is unsafe.
  text(input.current,'checkpoint current',10_000);
  text(input.next,'checkpoint next',10_000);
  text(input.notes,'checkpoint notes',10_000);
  return s.tx(()=>{
    const role=s.requireActor(), wip=setWip(s,input);
    const event=s.event('checkpoint',role,'saved',{format:CHECKPOINT_FORMAT,wip,fingerprint:checkpointFingerprint(s,role)});
    const savedAt=s.get('SELECT created_at FROM events WHERE workspace_id=? AND id=?',s.ws,event)!.created_at;
    return {id:`E${event}`,role,saved_at:savedAt,wip_version:wip.version,current:wip.current,next:wip.next,notes:wip.notes,state:'current'};
  });
}
