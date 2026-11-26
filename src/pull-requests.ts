// Which pull requests a task's text names, and their state (asked of gh). Used by the ask-human
// guard and a wake's open work. Everything fails open: what cannot be looked up is reported as
// not checked, never as a refusal. Callers look up outside any database transaction.
import { spawnSync } from 'node:child_process';
import type { Row, Store } from './storage.js';

export interface PullRef { repo: string; number: number }
export interface PullState extends PullRef { state: 'OPEN' | 'CLOSED' | 'MERGED'; date: string | null }

const MAX_LOOKUPS = 8, ONE_LOOKUP_MS = 5000;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export const pullName = (pull: PullRef) => `${pull.repo}#${pull.number}`;

/** A GitHub URL or owner/repo#N is taken as written. `name #N` needs the name in the workspace's
 * pull_repositories. A bare #N is the repository the text names, when it names exactly one of
 * those; else the one under the key "#", the default; else none. */
export function pullRefs(text: string, repositories: Record<string, string>): PullRef[] {
  return readReferences(text, repositories).refs;
}

/** The pull requests found, and whether some #N could not be given a repository. */
export function readReferences(text: string, repositories: Record<string, string>): { refs: PullRef[]; unresolved: boolean } {
  const names = new Map(Object.entries(repositories).map(([name, repo]) => [name.toLowerCase(), repo]));
  const known = (word: string) => names.get(word.toLowerCase()) ?? [...names.values()].find(repo => repo.toLowerCase() === word.toLowerCase());
  const mentioned = new Set((text.match(/[\w./-]+/g) ?? []).flatMap(word => known(word.replace(/[./-]+$/, '')) ?? []));
  const bare = mentioned.size === 1 ? [...mentioned][0] : names.get('#');
  const found = new Map<string, PullRef>();
  let unresolved = false;
  const add = (repo: string | undefined, number: string) => {
    if (!repo) unresolved = true;
    else found.set(`${repo.toLowerCase()}#${Number(number)}`, { repo, number: Number(number) });
  };
  for (const m of text.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})(?![\w-])/g)) if (REPOSITORY.test(m[1])) add(m[1], m[2]);
  for (const m of text.matchAll(/#(\d{1,7})(?![\w-])/g)) {
    const before = text.slice(Math.max(0, m.index - 160), m.index);
    const attached = /[\w./-]+$/.exec(before)?.[0];
    if (attached && attached.toLowerCase() !== 'pr') {
      add(known(attached) ?? (REPOSITORY.test(attached) ? attached : undefined), m[1]);
      continue;
    }
    const spaced = /([\w./-]+)[ \t]+(?:(?:PR|pull request)[ \t]*)?$/i.exec(before)?.[1];
    add((spaced && known(spaced)) || bare, m[1]);
  }
  return { refs: [...found.values()], unresolved };
}

/** The task's title, body and notes, as one text. */
export function taskText(s: Store, task: Row): string {
  const notes = s.all("SELECT detail FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND action='note' ORDER BY id", s.ws, `T${task.id}`)
    .map((e) => { try { return String(JSON.parse(e.detail).note ?? ''); } catch { return ''; } });
  return [task.title, task.body ?? '', ...notes].join('\n');
}

// 'unavailable': gh cannot answer at all (missing, hung or signed out), so asking again is no use.
function pullState(pull: PullRef, timeout: number): PullState | 'unavailable' | undefined {
  const run = spawnSync('gh', ['pr', 'view', String(pull.number), '-R', pull.repo, '--json', 'state,mergedAt,closedAt'],
    { encoding: 'utf8', timeout, killSignal: 'SIGKILL', shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (run.error || run.status === 4) return 'unavailable';
  if (run.status !== 0) return undefined;
  try {
    const { state, mergedAt, closedAt } = JSON.parse(run.stdout);
    if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') return undefined;
    const date = state === 'MERGED' ? mergedAt : state === 'CLOSED' ? closedAt : null;
    return { ...pull, state, date: typeof date === 'string' ? date.slice(0, 10) : null };
  } catch { return undefined; }
}

/** The states, newest numbers first, within a total time budget; the rest are counted as unchecked. */
export function lookupPulls(refs: PullRef[], budgetMs: number): { states: PullState[]; unchecked: PullRef[] } {
  const end = Date.now() + budgetMs, states: PullState[] = [], unchecked: PullRef[] = [];
  let unavailable = false;
  [...refs].sort((a, b) => b.number - a.number).forEach((pull, i) => {
    const left = end - Date.now();
    const state = i < MAX_LOOKUPS && !unavailable && left > 0 ? pullState(pull, Math.min(left, ONE_LOOKUP_MS)) : undefined;
    if (state && state !== 'unavailable') states.push(state);
    else {
      unchecked.push(pull);
      unavailable ||= state === 'unavailable';
    }
  });
  return { states, unchecked };
}
