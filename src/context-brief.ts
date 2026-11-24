import type { Store,Row } from './storage.js';
import { feedbackSummary } from './feedback.js';
import type { ContextData } from './coordination.js';
import { check,integer,now } from './errors.js';

/** One physical line, bounded by Unicode code points including its lookup ID. */
export function contextLine(value:unknown,max=200):string {
  return Array.from(String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim()).slice(0,max).join('');
}
function changedTask(s:Store,actor:string,event:Row):Row|undefined {
  if(!/^T\d+$/.test(event.entity_id))return undefined;
  let detail:Row;try{detail=JSON.parse(event.detail);}catch{return undefined;}
  const before=detail?.before??{},after=detail?.after??detail??{};
  if(!['created','imported'].includes(event.action)&&!['status','owner','for_role','priority','reviewed_by'].some(key=>before[key]!==after[key]))return undefined;
  const row=s.get('SELECT id,title,status,owner,for_role,creator,version,human_only FROM tasks WHERE workspace_id=? AND id=?',s.ws,Number(event.entity_id.slice(1)));
  if(!row)return undefined;
  const relevant=[row.owner,row.for_role,row.creator,before.owner,before.for_role].includes(actor)||(!row.owner&&(!row.for_role||row.for_role===actor)&&(!row.human_only||s.role(actor).kind==='human'));
  return relevant?{id:event.entity_id,title:contextLine(row.title,200),status:row.status,owner:row.owner,version:row.version}:undefined;
}
function change(s:Store,actor:string,event:Row):{section:string;row:Row}|undefined {
  if(event.entity==='task') {const row=changedTask(s,actor,event);return row?{section:'tasks',row}:undefined;}
  if(event.entity==='message'&&event.action==='sent'&&/^M\d+$/.test(event.entity_id)) {
    const row=s.get('SELECT m.sender,substr(m.body,1,200) AS text,m.task_id,r.state FROM messages m JOIN receipts r ON r.workspace_id=m.workspace_id AND r.message_id=m.id WHERE m.workspace_id=? AND m.id=? AND r.recipient=?',s.ws,Number(event.entity_id.slice(1)),actor);
    if(row)return {section:'mail',row:{id:event.entity_id,from:row.sender,task:row.task_id?`T${row.task_id}`:null,state:row.state,text:contextLine(row.text)}};
  }
  if(event.entity==='fact'&&/^F\d+$/.test(event.entity_id)) {
    const row=s.get('SELECT key,substr(body,1,200) AS text,version,expires_at FROM facts WHERE workspace_id=? AND id=? AND (expires_at IS NULL OR expires_at>=?)',s.ws,Number(event.entity_id.slice(1)),now());
    if(row){const {expires_at,...rest}=row;return {section:'facts',row:{id:event.entity_id,...rest,text:contextLine(row.text),until:expires_at?String(expires_at).endsWith('T23:59:59.999Z')?String(expires_at).slice(0,10):expires_at:null}};}
  }
  if(event.entity==='question'&&event.action==='answered'&&/^H\d+$/.test(event.entity_id)) {
    const row=s.get("SELECT q.task_id,substr(q.answer,1,200) AS answer FROM questions q JOIN tasks t ON t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE q.workspace_id=? AND q.id=? AND q.status='answered' AND (q.asked_by=? OR t.owner=?)",s.ws,Number(event.entity_id.slice(1)),actor,actor);
    if(row)return {section:'answers',row:{id:event.entity_id,task:`T${row.task_id}`,answer:contextLine(row.answer)}};
  }
  return undefined;
}
/** Event-ordered paging: never cross a notification omitted from this page. No receipts are consumed. */
export function contextDelta(s:Store,options:{since:number;limit?:number;lineLength?:number}):ContextData {
  const actor=s.requireActor(),since=integer(options.since,'since cursor'),count=integer(options.limit??20,'context limit',1,100),lineLength=integer(options.lineLength??200,'line length',80,500);
  return s.snapshot(()=>{
    const latest=Number(s.get('SELECT coalesce(max(id),0) AS n FROM events WHERE workspace_id=?',s.ws)!.n);
    check(since<=latest,'Cursor is ahead of this workspace; check the workspace or reset --since');
    const data:ContextData={workspace:s.workspace,role:actor,permissions:'Facts never grant permission.',cursor:since,snapshot_cursor:latest,since,truncated:false,counts_are_lower_bounds:false,counts:{},sections:{},brief:true,delta:true,line_length:lineLength};
    const stop=s.get('SELECT id,acknowledged_at FROM stop_requests WHERE workspace_id=? AND role=? AND cleared_at IS NULL',s.ws,actor);
    if(stop)data.sections.stop=[{id:`R${stop.id}`,instruction:stop.acknowledged_at?'Stay stopped until a human resumes work.':`Stop new work; finish tools, checkpoint, then sas stopped R${stop.id} --as ${actor}.`}];
    const seen=new Map<string,Row>();
    const events=s.all('SELECT id,entity,entity_id,actor,action,detail FROM events WHERE workspace_id=? AND id>? ORDER BY id LIMIT 2000',s.ws,since);
    for(const event of events) {
      const item=change(s,actor,event),key=item?`${item.section}:${item.row.id}`:'';
      if(item&&!seen.has(key)&&seen.size>=count){data.truncated=true;break;}
      if(item) {
        const prior=seen.get(key);
        if(prior)Object.assign(prior,item.row,{event_id:event.id});
        else {const row={...item.row,event_id:event.id};seen.set(key,row);(data.sections[item.section]??=[]).push(row);}
      }
      data.cursor=event.id;
    }
    if(data.cursor<latest)data.truncated=true;
    const feedback=feedbackSummary(s,actor);
    if(feedback)data.sections.feedback=[feedback];
    data.counts.facts_unchanged=Number(s.get("SELECT count(*) AS n FROM facts f WHERE f.workspace_id=? AND NOT EXISTS(SELECT 1 FROM events e WHERE e.workspace_id=f.workspace_id AND e.entity='fact' AND e.entity_id='F'||f.id AND e.id>?)",s.ws,since)!.n);
    for(const [key,rows] of Object.entries(data.sections))data.counts[key]=rows.length;
    return data;
  });
}
