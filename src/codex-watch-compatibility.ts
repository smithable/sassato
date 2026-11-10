/** Add a release only after rerunning the isolated watcher validation checklist. */
export const TESTED_CODEX_WATCH_VERSIONS:readonly string[]=['0.167.0'];

/** Notices are allowed, but exactly one unambiguous version line must match. */
export function testedCodexWatchVersion(stdout:string):string|undefined {
  const versions=stdout.split(/\r?\n/).flatMap(line=>{
    const match=/^codex(?:-cli)? ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s]+)?)$/.exec(line.trim());
    return match?[match[1]]:[];
  });
  return versions.length===1&&TESTED_CODEX_WATCH_VERSIONS.includes(versions[0])?versions[0]:undefined;
}
