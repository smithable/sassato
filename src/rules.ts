// Rules in sassato (T1276; design: the T1215 note, version 2, authority A). Anyone proposes a rule
// or its retirement; the proposal is fixed once made and asks the human question itself. The
// answer to that question decides it: given by the human, or relayed by a role named in the
// workspace's rule_relays, and refused from any other relay. An approval is refused when the rule
// moved since the proposal's base version. Each approval adds one row to rule_versions, whose
// number in the workspace is the version of the set, and writes the set in force to a file beside
// the database before the change commits, so the copy outside is never behind the database.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Store, type Row } from './storage.js';
import { check, id, integer, now, text } from './errors.js';
import { workspaceSettings } from './workspace-settings.js';
import { addTask, askHuman, withdrawQuestion } from './tasks.js';

export const RULE_KINDS = ['always', 'step'] as const;
export type RuleKind = typeof RULE_KINDS[number];
/** Longest text of one rule, and of every always rule together: the always set is read at every start. */
export const RULE_MAX: Record<RuleKind, number> = { always: 3000, step: 6000 };
export const ALWAYS_SET_MAX = 40_000;
const OPTIONS = ['approve', 'reject'];

function ruleKey(value: string): string {
  check(typeof value === 'string' && value.length <= 80 && /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/.test(value), 'A rule key is lowercase words joined by dots (decisions.fast-mode), at most 80 characters');
  return value;
}
function kindOf(value: string): RuleKind {
  check((RULE_KINDS as readonly string[]).includes(value), `A rule's kind is one of: ${RULE_KINDS.join(', ')}`);
  return value as RuleKind;
}
function scopeOf(s: Store, value = 'all'): string { if (value !== 'all') s.role(value); return value; }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const firstLine = (value: string): string => value.split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? '';

function latest(s: Store, key: string): Row | undefined {
  return s.get('SELECT * FROM rule_versions WHERE workspace_id=? AND key=? ORDER BY version DESC LIMIT 1', s.ws, key);
}
function inForce(s: Store, forRole?: string): Row[] {
  return s.all(`SELECT v.* FROM rule_versions v WHERE v.workspace_id=? AND v.status='in-force'
    AND v.version=(SELECT max(w.version) FROM rule_versions w WHERE w.workspace_id=v.workspace_id AND w.key=v.key)
    AND (? IS NULL OR v.scope IN ('all',?)) ORDER BY v.key`, s.ws, forRole ?? null, forRole ?? null);
}
function setVersion(s: Store): number { return Number(s.get('SELECT coalesce(max(set_version),0) AS n FROM rule_versions WHERE workspace_id=?', s.ws)!.n); }
function alwaysLength(s: Store, besides: string): number {
  return inForce(s).filter(r => r.kind === 'always' && r.key !== besides).reduce((sum, r) => sum + r.text.length, 0);
}
const versionView = (r: Row): Row => ({ key: r.key, version: r.version, status: r.status, scope: r.scope, kind: r.kind, text: r.text, set_version: r.set_version, proposal: `P${r.proposal_id}`, approved_by: r.approved_by, relayed_by: r.relayed_by, created_at: r.created_at });
const proposalView = (r: Row): Row => ({ ...r, id: `P${r.id}`, task_id: `T${r.task_id}`, question_id: `H${r.question_id}` });

/** The rules in force (for one role: those for all and those for it), with the set's version and digest. */
export function ruleSet(s: Store, forRole?: string): Row {
  return s.snapshot(() => {
    if (forRole !== undefined) s.role(forRole);
    const rules = inForce(s, forRole).map(r => ({ key: r.key, version: r.version, scope: r.scope, kind: r.kind, text: r.text }));
    return { workspace: s.workspace, set_version: setVersion(s), digest: digest(rules), ...(forRole === undefined ? {} : { for_role: forRole }), rules };
  });
}

