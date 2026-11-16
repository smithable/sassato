import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync,constants,fstatSync,lstatSync,openSync,readlinkSync,readSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,join } from 'node:path';
import { check } from './errors.js';
import { insideCheckout } from './repository-identity.js';

export interface DirtyEntry {path:string;index:string[];working:string;mode:string|null}
/** Hash locally; persist neither file contents nor executable Git filter output. */
export function dirtyManifest(root:string):DirtyEntry[] {
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1'};
  const config=['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.attributesFile=/dev/null'];
  const run=(args:string[],optional=false):string=>{
    const result=spawnSync('git',[...config,'-C',root,...args],{env,encoding:'utf8',timeout:3000,maxBuffer:1_048_576,shell:false});
    check(!result.error && (result.status===0 || optional && result.status===1),'Dirty manifest probe failed or exceeded its bound',4);
    return result.stdout;
  };
  const filters=run(['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|process|required)$'],true).split('\0').filter(Boolean);
  check(filters.length<=128 && filters.every(key=>/^filter\.[A-Za-z0-9_.-]+\.(clean|process|required)$/.test(key)),'Unsupported Git filter configuration blocks handover',4);
  for(const key of new Set(filters.map(key=>key.replace(/\.(clean|process|required)$/,''))))config.push('-c',`${key}.clean=`,'-c',`${key}.process=`,'-c',`${key}.required=false`);
  const index=new Map<string,string[]>();
  for(const entry of run(['ls-files','--stage','-z']).split('\0').filter(Boolean)) {
    const match=/^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry);
    check(match && match[1]!=='160000','Unparseable index or submodule blocks dirty-work proof',4);
    index.set(match[4],[...(index.get(match[4])??[]),`${match[1]} ${match[2]} ${match[3]}`]);
  }
  const paths=new Set<string>(),status=run(['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none']).split('\0');
  for(let i=0;i<status.length;i++) {
    const entry=status[i];if(!entry)continue;
    check(entry.length>=4 && entry[2]===' ','Invalid status in dirty manifest',4);
    paths.add(entry.slice(3));
    if(/[RC]/.test(entry.slice(0,2))) {check(Boolean(status[i+1]),'Incomplete rename manifest',4);paths.add(status[++i]);}
  }
  return [...paths].sort().map(path=>{
    check(!isAbsolute(path) && insideCheckout(root,join(root,path)),'Dirty path escapes checkout',4);
    const full=join(root,path);let working:string,mode:string|null=null;
    try {
      check(insideCheckout(root,realpathSync(dirname(full))),'Dirty path parent escapes checkout',4);
      const before=lstatSync(full,{bigint:true});
      mode=String(before.mode);
      if(before.isSymbolicLink())working='symlink:'+createHash('sha256').update(readlinkSync(full)).digest('hex');
      else {
        check(before.isFile() && before.size<=64n*1024n*1024n,'Non-regular or oversized dirty file blocks handover',4);
        const fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
          const opened=fstatSync(fd,{bigint:true});
          check(opened.dev===before.dev && opened.ino===before.ino && opened.isFile(),'Dirty file changed during capture',4);
          const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let read:number,total=0;
          while((read=readSync(fd,buffer,0,buffer.length,null))>0) {total+=read;check(total<=64*1024*1024,'Dirty file grew beyond handover bound',4);hash.update(buffer.subarray(0,read));}
          const after=fstatSync(fd,{bigint:true});
          check(after.size===opened.size && after.mtimeNs===opened.mtimeNs && after.ctimeNs===opened.ctimeNs,'Dirty file changed during capture',4);
          working='sha256:'+hash.digest('hex');
        } finally {closeSync(fd);}
      }
      const after=lstatSync(full,{bigint:true});
      check(after.dev===before.dev && after.ino===before.ino && after.mtimeNs===before.mtimeNs && after.ctimeNs===before.ctimeNs,'Dirty path changed during capture',4);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')working='missing';else throw error;
    }
    return {path,index:index.get(path)??[],working,mode};
  });
}
