import { type Store, type Row } from './storage.js';
import { check } from './errors.js';
import { updateTask } from './tasks.js';
import { assertWorkAllowed } from './control.js';

function readableTitle(body:string):string|null {
  const line=body.trim().split(/\r?\n/)[0];
  if (!/^\((?:done|closed|moved|built|merged|taken|stopped|ready|blocked|waiting|waits|open|hold|superseded)\b/i.test(line)) return null;
  let depth=0;
  for(let i=0;i<line.length;i++) {
    if(line[i]==='(')depth++;
    if(line[i]===')'&&--depth===0) {
      const title=line.slice(i+1).replace(/^\s*[:;–—-]?\s*/,'').trim();
      return title ? title.slice(0,500) : null;
    }
  }
  return null; // Never guess where a truncated or ambiguous status prefix ends.
}

/** Conservative cleanup of active imported titles, scoped to one owner. */
export function retitleImportedTasks(s:Store, options:{owner?:string;apply?:boolean}={}):Row[] {
  const run=()=>{
    const actor=s.requireActor(),owner=options.owner??actor;
    s.role(owner);
    check(owner===actor||s.role(actor).kind==='human','Only a human may retitle another role\'s tasks',3);
    if(options.apply)assertWorkAllowed(s,actor);
    const rows=s.all("SELECT t.* FROM tasks t WHERE t.workspace_id=? AND t.owner=? AND t.status NOT IN ('done','dropped') AND EXISTS (SELECT 1 FROM import_items i WHERE i.workspace_id=t.workspace_id AND i.task_id=t.id) ORDER BY t.id",s.ws,owner);
    const result:Row[]=[];
    for(const row of rows) {
      if(row.human_only&&s.role(actor).kind!=='human')continue;
      // A human or agent may have deliberately revised the heading or source
      // body. Leave such work alone even when its new title starts with '('.
      if(s.get("SELECT 1 FROM events WHERE workspace_id=? AND entity='task' AND entity_id=? AND (json_type(detail,'$.after.title') IS NOT NULL OR json_type(detail,'$.after.body') IS NOT NULL) LIMIT 1",s.ws,`T${row.id}`))continue;
      const title=readableTitle(row.body);
      if(!title||title===row.title||!row.title.startsWith('('))continue;
      result.push({id:`T${row.id}`,before:row.title,title,version:row.version,applied:!!options.apply});
      if(options.apply)updateTask(s,`T${row.id}`,{version:row.version,title});
    }
    return result;
  };
  return options.apply?s.tx(run):s.snapshot(run);
}
