import { check } from './errors.js';

/** Null means inherit the provider's own setting. Undefined preserves an existing role value. */
export interface RoleOptions {
  reasoning_effort?: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
  approval_policy?: string | null;
}
export const ROLE_OPTION_KEYS = ['reasoning_effort','permission_mode','sandbox_mode','approval_policy'] as const;
export function normalizeOption(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 'inherit') return null;
  check(typeof value === 'string', 'Role options must be strings or null');
  return value;
}
export function validateRoleOptions(provider: string | null, options: RoleOptions): void {
  const values = Object.fromEntries(ROLE_OPTION_KEYS.map(key => [key,normalizeOption(options[key])]));
  const allowed: Record<string, readonly string[]> = provider === 'claude' ? {
    reasoning_effort:['low','medium','high','xhigh','max'],
    permission_mode:['manual','default','acceptEdits','auto','bypassPermissions','dontAsk','plan']
  } : provider === 'codex' ? {
    reasoning_effort:['none','minimal','low','medium','high','xhigh','max','ultra'],
    sandbox_mode:['read-only','workspace-write','danger-full-access'],
    approval_policy:['on-request','never']
  } : {};
  for (const key of ROLE_OPTION_KEYS) {
    const value = values[key];
    if (value === null || value === undefined) continue;
    check(key in allowed, `${key} is not supported for provider ${provider ?? '(unset)'}; clear it with inherit`);
    check(allowed[key].includes(value), `Invalid ${key} for ${provider}; choose ${allowed[key].join(', ')} or inherit`);
  }
}
