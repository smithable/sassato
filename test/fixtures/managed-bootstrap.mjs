// Copied to a temporary provider-named script by the integration test. No model calls.
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const moduleAt=name=>import(pathToFileURL(process.env.FIXTURE_DIST+'/'+name+'.js').href);
const {Store}=await moduleAt('storage');
const {registerFixtureBootstrap}=await moduleAt('supervisor-bootstrap');
const {acknowledgeFixtureRecovery,saveFixtureReady}=await moduleAt('fixture-recovery');
const options={managedCredentials:{generation:process.env.SASSATO_WORKER_GENERATION,token:process.env.SASSATO_WORKER_TOKEN}};
const open=mode=>{const s=new Store(process.env.FIXTURE_DB,'builder',{...options,managedWriteMode:mode});s.use('demo');return s;};
let store=open('bootstrap'),acting=false,barrier=false;
process.on('message',message=>{
  const reply=value=>process.send({request:message.request,...value});
  try {
    if(message.type==='exit'){store.close();process.exit(0);}
    if(message.type==='tool'){
      if(!acting || barrier){reply({blocked:true});return;}
      writeFileSync(message.path,message.content);reply({written:true});return;
    }
    if(message.type==='drain'){
      barrier=true;
      const row=saveFixtureReady(store,message.transition,message.report,{nonce:message.nonce,generation:Number(process.env.SASSATO_WORKER_GENERATION),tool_start_blocked:true,inventory_complete:true,active_jobs:[]});
      reply({ready:row});return;
    }
    reply({error:'Unsupported fixture message'});
  }catch(error){reply({error:error.message});}
});
try {
  process.send({booting:true});
  const gate=await registerFixtureBootstrap(store,process.env.FIXTURE_TRANSITION,process.env.FIXTURE_LAUNCH_TOKEN);
  if(!gate.released){process.send({cancelled:gate.reason});store.close();process.exit(0);}
  store.close();store=open('reconcile');
  const result=acknowledgeFixtureRecovery(store,process.env.FIXTURE_TRANSITION,randomUUID());
  store.close();store=open('normal');acting=true;process.send({acting:result});
}catch(error){process.send({fatal:error.message});store.close();process.exit(1);}
