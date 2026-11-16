import { constants, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from './errors.js';
import { INDEX_SCHEMA, type FileAnalysis, type IndexSnapshot } from './index-types.js';
import { digest, isAncestor, type TreeFile, assertSnapshotPaths } from './index-git.js';
import { type RepositoryIdentity } from './repository-identity.js';
import { analyzeSource, parserVersion } from './index-extract.js';

export function indexCacheRoot(path?:string):string {
  return resolve(path??process.env.SASSATO_INDEX_CACHE??join(process.env.XDG_CACHE_HOME??join(homedir(),'.cache'),'sassato','index'));
}
function directory(path:string):void {
  if(dirname(path)!==path)directory(dirname(path));
  if(existsSync(path))check(lstatSync(path).isDirectory()&&!lstatSync(path).isSymbolicLink(),'Index cache directory must not be a symlink',4);
  else mkdirSync(path,{mode:0o700});
}
/** Publish without replacing an existing immutable object, even when another writer wins the race. */
export function publish(path:string,value:unknown):boolean {
  directory(dirname(path));
  const temp=path+'.'+randomUUID()+'.tmp';
  const fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
  try {writeFileSync(fd,JSON.stringify(value)+'\n');}finally{closeSync(fd);}
  try {linkSync(temp,path);return true;}catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
  finally {unlinkSync(temp);}
}
export function readCache(path:string,maxBytes=64*1024*1024):unknown {
  const stat=lstatSync(path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=maxBytes,'Invalid index cache file',4);
  return JSON.parse(readFileSync(path,'utf8'));
}
export const snapshotPath=(root:string,repository:string,commit:string):string=>join(root,repository,`v${INDEX_SCHEMA}-${parserVersion}`,'commits',commit+'.json');
export function readSnapshot(root:string,repository:string,commit:string):IndexSnapshot|undefined {
  const path=snapshotPath(root,repository,commit);
  if(!existsSync(path))return undefined;
  const raw=readCache(path) as IndexSnapshot;
  check(raw.schema===INDEX_SCHEMA&&raw.parser===parserVersion&&raw.repository===repository&&raw.commit===commit&&Array.isArray(raw.files),'Stale or incompatible index snapshot',4);
  assertSnapshotPaths(raw.files.map(file=>file.path));
  check(raw.files.every(file=>typeof file.hash==='string'&&Array.isArray(file.symbols)&&Array.isArray(file.imports)&&Array.isArray(file.uses)&&Array.isArray(file.exports)),'Malformed index snapshot',4);
  return raw;
}
export function cachedAnalysis(root:string,file:TreeFile,source:Buffer):FileAnalysis {
  const key=digest(Buffer.concat([Buffer.from(`${INDEX_SCHEMA}:${parserVersion}:${file.path.split('.').at(-1)}\0`),source]));
  const path=join(root,'analysis',key+'.json');
  try {
    const value=readCache(path,8*1024*1024) as FileAnalysis;
    if(Array.isArray(value.symbols)&&Array.isArray(value.imports)&&Array.isArray(value.exports)&&Array.isArray(value.uses))return value;
  }catch { /* Missing or malformed analysis is recomputed from the requesting snapshot's source. */ }
  const value=analyzeSource(file.path,source.toString('utf8'));publish(path,value);return value;
}
export function advanceLatest(root:string,snapshot:IndexSnapshot,identity:RepositoryIdentity):boolean {
  const dir=dirname(dirname(snapshotPath(root,snapshot.repository,snapshot.commit))),lock=join(dir,'publish.lock'),latest=join(dir,'latest.json');
  directory(dir);
  try {mkdirSync(lock,{mode:0o700});}catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
  try {
    if(existsSync(latest)) {
      const current=readCache(latest,4096) as {commit:string};
      check(typeof current.commit==='string'&&/^[a-f0-9]{40,64}$/.test(current.commit),'Invalid latest index pointer',4);
      if(current.commit!==snapshot.commit&&!isAncestor(identity,current.commit,snapshot.commit))return false;
    }
    const temp=latest+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,JSON.stringify({schema:INDEX_SCHEMA,commit:snapshot.commit})+'\n',{flag:'wx',mode:0o600});renameSync(temp,latest);return true;
  }finally {rmdirSync(lock);}
}
