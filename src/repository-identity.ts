import { spawnSync } from 'node:child_process';
import { spawnError } from './spawn-result.js';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { check, text } from './errors.js';
import type { CaptureBudget } from './capture-budget.js';

export interface RepositoryIdentity {
  checkout_root:string; working_dir:string; git_common_dir:string;
  common_device:string; common_inode:string; object_format:string;
  git_dir:string; git_device:string; git_inode:string;
  root_device:string; root_inode:string; branch:string|null; head:string|null;
}
function physical(path:string):{device:string;inode:string} {
  const value=statSync(path,{bigint:true});
  check(value.isDirectory(),'Repository identity path must be an existing directory',4);
  return {device:String(value.dev),inode:String(value.ino)};
}
export function insideCheckout(root:string,path:string):boolean {
  const local=relative(root,path);
  return local==='' || !isAbsolute(local) && local!=='..' && !local.startsWith('..'+sep);
}
/** Identity probes never read file contents, run hooks, change refs or inspect provider history. */
export function probeRepositoryIdentity(directory:string,budget?:CaptureBudget):RepositoryIdentity {
  budget?.check();
  text(directory,'working directory',4096);
  const working_dir=realpathSync(directory);physical(working_dir);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'};
  const run=(args:string[],optional=false):string|null=>{
    const result=spawnSync('git',['-c','core.fsmonitor=false','-C',working_dir,...args],{encoding:'utf8',timeout:budget?.timeout(2000)??2000,maxBuffer:16384,env,shell:false});
    budget?.check();
    check(!spawnError(result) && (result.status===0 || optional && result.status===1),`Repository identity unavailable (git ${args.join(' ')}: ${spawnError(result)?.message??`exit ${result.status??result.signal}`}); inspect missing or changed checkout before rebinding`,4);
    if(result.status!==0)return null;
    return text(result.stdout.trimEnd(),'Git identity metadata',4096);
  };
  const checkout_root=realpathSync(run(['rev-parse','--show-toplevel'])!);
  check(insideCheckout(checkout_root,working_dir),'Working directory must be inside its checkout',4);
  const git_common_dir=realpathSync(run(['rev-parse','--path-format=absolute','--git-common-dir'])!);
  const git_dir=realpathSync(run(['rev-parse','--absolute-git-dir'])!);
  const common=physical(git_common_dir),git=physical(git_dir),root=physical(checkout_root);
  const object_format=run(['rev-parse','--show-object-format'])!;
  check(['sha1','sha256'].includes(object_format),'Unsupported Git object format',4);
  const head=run(['rev-parse','--verify','--quiet','HEAD'],true);
  check(head===null || (object_format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/).test(head),'Unsupported Git HEAD',4);
  return {checkout_root,working_dir,git_common_dir,common_device:common.device,common_inode:common.inode,object_format,
    git_dir,git_device:git.device,git_inode:git.inode,root_device:root.device,root_inode:root.inode,
    branch:run(['symbolic-ref','--quiet','--short','HEAD'],true),head};
}
export function repositoryFingerprint(value:RepositoryIdentity):string {
  return createHash('sha256').update(JSON.stringify([value.git_common_dir,value.common_device,value.common_inode,value.object_format])).digest('hex');
}
export function checkoutFingerprint(value:RepositoryIdentity):string {
  return createHash('sha256').update(JSON.stringify([repositoryFingerprint(value),value.git_dir,value.git_device,value.git_inode,value.checkout_root,value.root_device,value.root_inode])).digest('hex');
}
/** Cheap filesystem-only recheck while holding a database reservation lock. */
export function assertPhysicalIdentity(value:RepositoryIdentity):void {
  const common=physical(value.git_common_dir),git=physical(value.git_dir),root=physical(value.checkout_root);
  check(common.device===value.common_device && common.inode===value.common_inode && git.device===value.git_device && git.inode===value.git_inode && root.device===value.root_device && root.inode===value.root_inode && realpathSync(value.working_dir)===value.working_dir && insideCheckout(value.checkout_root,value.working_dir),'Physical checkout changed during capture; inspect before rebinding',4);
}
