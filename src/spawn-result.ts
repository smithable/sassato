/**
 * Codex's read-only Linux sandbox makes every spawnSync report EPERM after the child ran and exited (T1258): its exit
 * status and output are real. Only that case is forgiven, and only for read-only Git probes; a child that did not run,
 * timed out or overflowed its buffer has no exit status or was killed by a signal, and stays an error.
 */
export function spawnError(result: { error?: Error; status: number | null; signal: NodeJS.Signals | null }): Error | undefined {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' && typeof result.status === 'number' && result.signal === null ? undefined : result.error;
}
