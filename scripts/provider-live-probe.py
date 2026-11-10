#!/usr/bin/env python3
"""Opt-in live conversational probes. Uses existing auth and provider defaults.

This invokes real models. It neither tests nor implements a production supervisor.
Only generated temporary work directories and owned subprocesses are controlled.
Normal provider runtime logs may be written by the installed CLIs.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid

def version(provider):
    result=subprocess.run([provider,'--version'],capture_output=True,text=True,timeout=10)
    if result.returncode != 0:
        raise RuntimeError('Provider version probe failed')
    match=re.search(r'\d+\.\d+\.\d+',result.stdout)
    if not match:
        raise RuntimeError('Provider version is unrecognized')
    return match.group(0)


def close_owned(process):
    try:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
    except (BrokenPipeError, ValueError):
        pass
    try:
        return process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        for sig in [signal.SIGTERM,signal.SIGKILL]:
            try:
                os.killpg(process.pid,sig)
            except ProcessLookupError:
                pass
            try:
                return process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                continue
        raise RuntimeError('Owned provider did not exit')


def run_codex():
    root=Path(tempfile.mkdtemp(prefix='sassato-codex-live-'))
    try:
        installed_version=version('codex')
        proc=subprocess.Popen(['codex','app-server','--stdio'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,start_new_session=True)
    except Exception:
        shutil.rmtree(root,ignore_errors=True)
        raise
    q=queue.Queue()
    def pump():
     for line in proc.stdout:
      try:q.put(json.loads(line))
      except:pass
     q.put({'_exited':True})
    def errpump():
     for line in proc.stderr:
      pass
    threading.Thread(target=pump,daemon=True).start();threading.Thread(target=errpump,daemon=True).start()
    report={'provider':'codex','version':installed_version,'started_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'working_directory_is_temporary':True,'ephemeral':True,'events':[]}
    seq=0
    pending=[]
    def recv(deadline):
     left=deadline-time.monotonic()
     if left<=0:raise TimeoutError('Provider event deadline exceeded')
     obj=q.get(timeout=left)
     if '_exited' in obj:raise RuntimeError('Provider process exited before completion')
     if 'method' in obj and 'id' in obj:raise RuntimeError('Provider requested client action: '+obj['method'])
     return obj
    def call(method,params):
     nonlocal seq
     report['stage']=method
     seq+=1; ident=seq
     proc.stdin.write(json.dumps({'id':ident,'method':method,'params':params})+'\n');proc.stdin.flush()
     deadline=time.monotonic()+45
     while True:
      obj=recv(deadline)
      if obj.get('id')==ident:
       if 'error' in obj:raise RuntimeError('Provider request failed')
       return obj.get('result',{})
      pending.append(obj)
    def events_for(thread,deadline):
     while True:
      obj=pending.pop(0) if pending else recv(deadline)
      if obj.get('params',{}).get('threadId')==thread:yield obj

    def turn(thread,prompt):
     result=call('turn/start',{'threadId':thread,'input':[{'type':'text','text':prompt}]})
     turn_id=result['turn']['id'];messages=[]
     for obj in events_for(thread,time.monotonic()+75):
      method=obj.get('method');p=obj.get('params',{})
      if method=='item/completed':
       item=p.get('item',{})
       if item.get('type')=='agentMessage':messages.append(item.get('text',''))
       if item.get('type') in ['commandExecution','fileChange','mcpToolCall']:raise RuntimeError('Unexpected tool use in no-tool conversational probe')
      if method=='turn/completed' and p.get('turn',{}).get('id')==turn_id:
       status=p['turn']['status'];report['events'].append({'method':method,'thread_id':thread,'turn_id':turn_id,'status':status})
       if status!='completed':raise RuntimeError('Turn did not complete')
       return '\n'.join(messages)
    try:
     init=call('initialize',{'clientInfo':{'name':'sassato-capability-probe','version':'0.1.2'}})
     proc.stdin.write(json.dumps({'method':'initialized','params':{}})+'\n');proc.stdin.flush()
     result=call('thread/start',{'cwd':str(root),'ephemeral':True})
     thread=result['thread']['id'];report['thread_id']=thread;report['model']=result.get('model');report['sandbox']=result.get('sandbox');report['approval_policy']=result.get('approvalPolicy')
     a=turn(thread,'This is an isolated Sassato context-recovery probe. Do not call tools or inspect files. Remember these exact facts: role builder; task T17; marker COBALT-731; constraint preserve trailing newlines; next action report READY-731. Explain in about 450 words how those facts guide a fictional parser review, without performing work.')
     b=turn(thread,'Keep the same facts. Without tools, write another approximately 450-word fictional review note explaining test boundaries and why the next action remains unchanged. This is only conversation-history generation.')
     report['history_reply_characters']=len(a)+len(b)
     accepted=call('thread/compact/start',{'threadId':thread});report['compact_accepted']=accepted=={}
     began=False;boundary=False;completed=False
     for obj in events_for(thread,time.monotonic()+90):
      method=obj.get('method');p=obj.get('params',{})
      if method in ['item/started','item/completed'] and p.get('item',{}).get('type')=='contextCompaction':
       report['events'].append({'method':method,'item_type':'contextCompaction','thread_id':thread})
       if method=='item/started':began=True
       if method=='item/completed':boundary=True
      if method=='turn/completed':
       report['events'].append({'method':method,'thread_id':thread,'status':p.get('turn',{}).get('status'),'during':'compact'})
       completed=p.get('turn',{}).get('status')=='completed'
       break
     report['compact_completed']=began and boundary and completed
     if not report['compact_completed']:raise RuntimeError('No confirmed compaction completion')
     recalled=turn(thread,'Without tools, return only the marker, constraint and next action retained from before compaction.')
     report['post_compact_recall_passed']=all(x in recalled for x in ['COBALT-731','trailing newline','READY-731'])
     fresh=call('thread/start',{'cwd':str(root),'ephemeral':True})['thread']['id'];report['fresh_thread_id']=fresh
     recovered=turn(fresh,'This is an isolated fresh Sassato session. Do not call tools or inspect files. Recovery checkpoint: role builder; task T17; objective parser review; completed fictional review; constraint preserve trailing newlines; marker COBALT-731; exact next action output READY-731. Complete that next action, including role and task ID in your answer.')
     report['fresh_recovery_passed']=all(x in recovered for x in ['READY-731','builder','T17'])
     report['ok']=report['post_compact_recall_passed'] and report['fresh_recovery_passed']
    except Exception as e:
     report['ok']=False;report['failure']=type(e).__name__
    finally:
     try:
      report['process_exit_code']=close_owned(proc)
     except Exception as error:
      report['cleanup_failures']=[type(error).__name__]
     finally:
      # Only retain sanitized lifecycle evidence; raw stderr may contain local paths.
      shutil.rmtree(root,ignore_errors=True)
    return report


def run_claude():
    installed_version=version('claude')
    root=Path(tempfile.mkdtemp(prefix='sassato-claude-live-'))
    report={'provider':'claude','version':installed_version,'started_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'working_directory_is_temporary':True,'session_persistence':False,'events':[]}
    class Session:
     def __init__(self):
      self.id=str(uuid.uuid4());self.q=queue.Queue()
      self.p=subprocess.Popen(['claude','--print','--input-format','stream-json','--output-format','stream-json','--verbose','--session-id',self.id,'--no-session-persistence'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,start_new_session=True)
      threading.Thread(target=self.pump,daemon=True).start();threading.Thread(target=self.errpump,daemon=True).start()
     def pump(self):
      for line in self.p.stdout:
       try:self.q.put(json.loads(line))
       except:pass
      self.q.put({'_exited':True})
     def errpump(self):
      for line in self.p.stderr:pass
     def turn(self,text,compact=False):
      report['stage']='compact' if compact else 'conversation turn'
      self.p.stdin.write(json.dumps({'type':'user','message':{'role':'user','content':text},'parent_tool_use_id':None,'session_id':self.id})+'\n');self.p.stdin.flush()
      deadline=time.monotonic()+90;boundary=False
      while True:
       left=deadline-time.monotonic()
       if left<=0:raise TimeoutError('Claude event deadline exceeded')
       item=self.q.get(timeout=left)
       if '_exited' in item:raise RuntimeError('Claude process exited before result')
       if item.get('session_id') and item['session_id']!=self.id:raise RuntimeError('Claude session identity changed unexpectedly')
       if item.get('type')=='control_request':raise RuntimeError('Claude requested client control action')
       if item.get('type')=='system' and item.get('subtype')=='init':
        report['events'].append({'type':'system','subtype':'init','session_id':item.get('session_id'),'model':item.get('model'),'permission_mode':item.get('permissionMode')})
       if item.get('type')=='system' and item.get('subtype')=='compact_boundary':
        boundary=True;report['events'].append({'type':'system','subtype':'compact_boundary','session_id':item.get('session_id'),'metadata':item.get('compact_metadata')})
       if item.get('type')=='assistant' and any(x.get('type')=='tool_use' for x in item.get('message',{}).get('content',[])):raise RuntimeError('Unexpected tool use in no-tool conversational probe')
       if item.get('type')=='result':
        report['events'].append({'type':'result','subtype':item.get('subtype'),'session_id':item.get('session_id'),'is_error':item.get('is_error'), 'during':'compact' if compact else 'turn'})
        if item.get('is_error') or item.get('subtype')!='success':raise RuntimeError('Claude result failed: '+str(item.get('subtype')))
        return item.get('result',''),boundary
     def close(self):
      return close_owned(self.p)
    sessions=[]
    try:
     s=Session();sessions.append(s);report['session_id']=s.id
     a,_=s.turn('This is an isolated Sassato recovery probe. Do not use tools or inspect files. Remember role builder, task T17, marker AMBER-592, constraint preserve trailing newlines, next action READY-592. Write roughly 400 words explaining a fictional parser review and how those facts constrain it. Do no actual work.')
     b,_=s.turn('Keep those facts. Without tools write about 400 more words describing fictional test boundaries and why the exact next action remains unchanged. This is only history generation.')
     report['history_reply_characters']=len(a)+len(b)
     result,boundary=s.turn('/compact Preserve the exact marker, role, task, constraint and next action.',True)
     report['compact_completed']=boundary
     if not boundary:report['compact_no_boundary_result']=result[:180]
     recalled,_=s.turn('Without tools return only the marker, constraint and exact next action retained from the earlier discussion.')
     report['post_compact_recall_passed']=all(x in recalled for x in ['AMBER-592','trailing newline','READY-592'])
     fresh=Session();sessions.append(fresh);report['fresh_session_id']=fresh.id
     recovered,_=fresh.turn('This is an isolated fresh Sassato session. Do not use tools or inspect files. Recovery checkpoint: role builder; task T17; objective parser review; completed fictional review; constraint preserve trailing newlines; marker AMBER-592; exact next action output READY-592. Complete that next action including role and task ID in your answer.')
     report['fresh_recovery_passed']=all(x in recovered for x in ['READY-592','builder','T17'])
     report['ok']=boundary and report['post_compact_recall_passed'] and report['fresh_recovery_passed']
    except Exception as e:
     report['ok']=False;report['failure']=type(e).__name__
    finally:
     report['process_exit_codes']=[]
     try:
      for session in sessions:
       try:
        report['process_exit_codes'].append(session.close())
       except Exception as error:
        report.setdefault('cleanup_failures',[]).append(type(error).__name__)
     finally:
      shutil.rmtree(root,ignore_errors=True)
    return report


def sanitized(report):
    # Keep lifecycle evidence, not account details, output text or provider IDs.
    old=report.get('thread_id',report.get('session_id'))
    new=report.get('fresh_thread_id',report.get('fresh_session_id'))
    report['distinct_fresh_identity']=bool(old and new and old!=new)
    exits=report.get('process_exit_codes',[report.get('process_exit_code')])
    report['ok']=bool(report.get('ok') and report['distinct_fresh_identity']
                      and exits and all(code==0 for code in exits)
                      and not report.get('cleanup_failures'))
    report.pop('compact_no_boundary_result', None)
    hidden = {'thread_id', 'turn_id', 'session_id', 'fresh_thread_id', 'fresh_session_id', 'preserved_segment', 'preserved_messages'}
    def clean(value):
        if isinstance(value, dict):
            return {k:clean(v) for k,v in value.items() if k not in hidden}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value
    return clean(report)

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', choices=['codex','claude'], required=True)
    args=parser.parse_args()
    if os.name != 'posix':
        parser.error('The live probe currently requires POSIX process-group cleanup')
    try:
        report = run_codex() if args.provider == 'codex' else run_claude()
    except Exception as error:
        report = {'provider':args.provider,'ok':False,'failure':type(error).__name__,'stage':'startup or cleanup'}
    print(json.dumps(sanitized(report), indent=2))
    raise SystemExit(0 if report.get('ok') else 1)
