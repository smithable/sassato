#!/usr/bin/env node
// Checks the sassato command lines in instruction files against a build's own parser tables.
// It reads files and prints a report; it runs no command and opens no database.
//
//   node scripts/check-instructions.mjs [--build DIR] [--roles a,b --workspace W [--db PATH]] [--unused] [--json] FILE...
//
// FILE: every `sas …`/`sassato …` in code spans and fenced blocks of a Markdown file is checked; in prose,
// and in any other file, only one that names a command of the build (so "a sassato fact is" is not). --build: the sassato package to check against (default: this repository, built).
// --roles: also read each role's start prompt from the build's `launch ROLE --dry-run --json`, run on a
// migrated copy of the database (--db, else the build's default), so the real one is never written.
// --unused: list the build's commands, and the flags of used commands, that no source mentions.
// Exit 0 when every line parses, 1 when one does not or a source cannot be read, 2 on a usage error.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';

const usage = (message) => { console.error(`${message}\nUsage: check-instructions.mjs [--build DIR] [--roles a,b --workspace W [--db PATH]] [--unused] [--json] FILE...`); process.exit(2); };
let opts;
try {
  opts = parseArgs({ allowPositionals: true, options: { build: { type: 'string' }, roles: { type: 'string' }, workspace: { type: 'string' }, db: { type: 'string' }, unused: { type: 'boolean' }, json: { type: 'boolean' } } });
} catch (error) { usage(error.message); }
const { values, positionals: files } = opts;
if (!files.length && !values.roles) usage('Name at least one file or --roles.');
const build = resolve(values.build ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
if (!existsSync(join(build, 'dist/cli.js'))) usage(`No built sassato at ${build} (dist/cli.js); run npm run build there.`);
const cli = await import(pathToFileURL(join(build, 'dist/cli.js')).href);
const info = JSON.parse(readFileSync(join(build, 'dist/build-info.json'), 'utf8'));
// Builds before commandGroups was exported resolve these groups in main() (schedule came after the export).
const groups = cli.commandGroups ?? ['workspace', 'role', 'fact', 'rule', 'feedback', 'topic', 'session', 'job', 'checkout', 'brief', 'index', 'codex'];
const options = Object.fromEntries([...cli.strings.map((n) => [n, { type: 'string' }]), ...cli.booleans.map((n) => [n, { type: 'boolean' }])]);
options.help = { ...options.help, short: 'h' };

/** Splits one command line into words as a shell would, stopping at a pipe, a list or a redirect. */
export function words(text) {
  const line = text.replace(/<[^<>\s][^<>]*>/g, 'PLACEHOLDER'), out = []; let word = '', quote = '', started = false, tail = null;
  // tail: what followed the last closing quote, so punctuation there still ends a sentence.
  const push = () => { if (started) out.push(Object.assign(new String(word), { tail })); word = ''; started = false; tail = null; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < line.length) word += line[++i];
      else if (c === quote) { quote = ''; tail = ''; } else word += c;
      continue;
    }
    if (opens(line, i)) { quote = c; started = true; continue; }
    if (tail !== null && !/\s/.test(c)) tail += c;
    if (/\s/.test(c)) { push(); continue; }
    if ('|;&<>)`#'.includes(c) && !(c === '|' && /^--[\w-]+$/.test(word) && line[i + 1] === '-')) { push(); return out; }
    word += c; started = true;
  }
  push();
  return out;
}

/** The words of a command line, ending at the first word that closes a sentence or a clause. */
function trimmed(ws) {
  const out = [];
  for (const w of ws) {
    if (w.tail !== null) {
      const end = /[.,:;]+$/.exec(w.tail);
      if (end) { out.push(String(w).slice(0, w.length - end[0].length)); break; }
      out.push(String(w)); continue;
    }
    const m = /^(.*?)([.,:;]+)$/.exec(w);
    if (m) { if (m[1]) out.push(m[1]); break; }
    out.push(String(w));
  }
  return out;
}

/** A quote opens a quoted word; an apostrophe inside a word ("don't") does not. */
function opens(text, i) {
  return (text[i] === '"' || text[i] === "'") && (i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]) || text[i] === '"');
}

/** Where each `sas` in a text starts outside quotes, as a shell would read them. */
function unquoted(part) {
  const at = new Set(); let quote = '';
  for (let i = 0; i < part.length; i++) {
    if (quote) {
      if (quote === '"' && part[i] === '\\') i++;
      else if (part[i] === quote) quote = '';
      continue;
    }
    if (opens(part, i)) quote = part[i]; else at.add(i);
  }
  return at;
}

