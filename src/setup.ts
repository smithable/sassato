import { existsSync } from 'node:fs';
import { Store, type Row } from './storage.js';
import { initWorkspace } from './admin.js';
import { launch, planLaunch, type LaunchOptions } from './launch.js';
import { AppError, name } from './errors.js';
import { loadConfig } from './config.js';

export interface SetupOptions {
  database: string; workspace: string; actor?: string; config?: string | Row; humans?: string[];
  launchRoles?: string[]; launchOptions?: LaunchOptions; dryRun?: boolean;
}
/** Validate in memory and read existing state without mutating coordination data, including on first use. */
function preview(options: SetupOptions): Row {
  name(options.workspace);
  const candidate=new Store(':memory:',options.actor,{create:true});
  let existing: Store | undefined;
  try {
    const proposed=initWorkspace(candidate,options.workspace,options.config,options.humans);
    let state=candidate, result=proposed;
    if(existsSync(options.database)) {
      existing=new Store(options.database,options.actor,{readonly:true});
      if(existing.get('SELECT id FROM workspaces WHERE name=?',options.workspace)) {
        existing.use(options.workspace);state=existing;
        result={workspace:options.workspace,created:false,roles:existing.all('SELECT * FROM roles WHERE workspace_id=? ORDER BY name',existing.ws)};
      }
    }
    if(options.launchRoles && !options.dryRun) state.requireHuman();
    const plans=options.launchRoles ? state.snapshot(()=>planLaunch(state,options.launchRoles!,options.launchOptions)) : undefined;
    return {...result,launch:plans};
  } finally {existing?.close();candidate.close();}
}
export async function setup(options: SetupOptions): Promise<Row> {
  if(typeof options.config === 'string') options={...options,config:loadConfig(options.config)};
  // Validate even plain init before creating a database.
  const checked=preview(options);
  if(options.dryRun) return {...checked,created:false,would_create:checked.created,dry_run:true};
  const s=new Store(options.database,options.actor,{create:true});
  try {
    const result=initWorkspace(s,options.workspace,options.config,options.humans);
    if(!options.launchRoles) return result;
    try {return {...result,launch:await launch(s,options.launchRoles,options.launchOptions)};}
    catch(error) {
      throw new AppError(`Workspace ${options.workspace} is initialized, but launch did not complete: ${error instanceof Error?error.message:'Unknown failure'}. Check sessions and retry with sassato launch.`,error instanceof AppError?error.code:1);
    }
  } finally {s.close();}
}
