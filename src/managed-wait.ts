import type { Store } from './storage.js';
import { waitForWork,type WaitOptions,type WaitResult } from './mail-wait.js';
import { armManagedWaiter,disarmManagedWaiter } from './supervisor-monitor.js';
import { getNotificationProgress } from './notification-progress.js';
import { activeStop } from './control.js';
import { workspaceSettings } from './workspace-settings.js';

/** Legacy unmanaged waits remain read-only. Managed waits add PID-bound observations. */
export async function waitWithManagedObservation(s:Store,options:WaitOptions):Promise<WaitResult> {
  const actor=s.requireActor();
  if(!s.get('SELECT id FROM managed_workers WHERE workspace_id=? AND role=?',s.ws,actor) || activeStop(s,[actor],options.stopFile??workspaceSettings(s).stop_file??undefined))return waitForWork(s,options);
  const cursor=options.since??getNotificationProgress(s)?.cursor;
  // Preserve the waiter's existing validation and error without inventing a cursor.
  if(cursor===undefined)return waitForWork(s,options);
  const lease=armManagedWaiter(s,cursor);let result:WaitResult|undefined,failed=false;
  try {result=await waitForWork(s,options);return result;}
  catch(error) {failed=true;throw error;}
  finally {
    try {disarmManagedWaiter(s,lease,result?.cursor);}
    catch(error) {
      // STOP and the original failure remain visible even if a generation froze
      // during cleanup. A later arm must prove this PID gone before reusing the slot.
      if(!failed && result?.reason!=='stop')throw error;
    }
  }
}