/** Every `sas …` line in a text, marked `code` when in a code span or a fenced block. */
export function commandLines(text, prose) {
  const found = [], lines = text.split('\n'); let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], n = i + 1;
    if (!prose && /^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    let parts;
    if (fenced) {
      // A shell line continued with a backslash is one command.
      let joined = line;
      // An odd run of backslashes continues the line; the shell drops the backslash and the newline.
      while (/(^|[^\\])(\\\\)*\\$/.test(joined) && i + 1 < lines.length && !/^\s*(```|~~~)/.test(lines[i + 1])) joined = joined.slice(0, -1) + lines[++i];
      parts = [[joined, true, joined.length]];
    } else {
      parts = line.split('`').map((part, k) => [part, k % 2 === 1, part.length]);
      // Prose wraps: a command in the last prose part of a line reads on into the next line's prose.
      const last = parts.at(-1), next = lines[i + 1];
      if (!last[1] && next !== undefined && (prose || !/^\s*(```|~~~)/.test(next))) last[0] += ` ${next.split('`')[0].trim()}`;
    }
    for (const [part, code, own] of parts) {
      const outside = unquoted(part);
      for (const m of part.matchAll(/(?:^|[\s($=])(?:sas|sassato) +(?=[a-z-])/g)) {
        const start = m.index + m[0].search(/s/);
        if (start >= own) break;
        if (!outside.has(start)) continue;
        const ws = trimmed(words(part.slice(m.index + m[0].length)));
        if (ws.length) found.push({ line: n, code, args: ws, text: `${m[0].trim()} ${ws.join(' ')}` });
      }
    }
  }
  return found;
}

/** Each way to read `--a|--b` alternatives, one flag at a time; brackets around optional words are dropped. */
function variants(args) {
  let out = [[]];
  for (const raw of args) {
    const w = raw.replace(/^\[+/, '').replace(/\]+$/, '');
    if (!w) continue;
    const alts = /^--[\w-]+(\|--[\w-]+)+$/.test(w) ? w.split('|') : [w];
    out = out.flatMap((v) => alts.map((a) => [...v, a])).slice(0, 16);
  }
  return out;
}

/** The parser's verdict on one command line: null when it parses, else the reason. */
export function verdict(args) {
  for (const argv of variants(args)) {
    let parsed;
    try { parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true }); } catch (error) { return error.message.split('\n')[0]; }
    const v = parsed.values, p = [...parsed.positionals];
    if (v.help || v.version || !p.length) continue;
    // As main() reads the command; keep in step with src/cli.ts.
    let command = p.shift();
    if (command === 'task') command = p.shift() ?? 'tasks';
    if (groups.includes(command)) command += ' ' + (p.shift() ?? '');
    if (command === 'supervise') command += ' ' + (p.shift() ?? (v.attended ? 'attended' : 'status'));
    if (command === 'checkpoint' || command === 'progress') command += ' ' + (p.shift() ?? 'show');
    if (command === 'wip') command += ' ' + (p[0] === 'show' || p[0] === 'set' ? p.shift() : 'show');
    if (!(command in cli.allowed)) return `Unknown command ${command}`;
    for (const key of Object.keys(v)) if (!cli.globalFlags.includes(key) && !cli.allowed[command].includes(key)) return `--${key} does not apply to ${command}`;
    used.add(command); for (const key of Object.keys(v)) used.add(`${command} --${key}`);
  }
  return null;
}

const used = new Set(), failures = [], unreadable = []; let checked = 0;
const sources = files.map((f) => ({ name: f, read: () => readFileSync(f, 'utf8'), prose: !/\.md$/i.test(f) }));
const roles = (values.roles ?? '').split(',').filter(Boolean);
let copy;
if (roles.length) {
  // A newer build reads an older schema only after a write migrates it: migrate a copy, never the original.
  const { databasePath } = await import(pathToFileURL(join(build, 'dist/storage.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'sassato-check-')), source = new DatabaseSync(databasePath(values.db), { readOnly: true });
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  copy = join(dir, 'copy.db');
  await backup(source, copy); source.close();
  const m = spawnSync(process.execPath, [join(build, 'bin/sassato.js'), 'migrate', '--db', copy], { encoding: 'utf8' });
  if (m.status !== 0) usage(`Could not migrate the copy of the database: ${(m.stderr || m.stdout).trim()}`);
}
for (const role of roles) {
  sources.push({ name: `start prompt of ${role}`, prose: true, read: () => {
    const r = spawnSync(process.execPath, [join(build, 'bin/sassato.js'), 'launch', role, '--dry-run', '--json', '--db', copy, ...(values.workspace ? ['--workspace', values.workspace] : [])], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n')[0]);
    return JSON.parse(r.stdout).flatMap((x) => x.args ?? []).join('\n');
  } });
}
for (const s of sources) {
  let text;
  try { text = s.read(); } catch (error) { unreadable.push({ source: s.name, reason: error.message }); continue; }
  for (const c of commandLines(text, s.prose)) {
    const reason = verdict(c.args);
    if (!c.code && reason?.startsWith('Unknown command')) continue;
    checked++;
    if (reason) failures.push({ source: s.name, line: c.line, command: c.text, reason });
  }
}
const unused = values.unused ? Object.keys(cli.allowed).flatMap((c) => used.has(c) ? cli.allowed[c].filter((f) => !used.has(`${c} --${f}`)).map((f) => `${c} --${f}`) : [c]) : undefined;
const report = { build: `${info.version} (build ${info.build})`, sources: sources.length, checked, failures, unreadable, ...(unused ? { unused } : {}) };
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Checked ${checked} command lines in ${sources.length - unreadable.length} of ${sources.length} sources against sassato ${report.build}.`);
  for (const f of failures) console.log(`FAIL ${f.source}:${f.line}  ${f.command}\n     ${f.reason}`);
  for (const u of unreadable) console.log(`UNREADABLE ${u.source}: ${u.reason}`);
  if (unused) console.log(`Not mentioned in any source (${unused.length}):\n  ${unused.join('\n  ')}`);
  if (!failures.length && !unreadable.length) console.log('Every command line parses.');
}
process.exitCode = failures.length || unreadable.length ? 1 : 0;
