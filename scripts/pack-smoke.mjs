import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve('.'),dir=mkdtempSync(join(tmpdir(),'sassato-pack-'));
function run(command,args,cwd=dir,env={}) {
  const r=spawnSync(command,args,{cwd,encoding:'utf8',env:{...process.env,...env},timeout:60_000});
  assert.equal(r.status,0,`${command} ${args.join(' ')}\n${r.stderr}\n${r.stdout}`);return r.stdout;
}
try {
  // --ignore-scripts: caller already built; smoke must not rely on build tooling in tarball.
  const packed=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',dir],root))[0];
  const tarball=join(dir,packed.filename);run('tar',['-xzf',tarball,'-C',dir]);
  const pkg=join(dir,'package');assert.ok(existsSync(join(pkg,'dist','cli.js')));assert.ok(!existsSync(join(pkg,'node_modules')));
  for(const required of ['dist/build-info.json','dist/context-advice.js','dist/checkpoints.js','docs/commands.md','docs/architecture.md','docs/permissions.md','docs/benchmark.md','docs/integrations.md','examples/claude-hook.mjs','examples/team.config.json','docs/configuration.md','docs/compatibility.md','docs/context-management.md','CONTRIBUTING.md','SECURITY.md','LICENSE'])assert.ok(packed.files.some(f=>f.path===required),`Missing package resource ${required}`);
  assert.ok(!packed.files.some(f=>/docs\/checkpoint|HANDOFF|implementation-plan|\.artifacts|smithable.config|\.db$|node_modules/.test(f.path)));
  const info=JSON.parse(run(process.execPath,[join(pkg,'bin','sassato.js'),'--version','--json']));assert.match(info.build,/^[0-9a-f]{16}$/);
  const clean=join(dir,'clean'),cache=join(dir,'cache');mkdirSync(clean);
  const db=join(clean,'state.db'),env={npm_config_cache:cache,npm_config_registry:'http://127.0.0.1:9',SASSATO_DB:db,SASSATO_WORKSPACE:'packtest',SASSATO_ROLE:''};
  assert.equal(JSON.parse(run(process.execPath,[join(pkg,'bin','sassato.js'),'init','--json'],clean,env)).created,true);
  // Local tarball only: no network registry or globally installed Sassato/TypeScript needed.
  const npx=['exec','--offline','--yes','--package',tarball,'--'];
  const task=JSON.parse(run('npm',[...npx,'sassato','add','Packed CLI works','--as','builder','--json'],clean,env));
  assert.equal(task.id,'T1');
  const tasks=JSON.parse(run('npm',[...npx,'sas','tasks','--json'],clean,env));assert.equal(tasks.items[0].id,'T1');
  const stopped=JSON.parse(run('npm',[...npx,'sas','stop','--as','human','--no-wait','--json'],clean,env));
  assert.equal(stopped.complete,true);assert.ok(stopped.statuses.every(row=>row.state==='inactive'));
  run('npm',[...npx,'sas','resume-work','--as','human','--json'],clean,env);
  const checkpoint=JSON.parse(run('npm',[...npx,'sas','checkpoint','save','--current','Package verified','--next','Review next task','--notes','No jobs; CLI smoke passed','--as','builder','--json'],clean,env));
  assert.equal(checkpoint.wip_version,1);
  const advice=JSON.parse(run('npm',[...npx,'sas','context','advise','--relation','same','--pressure','high','--jobs','idle','--as','builder','--json'],clean,env));
  assert.equal(advice.recommendation,'compact');assert.equal(advice.advisory,true);
  run('npm',[...npx,'sas','send','reviewer','Packed urgent message','--urgent','--as','builder','--json'],clean,env);
  const notification=JSON.parse(run('npm',[...npx,'sas','wait','--urgent','--as','reviewer','--timeout','1','--stop-file',join(clean,'no-stop'),'--json'],clean,env));assert.equal(notification.reason,'urgent');
  console.log(JSON.stringify({ok:true,tarball:packed.filename,files:packed.files.length,size:packed.size,node:process.version,tests:['unpacked Node CLI','offline npx sassato','offline npx sas alias','packaged stop/resume','build identity','packaged checkpoint/advice','packaged urgent wait','no compiler/runtime dependencies']},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
