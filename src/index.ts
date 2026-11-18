import { posix } from 'node:path';
import { check, integer } from './errors.js';
import { probeRepositoryIdentity, repositoryFingerprint, checkoutFingerprint, type RepositoryIdentity } from './repository-identity.js';
import { INDEX_SCHEMA, type IndexFile, type IndexHit, type IndexResult, type IndexSnapshot, type FileAnalysis } from './index-types.js';
import { isCodePath, safeName } from './index-policy.js';
import { digest, treeFiles, readBlobs, resolveCommit, moduleOf, worktreePaths, worktreeFile } from './index-git.js';
import { advanceLatest, cachedAnalysis, indexCacheRoot, pruneIndexCache, publish, readSnapshot, snapshotPath } from './index-cache.js';
import { namedReferences, parserVersion } from './index-extract.js';

export interface IndexOptions {repo?:string;cache?:string;limit?:number;registry?:{repository_id:string;checkout_id?:string};}
const empty=():FileAnalysis=>({symbols:[],imports:[],exports:[],uses:[]});
function requireHead(identity:RepositoryIdentity):string {check(identity.head,'Index requires a committed HEAD; commit the initial files first',4);return identity.head;}
function verifyIdentity(before:RepositoryIdentity):void {
  const after=probeRepositoryIdentity(before.working_dir);
  check(repositoryFingerprint(before)===repositoryFingerprint(after)&&checkoutFingerprint(before)===checkoutFingerprint(after)&&before.head===after.head,'Repository or HEAD changed during index read; retry against the current checkout',4);
}
function buildSnapshot(identity:RepositoryIdentity,cache:string,commit:string,base?:IndexSnapshot):{snapshot:IndexSnapshot;analyzed:number;reused:number} {
  const repository=repositoryFingerprint(identity),files=treeFiles(identity,commit),previous=new Map(base?.files.map(file=>[file.path,file]));
  const changed=files.filter(file=>previous.get(file.path)?.hash!==file.blob),blobs=readBlobs(identity,changed);
  let analyzed=0,reused=0;
  const entries:IndexFile[]=files.map(file=>{
    const old=previous.get(file.path);
    if(old?.hash===file.blob) {reused++;return old;}
    const source=blobs.get(file.blob);
    const analysis=source?cachedAnalysis(cache,file,source):{...empty(),...(isCodePath(file.path)?{reason:'Source exceeds analysis size limit'}:{})};
    if(source)analyzed++;
    return {path:file.path,hash:file.blob,module:moduleOf(file.path),...analysis};
  });
  return {snapshot:{schema:INDEX_SCHEMA,parser:parserVersion,repository,commit,object_format:identity.object_format,files:entries},analyzed,reused};
}
export function buildIndex(options:IndexOptions={},diff?:string) {
  const identity=probeRepositoryIdentity(options.repo??process.cwd()),commit=requireHead(identity),cache=indexCacheRoot(options.cache),repository=repositoryFingerprint(identity);
  let base:IndexSnapshot|undefined,from:string|undefined;
  if(diff!==undefined) {
    const match=/^(.+?)\.\.([^.]?.*)$/.exec(diff);
    check(match&&!diff.includes('...'),'Index update requires BASE..HEAD');
    from=resolveCommit(identity,match[1]);check(resolveCommit(identity,match[2])===commit,'Index update target must be this checkout HEAD');
    // Both endpoints resolve independently. An unrelated base is safe because only identical
    // path+blob analysis is reused; the full target tree supplies deletions and renames.
    try {base=readSnapshot(cache,repository,from);}catch {base=undefined;}
  } else {
    try {base=readSnapshot(cache,repository,commit);}catch {base=undefined;}
  }
  const built=buildSnapshot(identity,cache,commit,base);verifyIdentity(identity);
  const path=snapshotPath(cache,repository,commit),published=publish(path,built.snapshot);
  if(!published)check(readSnapshot(cache,repository,commit),'Existing immutable snapshot is invalid; inspect its cache file before rebuilding',4);
  const latest_advanced=advanceLatest(cache,built.snapshot,identity);
  pruneIndexCache(cache);
  return {schema:INDEX_SCHEMA,parser:parserVersion,repository,checkout:checkoutFingerprint(identity),commit,...(options.registry??{}),files:built.snapshot.files.length,analyzed:built.analyzed,reused:built.reused,published,latest_advanced,...(!latest_advanced?{latest_notice:'Mainline pointer unchanged (non-mainline, non-forward, invalid pointer or occupied publish.lock); exact-commit snapshot is available. For an abandoned lock, inspect publish.lock/owner.json and verify its process is gone before removing it.'}:{}),path,...(from?{base:from}:{})};
}
interface View {identity:RepositoryIdentity;snapshot:IndexSnapshot;state:IndexResult['state'];fallback:boolean;reason?:string;view:string;}
function currentView(options:IndexOptions,query:string):View {
  const identity=probeRepositoryIdentity(options.repo??process.cwd()),commit=requireHead(identity),cache=indexCacheRoot(options.cache),repository=repositoryFingerprint(identity);
  let snapshot:IndexSnapshot|undefined,state:IndexResult['state']='current',reason:string|undefined;
  try {snapshot=readSnapshot(cache,repository,commit);}catch {state='stale';reason='Cached index is stale or malformed; searching current source';}
  if(!snapshot) {if(state!=='stale'){state='missing';reason='No index for this checkout HEAD; searching current source';}snapshot={schema:INDEX_SCHEMA,parser:parserVersion,repository,commit,object_format:identity.object_format,files:[]};}
  const committed=new Map(snapshot.files.map(file=>[file.path,file])),files:IndexFile[]=[],seen=new Set<string>();
  let bytes=0,dirty=false;const until=Date.now()+60_000;
  for(const path of worktreePaths(identity)) {
    check(Date.now()<until,'Index worktree read exceeded its time limit',4);
    const entry=worktreeFile(identity,path);if(!entry)continue;
    const {data,hash}=entry;bytes+=data?.length??0;check(bytes<=128*1024*1024,'Worktree exceeds index source-byte limit',4);
    const old=committed.get(path);seen.add(path);
    const named=data&&isCodePath(path)?namedReferences(path,data.toString('utf8'),query):[];
    if(old?.hash===hash)files.push(named.length?{...old,uses:[...old.uses,...named]}:old);
    else {
      dirty=true;
      const analysis=data&&isCodePath(path)?cachedAnalysis(cache,{path,blob:hash},data):{...empty(),...(entry.reason?{reason:entry.reason}:{})};
      files.push({path,hash,module:moduleOf(path),...analysis,uses:[...analysis.uses,...named]});
    }
  }
  if([...committed.keys()].some(path=>!seen.has(path)))dirty=true;
  verifyIdentity(identity);
  pruneIndexCache(cache);
  const view=digest(JSON.stringify([commit,files.map(file=>[file.path,file.hash])]));
  if(state==='current'&&dirty)state='overlay';
  return {identity,snapshot:{...snapshot,files},state,fallback:state==='missing'||state==='stale',...(reason?{reason}:{}),view};
}
export function resolveIndexImport(path:string,specifier:string,files:Set<string>):string|undefined {
  if(!specifier.startsWith('.'))return undefined;
  const target=posix.normalize(posix.join(posix.dirname(path),specifier));
  if(target.startsWith('../')||target.startsWith('/'))return undefined;
  const withoutJs=target.replace(/\.(?:mjs|cjs|jsx|js)$/,'');
  const candidates=[target,...['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'].map(ext=>withoutJs+ext),...['.ts','.tsx','.js','.mjs'].map(ext=>posix.join(target,'index'+ext))];
  return candidates.find(candidate=>files.has(candidate));
}
function hit(file:IndexFile,name:string,line:number,kind:string,signature?:string,relation?:string):IndexHit {
  return {path:file.path,line,name,kind,...(signature?{signature}:{}),...(relation?{relation}:{})};
}
function queryIndex(query:string,options:IndexOptions,show:boolean):IndexResult {
  check(safeName(query)&&query.trim()===query,'Index query must be a bounded name or repository-relative path');
  const limit=integer(options.limit??30,'index limit',1,100),candidateLimit=limit*20;
  const view=currentView(options,query),files=view.snapshot.files,paths=new Set(files.map(file=>file.path)),items:IndexHit[]=[];
  const normalized=query.replace(/^\.\//,'').replace(/\/$/,''),needle=normalized.toLowerCase();
  let capped=false;
  const compare=(a:IndexHit,b:IndexHit):number=>a.path.localeCompare(b.path,'en')||a.line-b.line||a.kind.localeCompare(b.kind,'en')||a.name.localeCompare(b.name,'en');
  const definitions:{file:IndexFile;symbol:IndexFile['symbols'][number]}[]=[];
  for(const file of files)for(const symbol of file.symbols)if(show?symbol.name===query:symbol.name.toLowerCase().includes(needle)) {
    let low=0,high=definitions.length;
    const candidate=hit(file,symbol.name,symbol.line,symbol.kind);
    while(low<high){const middle=(low+high)>>>1,entry=definitions[middle];if(compare(hit(entry.file,entry.symbol.name,entry.symbol.line,entry.symbol.kind),candidate)<=0)low=middle+1;else high=middle;}
    if(low>=candidateLimit){capped=true;continue;}
    definitions.splice(low,0,{file,symbol});
    if(definitions.length>candidateLimit){definitions.pop();capped=true;}
  }
  const names=new Set(definitions.map(({symbol})=>symbol.name));
  const definitionKeys=new Set(definitions.map(({file,symbol})=>file.path+'\0'+symbol.name));
  // Retain the earliest hits in display order, regardless of discovery order.
  const candidateKeys=new Set<string>();
  const add=(item:IndexHit):void=>{
    const key=JSON.stringify(item);if(candidateKeys.has(key))return;
    let low=0,high=items.length;
    while(low<high){const middle=(low+high)>>>1;if(compare(items[middle],item)<=0)low=middle+1;else high=middle;}
    if(low>=candidateLimit){capped=true;return;}
    items.splice(low,0,item);candidateKeys.add(key);
    if(items.length>candidateLimit){candidateKeys.delete(JSON.stringify(items.pop()!));capped=true;}
  };
  const uses=new Map<string,{file:IndexFile;use:IndexFile['uses'][number]}[]>();
  const aliases=new Map<string,{file:IndexFile;use:IndexFile['uses'][number]}[]>();
  for(const file of files) {
    const local=new Map<string,IndexFile['uses']>();
    const relevantImports=file.imports.flatMap(imported=>{
      const target=resolveIndexImport(file.path,imported.specifier,paths);
      return target?imported.bindings.filter(binding=>definitionKeys.has(target+'\0'+binding.imported)).map(binding=>({key:target+'\0'+binding.imported,local:binding.local})):[];
    });
    const localNames=new Set(relevantImports.map(binding=>binding.local));
    for(const use of file.uses) {
      if(names.has(use.name)) {
        const all=uses.get(use.name)??[];
        if(all.length<limit+1)all.push({file,use});else capped=true;
        uses.set(use.name,all);
      }
      if(localNames.has(use.name)) {
        const named=local.get(use.name)??[];
        if(named.length<limit+1)named.push(use);else capped=true;
        local.set(use.name,named);
      }
    }
    for(const binding of relevantImports) {
      const entries=aliases.get(binding.key)??[];
      for(const use of local.get(binding.local)??[]) {
        if(entries.length<limit+1)entries.push({file,use});else capped=true;
      }
      aliases.set(binding.key,entries);
    }
  }
  const matchedFiles=files.filter(file=>show?file.path===normalized||file.path.startsWith(normalized+'/'):file.path.toLowerCase().includes(needle));
  for(const file of matchedFiles) {
    add(hit(file,file.module,1,'file',undefined,file.reason??'module'));
    for(const symbol of file.symbols)add(hit(file,symbol.name,symbol.line,symbol.kind,symbol.signature,symbol.exported?'export':'definition'));
    const declared=new Set(file.symbols.map(symbol=>symbol.name));
    for(const part of file.exports)if(!declared.has(part.name))add(hit(file,part.name,part.line,'export',undefined,part.from?`from ${part.from}`:'local export'));
    for(const imported of file.imports)add(hit(file,imported.specifier,imported.line,'import',undefined,resolveIndexImport(file.path,imported.specifier,paths)??'external or unresolved'));
  }
  for(const {file,symbol} of definitions) {
    add(hit(file,symbol.name,symbol.line,symbol.kind,symbol.signature,`defined in module ${file.module}`));
    for(const {file:user,use} of [...uses.get(symbol.name)??[],...aliases.get(file.path+'\0'+symbol.name)??[]])
      if(!(user.path===file.path&&use.line===symbol.line))add(hit(user,symbol.name,use.line,'use',undefined,`${use.kind}; potential name reference`));
  }
  const unique=new Map<string,IndexHit>();
  const tests=new Map<string,Set<string>>();
  for(const file of files.filter(file=>/(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)\/)/.test(file.path)))for(const imported of file.imports) {
    const target=resolveIndexImport(file.path,imported.specifier,paths);if(!target)continue;
    const linked=tests.get(target)??new Set<string>();if(linked.size<8)linked.add(file.path);tests.set(target,linked);
  }
  for(const item of items)if(safeName(item.name)&&safeName(item.path)) {
    const related_tests=[...tests.get(item.path)??[]].sort().slice(0,8);
    const enriched=related_tests.length?{...item,related_tests}:item;unique.set(JSON.stringify(enriched),enriched);
  }
  const sorted=[...unique.values()].sort(compare);
  const moduleNames=[...new Set(sorted.slice(0,limit).map(item=>moduleOf(item.path)))].slice(0,10);
  const modules=moduleNames.map(path=>{const members=files.filter(file=>file.module===path);return {path,description:`${members.length} files; ${members.reduce((n,file)=>n+file.symbols.length,0)} definitions; ${members.reduce((n,file)=>n+file.exports.length,0)} exported names (navigation aid)`};});
  return {schema:INDEX_SCHEMA,repository:view.snapshot.repository,checkout:checkoutFingerprint(view.identity),commit:view.snapshot.commit,view:view.view,state:view.state,fallback:view.fallback,...(view.reason?{reason:view.reason}:{}),...(options.registry??{}),query,items:sorted.slice(0,limit),total:sorted.length,total_is_lower_bound:capped,truncated:capped||sorted.length>limit,modules};
}
export const findIndex=(query:string,options:IndexOptions={}):IndexResult=>queryIndex(query,options,false);
export const showIndex=(query:string,options:IndexOptions={}):IndexResult=>queryIndex(query,options,true);
export function formatIndex(result:IndexResult):string {
  const lines=[`index ${result.state} · repo ${result.repository.slice(0,12)} · HEAD ${result.commit.slice(0,12)} · view ${result.view.slice(0,12)}`,
    ...(result.reason?[result.reason]:[]),...result.modules.map(module=>`${module.path}/: ${module.description}`),...result.items.map(item=>`${item.path}:${item.line} ${item.kind} ${item.signature??item.name}${item.relation?` (${item.relation})`:''}${item.related_tests?` [tests: ${item.related_tests.join(', ')}]`:''}`),
    ...(result.truncated?[`Showing ${result.items.length} of ${result.total_is_lower_bound?'at least ':''}${result.total}; narrow the query or use --limit (max 100).`]:[])];
  let output='';
  for(const line of lines) {
    if(output.length+line.length>5900)return output+'\nOutput bounded; narrow the query or use --json.';
    output+=(output?'\n':'')+line;
  }
  return output;
}
