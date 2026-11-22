import { constants, closeSync, existsSync, linkSync, lstatSync, mkdirSync, realpathSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from './errors.js';
import { INDEX_SCHEMA, type FileAnalysis, type IndexSnapshot } from './index-types.js';
import { digest, isAncestor, resolveCommit, type TreeFile, assertSnapshotPaths } from './index-git.js';
import { type RepositoryIdentity } from './repository-identity.js';
import { safeName } from './index-policy.js';
import { analyzeSource, parserVersion } from './index-extract.js';

const cacheRoots=new Set<string>();
const MAX_CACHE_BYTES=64*1024*1024;
/** Resolve existing ancestors once (including platform /tmp aliases), then own the private root. */
export function indexCacheRoot(path?:string):string {
  const requested=resolve(path??process.env.SASSATO_INDEX_CACHE??join(process.env.XDG_CACHE_HOME??join(homedir(),'.cache'),'sassato','index'));
  function canonical(path:string):string {
    if(existsSync(path))return realpathSync(path);
    const result=join(canonical(dirname(path)),path.slice(dirname(path).length+1));
    try {mkdirSync(result,{mode:0o700});}catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      // A read-only sandbox (T1258): say what to do instead of a bare EROFS.
      check(!['EROFS','EACCES','EPERM'].includes(code??''),`Index cache ${requested} cannot be created here (${code}); give --cache with an index built outside this sandbox, or build one where the cache is writable`,4);
      if(code!=='EEXIST')throw error;
    }
    privateDirectory(result);return result;
  }
  const root=canonical(requested);privateDirectory(root);cacheRoots.add(root);pruneIndexCache(root);return root;
}
/** Cached navigation is disposable. Never remove locks, hints or unknown files. */
export function pruneIndexCache(root:string,maxBytes=256*1024*1024,maxObjects=2000):{removed:number;bytes:number;objects:number} {
  privateDirectory(root);
  const objects:{path:string;bytes:number;modified:number}[]=[];
  const collect=(path:string,depth:number):void=>{
    if(!existsSync(path))return;
    privateDirectory(path);
    for(const entry of readdirSync(path,{withFileTypes:true})) {
      const full=join(path,entry.name);
      if(entry.isDirectory()&&depth<3&&(/^[a-f0-9]{64}$/.test(entry.name)||/^v\d+-[\w.-]+$/.test(entry.name)||['analysis','commits'].includes(entry.name)))collect(full,depth+1);
      else if(entry.isFile()&&/^[a-f0-9]{40,64}\.json$/.test(entry.name)&&['analysis','commits'].includes(basename(path))) {
        try {
          const stat=lstatSync(full);
          if(stat.isFile()&&(!process.getuid||stat.uid===process.getuid())&&(stat.mode&0o022)===0)objects.push({path:full,bytes:stat.size,modified:stat.mtimeMs});
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
    }
  };
  collect(root,0);
  let bytes=objects.reduce((n,o)=>n+o.bytes,0),count=objects.length,removed=0;
  for(const object of objects.sort((a,b)=>a.modified-b.modified||a.path.localeCompare(b.path))) {
    if(bytes<=maxBytes&&count<=maxObjects)break;
    try {unlinkSync(object.path);removed++;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    bytes-=object.bytes;count--;
  }
  return {removed,bytes,objects:count};
}
function privateDirectory(path:string):void {
  const stat=lstatSync(path);
  check(stat.isDirectory()&&!stat.isSymbolicLink(),'Index cache directory must not be a symlink',4);
  check((!process.getuid||stat.uid===process.getuid())&&(stat.mode&0o022)===0,'Index cache directory must be owned by this user and not group/world writable',4);
}
function directory(path:string):void {
  if(!cacheRoots.has(path)) {
    check(dirname(path)!==path,'Index cache path is outside its configured root',4);
    directory(dirname(path));
  }
  if(!existsSync(path))try {mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  privateDirectory(path);
}
export function validAnalysis(value:FileAnalysis):boolean {
  const name=(v:unknown)=>typeof v==='string'&&safeName(v);
  const line=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
  return Boolean(value&&Array.isArray(value.symbols)&&value.symbols.every(v=>v&&name(v.name)&&name(v.kind)&&line(v.line)&&name(v.signature)&&typeof v.exported==='boolean')
    &&Array.isArray(value.imports)&&value.imports.every(v=>v&&name(v.specifier)&&line(v.line)&&typeof v.reexport==='boolean'&&Array.isArray(v.bindings)&&v.bindings.every(b=>b&&name(b.local)&&name(b.imported)))
    &&Array.isArray(value.exports)&&value.exports.every(v=>v&&name(v.name)&&line(v.line)&&(v.local===undefined||name(v.local))&&(v.from===undefined||name(v.from)))
    &&Array.isArray(value.uses)&&value.uses.every(v=>v&&name(v.name)&&line(v.line)&&['call','reference'].includes(v.kind))
    &&(value.reason===undefined||name(value.reason)));
}
/** Publish without replacing an existing immutable object, even when another writer wins the race. */
export function publish(path:string,value:unknown):boolean {
  // Never poison immutable objects that subsequent readers must reject.
  if(basename(dirname(path))==='analysis')check(validAnalysis(value as FileAnalysis),'Malformed index analysis; nothing published',4);
  if(basename(dirname(path))==='commits') {
    const snapshot=value as IndexSnapshot;
    check(snapshot&&snapshot.schema===INDEX_SCHEMA&&snapshot.parser===parserVersion&&Array.isArray(snapshot.files)&&snapshot.files.every(file=>validAnalysis(file)),'Malformed index snapshot; nothing published',4);
    assertSnapshotPaths(snapshot.files.map(file=>file.path));
  }
  const serialized=JSON.stringify(value)+'\n';
  check(Buffer.byteLength(serialized)<=MAX_CACHE_BYTES,'Index metadata exceeds cache size limit; nothing published',4);
  directory(dirname(path));
  const temp=path+'.'+randomUUID()+'.tmp';
  const fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
  try {
    try {writeFileSync(fd,serialized);}finally{closeSync(fd);}
    linkSync(temp,path);return true;}catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
  finally {unlinkSync(temp);}
}
export function readCache(path:string,maxBytes=MAX_CACHE_BYTES):unknown {
  directory(dirname(path));
  const stat=lstatSync(path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=maxBytes&&(!process.getuid||stat.uid===process.getuid())&&(stat.mode&0o022)===0,'Invalid index cache file',4);
  return JSON.parse(readFileSync(path,'utf8'));
}
export const snapshotPath=(root:string,repository:string,commit:string):string=>join(root,repository,`v${INDEX_SCHEMA}-${parserVersion}`,'commits',commit+'.json');
export function readSnapshot(root:string,repository:string,commit:string):IndexSnapshot|undefined {
  const path=snapshotPath(root,repository,commit);
  if(!existsSync(path))return undefined;
  const raw=readCache(path) as IndexSnapshot;
  check(raw.schema===INDEX_SCHEMA&&raw.parser===parserVersion&&raw.repository===repository&&raw.commit===commit&&Array.isArray(raw.files),'Stale or incompatible index snapshot',4);
  assertSnapshotPaths(raw.files.map(file=>file.path));
  check(raw.files.every(file=>typeof file.hash==='string'&&typeof file.module==='string'&&validAnalysis(file)),'Malformed index snapshot',4);
  return raw;
}
export function cachedAnalysis(root:string,file:TreeFile,source:Buffer):FileAnalysis {
  const key=digest(Buffer.concat([Buffer.from(`${INDEX_SCHEMA}:${parserVersion}:${file.path.split('.').at(-1)}\0`),source]));
  const path=join(root,'analysis',key+'.json');
  try {
    const value=readCache(path) as FileAnalysis;
    if(validAnalysis(value))return value;
  }catch { /* Missing or malformed analysis is recomputed from the requesting snapshot's source. */ }
  const value=analyzeSource(file.path,source.toString('utf8'));check(validAnalysis(value),'Malformed extracted index analysis',4);publish(path,value);return value;
}
export function advanceLatest(root:string,snapshot:IndexSnapshot,identity:RepositoryIdentity):boolean {
  try {return advanceLatestHint(root,snapshot,identity);}catch {return false;}
}
function advanceLatestHint(root:string,snapshot:IndexSnapshot,identity:RepositoryIdentity):boolean {
  const dir=dirname(dirname(snapshotPath(root,snapshot.repository,snapshot.commit))),lock=join(dir,'publish.lock'),latest=join(dir,'latest.json');
  // latest is a mainline hint only; feature snapshots always remain addressable by commit.
  let main:string|undefined;
  for(const ref of ['refs/heads/main','refs/heads/master','refs/remotes/origin/HEAD']) {try {main=resolveCommit(identity,ref);break;}catch { /* optional hint */ }}
  if(!main||!isAncestor(identity,snapshot.commit,main))return false;
  directory(dir);
  try {mkdirSync(lock,{mode:0o700});}catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
  try {
    writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid,host:hostname(),started_at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
    if(existsSync(latest)) {
      const current=readCache(latest,4096) as {commit:string};
      check(typeof current.commit==='string'&&/^[a-f0-9]{40,64}$/.test(current.commit),'Invalid latest index pointer',4);
      if(current.commit!==snapshot.commit) {
        try {if(!isAncestor(identity,current.commit,snapshot.commit))return false;}catch {return false;}
      }
    }
    const temp=latest+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,JSON.stringify({schema:INDEX_SCHEMA,commit:snapshot.commit})+'\n',{flag:'wx',mode:0o600});renameSync(temp,latest);return true;
  }finally {
    try {unlinkSync(join(lock,'owner.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    finally {rmdirSync(lock);}
  }
}
