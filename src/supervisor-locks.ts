import { spawnSync } from 'node:child_process';
import { closeSync,constants,fstatSync,openSync,realpathSync,statSync,statfsSync } from 'node:fs';
import { basename,dirname,isAbsolute,resolve } from 'node:path';
import { check,text } from './errors.js';

// Supported local Linux filesystems only. Unknown/network locking semantics are
// not evidence that replacement is safe. Ordinary Sassato commands do not use this gate.
const LOCAL_FILESYSTEMS=new Set([0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630]);
const held=new WeakSet<object>();
export interface SupervisorLease {readonly path:string;readonly mode:'shared'|'exclusive';assertHeld():void;close():void}
export function acquireSupervisorLock(path:string,mode:'shared'|'exclusive'):SupervisorLease {
  text(path,'supervisor lock path',4096);check(process.platform==='linux','Managed controller locks require Linux',4);
  check(isAbsolute(path) && ['shared','exclusive'].includes(mode),'Use an absolute lock path and shared/exclusive mode');
  const parent=realpathSync(dirname(path)),canonical=resolve(parent,basename(path));
  check(LOCAL_FILESYSTEMS.has(Number(statfsSync(parent).type)),'Supervisor lock filesystem has unsupported identity/locking semantics',4);
  const fd=openSync(canonical,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  let open=true;
  try {
    const identity=fstatSync(fd);check(identity.isFile(),'Supervisor lock is not a regular file',4);
    // flock(2) locks an open file description. fd 3 in the child shares ours;
    // closing the helper leaves the lock held until this parent closes its fd.
    const result=spawnSync('flock',[mode==='shared'?'--shared':'--exclusive','--nonblock','--conflict-exit-code','75','3'],{stdio:['ignore','ignore','ignore',fd],timeout:2000,shell:false});
    check(!result.error && result.status===0,result.status===75?'Supervisor maintenance/controller lock is busy':'Could not establish supervisor lock ownership',4);
    const lease:SupervisorLease={path:canonical,mode,
      assertHeld(){
        check(open && held.has(lease),'Supervisor lock lease is no longer held',4);
        const current=statSync(canonical),descriptor=fstatSync(fd);
        check(current.dev===identity.dev && current.ino===identity.ino && descriptor.dev===identity.dev && descriptor.ino===identity.ino,'Supervisor lock identity changed; reconcile before lifecycle work',4);
      },
      close(){if(open){open=false;held.delete(lease);closeSync(fd);}}
    };
    held.add(lease);lease.assertHeld();return lease;
  } catch(error) {if(open){open=false;closeSync(fd);}throw error;}
}
export function requireSupervisorLease(lease:SupervisorLease,mode:'shared'|'exclusive'):void {
  check(held.has(lease) && lease.mode===mode,'A current supervisor lock lease is required',4);lease.assertHeld();
}
