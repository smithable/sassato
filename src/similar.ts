import { type Row, type Store } from './storage.js';

/**
 * Shared words between texts, no model: so a question is not asked again by someone who did not
 * look, and a human's task an answer has made moot is not left open. Words weigh more the rarer
 * they are among the candidates; the score is the cosine of the two word sets (0 to 1).
 */
const DAYS = 30, SHOWN = 3, SHARED = 4;
// A question refuses at ASKED. A task is only named after an answer; task bodies are long and
// score lower.
const ASKED = 0.25, MOOT = 0.12;
const COMMON = new Set('the and for are was were been being have has had not yes that this these those with from into over about after before then than when where how what which who why should shall may can will would does did done its our your his her their them they you but only just also any all each other out now one two more here there both same new old once never ever still yet'.split(' '));

function words(text: string): Set<string> {
  const found = new Set<string>();
  for (let word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length < 3 || /^\d+$/.test(word) || COMMON.has(word)) continue;
    const suffix = ['ing', 'es', 'ed', 's'].find(s => word.endsWith(s) && word.length - s.length >= 4);
    if (suffix) word = word.slice(0, -suffix.length);
    found.add(word);
  }
  return found;
}

/** The candidates that share enough with the text, closest first. */
function closest<T>(text: string, candidates: T[], textOf: (candidate: T) => string, floor: number): T[] {
  const sets = candidates.map(c => words(textOf(c))), count = new Map<string, number>();
  for (const set of sets) for (const word of set) count.set(word, (count.get(word) ?? 0) + 1);
  const weight = (word: string) => Math.log(1 + (candidates.length + 1) / (1 + (count.get(word) ?? 0)));
  const total = (set: Iterable<string>) => [...set].reduce((sum, word) => sum + weight(word), 0);
  const own = words(text), ownTotal = total(own);
  return candidates.map((candidate, i) => {
    const shared = [...own].filter(word => sets[i].has(word));
    return { candidate, shared: shared.length, score: total(shared) / Math.sqrt(ownTotal * total(sets[i]) || 1) };
  }).filter(m => m.shared >= SHARED && m.score >= floor).sort((a, b) => b.score - a.score).slice(0, SHOWN).map(m => m.candidate);
}

/**
 * Pending questions, and those answered in the last 30 days, that look like the one about to be
 * asked. An answered question on the same task is left out: its asker holds that task and is
 * following it up.
 */
export function similarQuestions(s: Store, task: { id: number; title: string }, question: string): Row[] {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows = s.all("SELECT q.id,q.task_id,q.question,q.status,q.answer,q.created_at,q.answered_at,t.title FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND (q.status='pending' OR (q.status='answered' AND q.answered_at>=? AND q.task_id!=?)) ORDER BY q.id", s.ws, since, task.id);
  return closest(`${task.title} ${question}`, rows, r => `${r.title} ${r.question}`, ASKED);
}

/**
 * One line for each open human task (with no pending question of its own) that shares words with
 * the answer just recorded to a question: it may be settled or overtaken now.
 */
export function mootWarnings(s: Store, questionId: string): string[] {
  const answered = s.get('SELECT q.task_id,q.question,q.answer,t.title FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND q.id=?', s.ws, Number(questionId.slice(1)))!;
  const rows = s.all("SELECT t.id,t.title,t.body FROM tasks t WHERE t.workspace_id=? AND t.id!=? AND t.status NOT IN ('done','dropped') AND (t.human_only=1 OR EXISTS (SELECT 1 FROM roles r WHERE r.workspace_id=t.workspace_id AND r.kind='human' AND r.name IN (t.for_role,t.owner))) AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.workspace_id=t.workspace_id AND q.task_id=t.id AND q.status='pending') ORDER BY t.id", s.ws, answered.task_id);
  return closest(`${answered.title} ${answered.question} ${answered.answer}`, rows, r => `${r.title} ${r.body ?? ''}`, MOOT)
    .map(r => `T${r.id} is an open human task that shares words with this answer: ${r.title.replace(/\s+/g, ' ')}. If the answer settles it, close or rewrite it.`);
}
