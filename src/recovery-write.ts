import { type Store, type Row } from './storage.js';
import { check, text } from './errors.js';
import { setWip, type WipInput } from './coordination.js';
import { CHECKPOINT_FORMAT, checkpointFingerprint, getCheckpoint } from './checkpoints.js';
import { MAX_CHECKPOINT_BYTES, observeRepository, observeTasks, validateRecoveryEvidence } from './recovery-evidence.js';
import { getNotificationProgress } from './notification-progress.js';

export interface RecoveryInput extends WipInput { evidence?: unknown }

export function saveCheckpoint(s: Store, input: RecoveryInput): Row {
  // All fields must be supplied: silently carrying old notes into a recovery record is unsafe.
  text(input.current,'checkpoint current',10_000);
  text(input.next,'checkpoint next',10_000);
  text(input.notes,'checkpoint notes',10_000);
  const reported=input.evidence===undefined?null:validateRecoveryEvidence(input.evidence);
  const role=s.requireActor(), configuredDirectory=s.role(role).working_dir??null;
  const repository=observeRepository(configuredDirectory??process.cwd());
  return s.tx(()=>{
    check((s.role(role).working_dir??null)===configuredDirectory,'Role working directory changed during checkpoint capture; retry',4);
    const wip=setWip(s,input);
    const evidence={version:1,observed:{repository,tasks:observeTasks(s,role),notification_progress:getNotificationProgress(s)},reported};
    const detail={format:CHECKPOINT_FORMAT,wip,fingerprint:checkpointFingerprint(s,role),evidence};
    check(Buffer.byteLength(JSON.stringify(detail),'utf8')<=MAX_CHECKPOINT_BYTES,'Checkpoint exceeds 96000 bytes; shorten recovery text or evidence');
    s.event('checkpoint',role,'saved',detail);
    return getCheckpoint(s)!;
  });
}
