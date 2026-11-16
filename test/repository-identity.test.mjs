import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeRepositoryIdentity,repositoryFingerprint,checkoutFingerprint,insideCheckout } from '../dist/repository-identity.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sassato-identity-')),root=join(dir,'original');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(root);
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(root,'init','-b','main');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','Initial');
  return {dir,root,git};
}
test('linked worktrees share repository identity; clones and checkouts remain distinct',t=>{
  const {dir,root,git}=fixture(t),linked=join(dir,'linked'),clone=join(dir,'clone');
  git(root,'worktree','add','-b','feature',linked);git(dir,'clone',root,clone);
  const a=probeRepositoryIdentity(root),b=probeRepositoryIdentity(linked),c=probeRepositoryIdentity(clone);
  assert.equal(repositoryFingerprint(a),repositoryFingerprint(b));
  assert.notEqual(repositoryFingerprint(a),repositoryFingerprint(c));
  assert.notEqual(checkoutFingerprint(a),checkoutFingerprint(b));
  assert.notEqual(checkoutFingerprint(a),checkoutFingerprint(c));
  assert.equal(a.head,b.head);assert.equal(a.head,c.head);
  git(linked,'switch','--detach');writeFileSync(join(linked,'dirty.txt'),'Preserve me');
  const detached=probeRepositoryIdentity(linked);
  assert.equal(detached.branch,null);assert.equal(checkoutFingerprint(detached),checkoutFingerprint(b));
});
test('subdirectories and aliases resolve to the same checkout without changing the requested cwd',t=>{
  const {dir,root}=fixture(t),sub=join(root,'src');mkdirSync(sub);
  const alias=join(dir,'alias');symlinkSync(root,alias);
  const a=probeRepositoryIdentity(root),b=probeRepositoryIdentity(join(alias,'src'));
  assert.equal(checkoutFingerprint(a),checkoutFingerprint(b));assert.equal(b.working_dir,sub);
  assert.equal(insideCheckout(root,root+'-other'),false);assert.equal(insideCheckout(root,sub),true);
  assert.equal(insideCheckout(root,join(root,'..')),false);
});
test('replacement at the same path changes physical identity and a missing checkout fails closed',t=>{
  const {dir,root,git}=fixture(t),before=probeRepositoryIdentity(root);
  renameSync(root,join(dir,'old'));assert.throws(()=>probeRepositoryIdentity(root));
  mkdirSync(root);git(root,'init','-b','main');
  const after=probeRepositoryIdentity(root);
  assert.equal(after.head,null);assert.notEqual(repositoryFingerprint(before),repositoryFingerprint(after));
  assert.notEqual(checkoutFingerprint(before),checkoutFingerprint(after));
});
test('ambient Git directory overrides cannot redirect identity to another checkout',t=>{
  const {dir,root,git}=fixture(t),clone=join(dir,'clone');git(dir,'clone',root,clone);
  const expected=probeRepositoryIdentity(clone),old=process.env.GIT_DIR;
  process.env.GIT_DIR=join(root,'.git');
  try {assert.deepEqual(probeRepositoryIdentity(clone),expected);}
  finally {if(old===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=old;}
});
