export class AppError extends Error {
  constructor(message: string, public code = 2) { super(message); this.name = 'AppError'; }
}
export function fail(message: string, code = 2): never { throw new AppError(message, code); }
export function check(condition: unknown, message: string, code = 2): asserts condition { if (!condition) fail(message, code); }
export function text(value: unknown, label = 'text', max = 100_000): string {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label} must be nonempty and at most ${max} characters`);
  check(!value.includes('\0'), `${label} contains NUL`);
  safe(value); return value;
}
export function safe(value: unknown): void {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  check(!/(?:-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16})\b|(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|authorization)["']?\s*[=:]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+\/=-]{16,})/i.test(s), 'Possible secret rejected. Store a file/location reference instead.');
}
export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  check(typeof value === 'number' || (typeof value === 'string' && /^-?[0-9]+$/.test(value)), `${label} must be a decimal integer`);
  const n = typeof value === 'number' ? value : Number(value);
  check(value !== '' && Number.isSafeInteger(n) && n >= min && n <= max, `${label} must be an integer between ${min} and ${max}`); return n;
}
export function id(value: string, prefix: string): number {
  check(new RegExp(`^${prefix}[1-9][0-9]*$`).test(value), `Expected ${prefix}<number>`); return integer(value.slice(1), 'id', 1);
}
export function name(value: unknown): string {
  check(typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value), 'Names must use lowercase letters, digits, underscores or hyphens'); return value;
}
export function now(): string { return new Date().toISOString(); }
