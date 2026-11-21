import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const helper=fileURLToPath(new URL('../bin/attended-pty.py',import.meta.url));
const logLimit=8*1024*1024;
const input=Buffer.alloc(512*1024);
for(let i=0;i<input.length;i++) input[i]=i%251;

async function until(check,label){
  const deadline=Date.now()+6000;
  while(!check()){
    if(Date.now()>deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

test('the PTY drains output while input backs up, preserves input, and bounds terminal evidence',{skip:process.platform!=='linux',timeout:20000},async()=>{
  // Keep the Unix socket pathname short to match the holder's production constraint.
  const dir=mkdtempSync(join(tmpdir(),'sas-pty-'));
  const fixture=join(dir,'provider.py'), socketPath=join(dir,'terminal.sock');
  const log=join(dir,'terminal.log'), ready=join(dir,'ready'), emit=join(dir,'emit');
  const drain=join(dir,'drain'), read=join(dir,'read'), finish=join(dir,'finish');
  writeFileSync(fixture,`
import os
import tty
from pathlib import Path
from time import sleep

def wait(name):
    while not Path(name).exists():
        sleep(0.01)

tty.setraw(0)
Path("ready").write_text(str(os.getpid()))
wait("emit")
chunk = b"x" * 65536
for _ in range(129):
    rest = memoryview(chunk)
    while rest:
        rest = rest[os.write(1, rest):]
os.write(1, b"after-log-limit")
wait("drain")
with open("read.partial", "wb") as saved:
    left = 512 * 1024
    while left:
        data = os.read(0, min(left, 65536))
        saved.write(data)
        left -= len(data)
os.rename("read.partial", "read")
wait("finish")
`);
  const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
  const holder=spawn(python,['-B',helper,'holder',dir,python,fixture],{cwd:dir,stdio:'ignore'});
  const exited=once(holder,'exit');
  let client, ended=false;
  const exit=exited.then(result=>{ended=true;return result;});
  try{
    await until(()=>existsSync(ready),'provider readiness');
    client=createConnection(socketPath);
    let received=0, last=Buffer.alloc(0);
    client.on('data',data=>{
      received+=data.length;
      last=Buffer.concat([last,data]).subarray(-64);
    });
    client.on('error',()=>{});
    await once(client,'connect');
    client.write(input);
    // Let the holder reach the full PTY input buffer before the provider writes output.
    await delay(200);
    writeFileSync(emit,'');
    await until(()=>last.includes('after-log-limit'),'live output past the log limit before input is read');
    assert.equal(received,129*65536+'after-log-limit'.length);
    assert.equal(statSync(log).size,logLimit);
    writeFileSync(drain,'');
    await until(()=>existsSync(read),'the queued input to drain');
    assert.deepEqual(readFileSync(read),input);
    assert.equal(statSync(log).size,logLimit);
    const detached=once(client,'close');
    client.end();
    await detached;
    client=createConnection(socketPath);
    let replay=Buffer.alloc(0);
    client.on('error',()=>{});
    client.on('data',data=>{replay=Buffer.concat([replay,data]);});
    await once(client,'connect');
    await until(()=>replay.includes('after-log-limit'),'recent output on reattach');
    assert.equal(replay.length,65536);
    writeFileSync(finish,'');
    await until(()=>ended,'holder exit');
    assert.deepEqual(await exit,[0,null]);
    const result=JSON.parse(readFileSync(join(dir,'holder-result.json'),'utf8'));
    assert.equal(result.reaped,true);
    assert.equal(result.wait_status,0);
  }finally{
    client?.destroy();
    if(!ended&&existsSync(ready)){
      try{process.kill(Number(readFileSync(ready,'utf8')),'SIGKILL');}
      catch(error){if(error.code!=='ESRCH') throw error;}
      await Promise.race([exit,delay(500)]);
    }
    if(!ended){
      holder.kill();
      await exit;
    }
    rmSync(dir,{recursive:true,force:true});
  }
});
