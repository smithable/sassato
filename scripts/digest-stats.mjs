// T977: which digest entry kinds each role got over the last days, from the event history, as the waiter
// decides them. Read-only: run it on a copy of the database. Urgent mail is counted from the messages.
// node scripts/digest-stats.mjs <db> <workspace> [days=3]
import { Store } from '../dist/storage.js';
import { digestKindOf } from '../dist/mail-wait.js';
const [db, workspace, days = '3'] = process.argv.slice(2);
const s = new Store(db, 'johan', { readonly: true }); s.use(workspace);
const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
const roles = s.all("SELECT name FROM roles WHERE workspace_id=? AND kind!='human' ORDER BY name", s.ws).map((r) => r.name);
const events = s.all('SELECT id,entity,entity_id,actor,action,detail FROM events WHERE workspace_id=? AND created_at>=? ORDER BY id', s.ws, since);
const out = {};
for (const role of roles) {
  const counts = {};
  for (const e of events) {
    let k; try { k = digestKindOf(s, role, e); } catch { continue; }
    if (!k) continue;
    const key = `${k.kind}${k.wakes ? '' : ' (extra)'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const urgent = s.get("SELECT count(*) n FROM receipts r JOIN messages m ON m.workspace_id=r.workspace_id AND m.id=r.message_id WHERE r.workspace_id=? AND r.recipient=? AND m.urgent=1 AND m.created_at>=?", s.ws, role, since).n;
  out[role] = { ...counts, urgent };
}
console.log(JSON.stringify({ since, events: events.length, roles: out }, null, 1));
