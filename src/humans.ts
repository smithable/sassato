import { type Store } from './storage.js';
import { check, name } from './errors.js';
import { workspaceSettings } from './workspace-settings.js';

/** Use explicit workspace routing; never infer priority from a person's name. */
export function humanRole(s: Store, requested?: string, choice = '--for NAME'): string {
  if (requested !== undefined) {
    const role = name(requested);
    check(s.role(role).kind === 'human', 'Decision recipient must be a human role', 3);
    return role;
  }
  const humans = s.all("SELECT name FROM roles WHERE workspace_id=? AND kind='human' ORDER BY name", s.ws);
  const configured=workspaceSettings(s).default_human;
  if(configured!==null) {check(humans.some(r=>r.name===configured),'Configured default human is unavailable; ask a human to update workspace settings',3);return configured;}
  if (humans.length === 1) return humans[0].name;
  if (s.actor && humans.some(r => r.name === s.actor)) return s.actor;
  check(humans.length, 'This workspace needs a human role', 3);
  check(false, `Several human roles are available; choose one with ${choice}`, 2);
}