interface Draft { key: string; action: 'set' | 'retire'; text?: string; reason?: string; scope: string; kind: RuleKind; base: number; forHuman?: string }
function propose(s: Store, d: Draft): Row {
  const actor = s.requireActor(), sum = digest([d.key, d.action, d.text ?? null, d.reason ?? null, d.scope, d.kind, d.base]);
  const who = d.scope === 'all' ? 'every role' : d.scope, short = sum.slice(0, 12);
  const question = d.action === 'set'
    ? `Put rule ${d.key} in force${d.base ? ` in place of its version ${d.base}` : ''} (${d.kind}, for ${who}; digest ${short}), with exactly this text:\n\n${d.text}`
    : `Retire rule ${d.key} (its version ${d.base}, ${d.kind}, for ${who}; digest ${short})? Reason: ${d.reason}`;
  const task = addTask(s, { title: `Rule ${d.key}: ${d.action === 'retire' ? 'retire' : d.base ? 'change' : 'new'}`, body: question, owner: actor, forRole: actor });
  const asked = askHuman(s, task.id, { question, forRole: d.forHuman, options: OPTIONS });
  const n = Number(s.run('INSERT INTO rule_proposals(workspace_id,key,action,text,reason,scope,kind,base_version,digest,proposed_by,task_id,question_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    s.ws, d.key, d.action, d.text ?? null, d.reason ?? null, d.scope, d.kind, d.base, sum, actor, id(task.id, 'T'), id(asked.id, 'H'), now()).lastInsertRowid);
  s.event('rule-proposal', `P${n}`, 'proposed', { key: d.key, action: d.action, base_version: d.base, digest: sum, task: task.id, question: asked.id });
  return { ...proposalView(s.get('SELECT * FROM rule_proposals WHERE id=?', n)!), for_role: asked.for_role };
}

export interface ProposeOptions { scope?: string; kind?: string; forHuman?: string }
export function proposeRule(s: Store, key: string, body: string, options: ProposeOptions = {}): Row {
  s.requireActor(); ruleKey(key);
  const kind = kindOf(options.kind ?? 'always'), ruleText = text(body, 'rule text', RULE_MAX[kind]);
  return s.tx(() => {
    const scope = scopeOf(s, options.scope), base = latest(s, key)?.version ?? 0;
    if (kind === 'always') check(alwaysLength(s, key) + ruleText.length <= ALWAYS_SET_MAX, `The always rules together would pass ${ALWAYS_SET_MAX} characters; shorten one or make this a step rule`);
    return propose(s, { key, action: 'set', text: ruleText, scope, kind, base, forHuman: options.forHuman });
  });
}
export function retireRule(s: Store, key: string, reason: string, options: { forHuman?: string } = {}): Row {
  s.requireActor(); ruleKey(key); text(reason, 'reason', 2000);
  return s.tx(() => {
    const current = latest(s, key); check(current?.status === 'in-force', `No rule ${key} is in force`, 3);
    return propose(s, { key, action: 'retire', reason, scope: current.scope, kind: current.kind, base: current.version, forHuman: options.forHuman });
  });
}
/** Withdraws a pending proposal through its question: its proposer or a human, with a reason. */
export function withdrawRule(s: Store, proposal: string, reason: string): Row {
  return s.tx(() => {
    const p = s.get('SELECT * FROM rule_proposals WHERE workspace_id=? AND id=?', s.ws, id(proposal, 'P'));
    check(p, 'Rule proposal not found in this workspace', 3); check(p.status === 'pending', `Rule proposal ${proposal} is ${p.status}`, 4);
    withdrawQuestion(s, `H${p.question_id}`, reason);
    return proposalView(s.get('SELECT * FROM rule_proposals WHERE id=?', p.id)!);
  });
}

// Called by answerQuestion inside its transaction, for any answered question; undefined when the
// question is not a rule proposal's. A throw refuses the answer as a whole.
export function decideRuleProposal(s: Store, questionId: number, answer: string, actor: string, relayedBy?: string): Row | undefined {
  const p = s.get('SELECT * FROM rule_proposals WHERE workspace_id=? AND question_id=?', s.ws, questionId);
  if (!p) return undefined;
  const relays = workspaceSettings(s).rule_relays ?? [];
  check(relayedBy === undefined || relays.includes(relayedBy), `${relayedBy} may not relay an answer to a rule proposal; the relays are ${relays.length ? relays.join(', ') : 'none'} (workspace set --rule-relays)`, 3);
  check(p.status === 'pending', `Rule proposal P${p.id} is ${p.status}`, 4);
  const approve = /^(?:1: )?approve\b/i.test(answer.trim()), reject = /^(?:2: )?reject\b/i.test(answer.trim());
  check(approve || reject, 'A rule proposal is answered with 1 (approve) or 2 (reject); words after it are kept: answer H1 "approve: his words"');
  const current = latest(s, p.key), at = now();
  let status = 'rejected', decision = answer, version: Row | undefined;
  if (approve && (current?.version ?? 0) !== p.base_version) { status = 'refused'; decision = `Rule ${p.key} moved from version ${p.base_version} to ${current!.version} after this proposal; propose it again`; }
  else if (approve && p.action === 'set' && p.kind === 'always' && alwaysLength(s, p.key) + p.text.length > ALWAYS_SET_MAX) { status = 'refused'; decision = `The always rules together would pass ${ALWAYS_SET_MAX} characters`; }
  else if (approve) {
    status = 'approved';
    const n = Number(s.run('INSERT INTO rule_versions(workspace_id,set_version,key,version,status,text,scope,kind,proposal_id,approved_by,relayed_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      s.ws, setVersion(s) + 1, p.key, p.base_version + 1, p.action === 'set' ? 'in-force' : 'retired', p.text, p.scope, p.kind, p.id, actor, relayedBy ?? null, at).lastInsertRowid);
    version = s.get('SELECT * FROM rule_versions WHERE id=?', n);
  }
  s.run('UPDATE rule_proposals SET status=?,decided_at=?,decided_by=?,relayed_by=?,decision=? WHERE id=?', status, at, actor, relayedBy ?? null, decision, p.id);
  s.event('rule-proposal', `P${p.id}`, status, { key: p.key, decision, ...(relayedBy ? { relayed_by: relayedBy } : {}) });
  if (!version) return { proposal: `P${p.id}`, key: p.key, status, decision };
  s.event('rule', p.key, version.status, { version: version.version, set_version: version.set_version, proposal: `P${p.id}` });
  return { proposal: `P${p.id}`, key: p.key, status, version: version.version, set_version: version.set_version, export: exportRules(s) };
}
// Called by withdrawQuestion inside its transaction.
export function withdrawnRuleProposal(s: Store, questionId: number, reason: string, actor: string): void {
  const p = s.get("SELECT * FROM rule_proposals WHERE workspace_id=? AND question_id=? AND status='pending'", s.ws, questionId);
  if (!p) return;
  s.run("UPDATE rule_proposals SET status='withdrawn',decided_at=?,decided_by=?,decision=? WHERE id=?", now(), actor, reason, p.id);
  s.event('rule-proposal', `P${p.id}`, 'withdrawn', { key: p.key, reason });
}

/** A rule in force with its history and pending proposals, or one proposal (P1) in full. */
export function getRule(s: Store, ref: string): Row {
  return s.snapshot(() => {
    if (/^P[0-9]+$/.test(ref)) {
      const p = s.get('SELECT * FROM rule_proposals WHERE workspace_id=? AND id=?', s.ws, id(ref, 'P'));
      check(p, 'Rule proposal not found in this workspace', 3); return proposalView(p);
    }
    ruleKey(ref);
    const versions = s.all('SELECT * FROM rule_versions WHERE workspace_id=? AND key=? ORDER BY version DESC', s.ws, ref);
    const pending = s.all("SELECT * FROM rule_proposals WHERE workspace_id=? AND key=? AND status='pending' ORDER BY id", s.ws, ref).map(p => ({ id: `P${p.id}`, action: p.action, base_version: p.base_version, proposed_by: p.proposed_by, question_id: `H${p.question_id}` }));
    check(versions.length || pending.length, `No rule ${ref}`, 3);
    const top = versions[0];
    return { key: ref, in_force: top?.status === 'in-force', ...(top ? versionView(top) : { version: 0 }), history: versions.slice(1).map(v => ({ version: v.version, status: v.status, set_version: v.set_version, proposal: `P${v.proposal_id}` })), pending };
  });
}
export interface ListRulesOptions { forRole?: string; pending?: boolean }
/** One line per rule in force; with pending, the proposals that wait too. */
export function listRules(s: Store, options: ListRulesOptions = {}): Row {
  return s.snapshot(() => {
    const set = ruleSet(s, options.forRole);
    const rules = (set.rules as Row[]).map(r => ({ key: r.key, version: r.version, scope: r.scope, kind: r.kind, line: firstLine(r.text) }));
    const pending = options.pending ? s.all("SELECT * FROM rule_proposals WHERE workspace_id=? AND status='pending' ORDER BY id", s.ws).map(p => ({ id: `P${p.id}`, key: p.key, action: p.action, base_version: p.base_version, proposed_by: p.proposed_by, question_id: `H${p.question_id}` })) : undefined;
    return { ...set, rules, ...(pending ? { pending } : {}) };
  });
}
/** What changed in the set since one of its versions, in order, each with the text it replaced. */
export function diffRules(s: Store, since: string | number): Row {
  const from = integer(since, 'set version', 0);
  return s.snapshot(() => {
    const changes = s.all('SELECT * FROM rule_versions WHERE workspace_id=? AND set_version>? ORDER BY set_version', s.ws, from).map(v => {
      const before = s.get('SELECT text,status FROM rule_versions WHERE workspace_id=? AND key=? AND version=?', s.ws, v.key, v.version - 1);
      return { ...versionView(v), previous_text: before?.text ?? null };
    });
    return { from, to: setVersion(s), changes };
  });
}

export function rulesExportPath(databasePath: string, workspace: string): string { return join(dirname(databasePath), 'rules', `${workspace}.json`); }
/** Writes the whole set in force to its file, replacing it at once; a database in memory has none. */
export function exportRules(s: Store): Row | null {
  if (s.path === ':memory:') return null;
  const set = ruleSet(s), path = rulesExportPath(s.path, s.workspace), body = JSON.stringify({ ...set, exported_at: now() }, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`, fd = openSync(temporary, 'w', 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  return { path, set_version: set.set_version, digest: set.digest };
}
/** The export's set version for a workspace, or undefined with no export or one that cannot be read. */
export function exportedSetVersion(databasePath: string, workspace: string): number | undefined {
  const path = rulesExportPath(databasePath, workspace);
  if (!existsSync(path)) return undefined;
  try { const n = JSON.parse(readFileSync(path, 'utf8')).set_version; return Number.isSafeInteger(n) ? n : undefined; } catch { return undefined; }
}
