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

/**
 * A WIP or checkpoint that says it waits on a human, with no question recorded, hides the wait
 * from the human's queue (T1085). One warning line per field that does; a field that names a
 * question (H12) or points to the humans command is taken as recorded. Never a refusal.
 */
export function humanWaits(s: Store, fields: Record<string, string | undefined>): string[] {
  const humans: string[] = s.all("SELECT name FROM roles WHERE workspace_id=? AND kind='human' ORDER BY name", s.ws).map(r => r.name);
  const warnings: string[] = [];
  for (const [flag, value] of Object.entries(fields)) {
    if (!value || /\bH[0-9]+\b|\bhumans --for\b/.test(value)) continue;
    // Within one sentence: the separators between words never cross . ! ? ; or a line break.
    const who = humans.find(human => new RegExp(`\\b(?:waiting on|waits on|wait(?:ing)? for)[^\\w.!?;\\n]+(?:[\\w'-]+[^\\w.!?;\\n]+){0,3}?${human.replace(/[^a-z0-9]/gi, c => `\\${c}`)}(?![\\w-])`, 'i').test(value));
    if (who) warnings.push(`--${flag} names a wait on ${who} with no question recorded: ask it with sas ask-human (--new when it has no task) and point to sas humans --for ${who}`);
  }
  return warnings;
}
