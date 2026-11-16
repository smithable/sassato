import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AppError, check } from './errors.js';
import { insideCheckout, type RepositoryIdentity } from './repository-identity.js';
import { indexablePath, isCodePath } from './index-policy.js';
import { MAX_SOURCE_BYTES } from './index-types.js';

export const digest=(data:string|Buffer):string=>createHash('sha256').update(data).digest('hex');
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'};
/** Plumbing only: no status/diff worktree comparisons, attributes, clean filters or external diff. */
export function indexGit(identity:RepositoryIdentity,args:string[],input?:string|Buffer):Buffer {
  const result=spawnSync('git',['-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-C',identity.checkout_root,...args],{input,timeout:30_000,maxBuffer:128*1024*1024,env,shell:false});
  check(!result.error&&result.status===0,'Repository index Git read failed or exceeded its resource limit',4);
  return result.stdout;
}
export function resolveCommit(identity:RepositoryIdentity,revision:string):string {
  check(revision.length>0&&revision.length<=256&&!revision.startsWith('-')&&!/[\x00-\x20]/.test(revision),'Invalid index revision');
  const commit=indexGit(identity,['rev-parse','--verify','--end-of-options',`${revision}^{commit}`]).toString().trim();
  check((identity.object_format==='sha1'?/^[a-f0-9]{40}$/:/^[a-f0-9]{64}$/).test(commit),'Invalid index commit',4);
  return commit;
}
export function isAncestor(identity:RepositoryIdentity,older:string,newer:string):boolean {
  const result=spawnSync('git',['-C',identity.checkout_root,'merge-base','--is-ancestor',older,newer],{timeout:5000,env,shell:false});
  check(!result.error&&[0,1].includes(result.status??-1),'Index ancestry could not be verified',4);
  return result.status===0;
}
export interface TreeFile {path:string;blob:string;size?:number;}
export function treeFiles(identity:RepositoryIdentity,commit:string):TreeFile[] {
  const rows=indexGit(identity,['ls-tree','-rlz','--full-tree',commit]).toString().split('\0').filter(Boolean);
  check(rows.length<=100_000,'Repository exceeds index file-count limit',4);
  const files:TreeFile[]=[];
  for(const row of rows) {
    check(!row.startsWith('160000 '),'Submodule trees are not supported by the repository index',4);
    const match=/^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(row);
    if(match&&indexablePath(match[4]))files.push({path:match[4],blob:match[2],size:Number(match[3])});
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
export function readBlobs(identity:RepositoryIdentity,files:TreeFile[]):Map<string,Buffer> {
  const chosen=files.filter(file=>isCodePath(file.path)&&(file.size??0)<=MAX_SOURCE_BYTES);
  check(chosen.reduce((sum,file)=>sum+(file.size??0),0)<=96*1024*1024,'Repository exceeds index source-byte limit',4);
  const ids=[...new Set(chosen.map(file=>file.blob))],out=new Map<string,Buffer>();
  if(!ids.length)return out;
  const data=indexGit(identity,['cat-file','--batch'],ids.join('\n')+'\n');
  let offset=0;
  for(const id of ids) {
    const end=data.indexOf(10,offset);check(end>=offset,'Incomplete index blob response',4);
    const header=data.subarray(offset,end).toString(),match=/^([a-f0-9]+) blob (\d+)$/.exec(header);
    check(match&&match[1]===id,'Unexpected index blob response',4);
    const size=Number(match[2]);offset=end+1;
    check(size<=MAX_SOURCE_BYTES&&offset+size<data.length,'Oversized or incomplete index blob',4);
    out.set(id,data.subarray(offset,offset+size));offset+=size+1;
  }
  return out;
}
/** Read only regular files below the real checkout root; a symlink in any component is excluded. */
export function worktreeFile(identity:RepositoryIdentity,path:string):Buffer|undefined {
  if(!indexablePath(path))return undefined;
  try {
    let location=identity.checkout_root;
    for(const part of path.split('/')) {location=join(location,part);if(lstatSync(location).isSymbolicLink())return undefined;}
    const stat=lstatSync(location);
    if(!stat.isFile()||!insideCheckout(identity.checkout_root,realpathSync(location)))return undefined;
    check(stat.size<=(isCodePath(path)?MAX_SOURCE_BYTES:16*1024*1024),`Worktree file exceeds index byte limit: ${path}`,4);
    return readFileSync(location);
  }catch(error){if(error instanceof AppError)throw error;if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return undefined;throw new AppError(`Worktree file could not be read safely: ${path}`,4);}
}
export function worktreePaths(identity:RepositoryIdentity):string[] {
  const stages=indexGit(identity,['ls-files','--stage','-z']).toString().split('\0').filter(Boolean);
  check(stages.every(row=>/^100(?:644|755) [a-f0-9]+ 0\t/.test(row)||row.startsWith('120000 ')),'Unmerged or submodule indexes are not supported by the repository index',4);
  const flags=indexGit(identity,['ls-files','-v','-z']).toString().split('\0');
  check(!flags.some(row=>/^[sS] /.test(row)),'Sparse/skip-worktree indexes are not supported by the repository index',4);
  const paths=indexGit(identity,['ls-files','-z','--cached','--others','--exclude-standard']).toString().split('\0').filter(indexablePath);
  check(paths.length<=100_000,'Worktree exceeds index file-count limit',4);
  return [...new Set(paths)].sort((a,b)=>a.localeCompare(b,'en'));
}
export function assertSnapshotPaths(paths:string[]):void {
  check(paths.every(indexablePath)&&new Set(paths).size===paths.length,'Invalid or duplicate cached index paths',4);
}
export const moduleOf=(path:string):string=>relative('.',join(path,'..')).replaceAll('\\','/')||'.';
