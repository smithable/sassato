// Internal, fixed-purpose pre-signal probe. No lifecycle writes or signals.
import { fileURLToPath } from 'node:url';
import { observeBusyChecks,validateBusyChecks } from './busy-checks.js';
import { check } from './errors.js';
async function main():Promise<void> {
  const checks=validateBusyChecks(JSON.parse(process.env.SASSATO_ATTENDED_BUSY_CHECKS??'null'));
  check(checks.length>0,'Missing guards are not idle',4);
  check((await observeBusyChecks(checks)).every(row=>row.state==='idle'),'External protected job is busy or unknown',4);
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{process.exitCode=4;});
