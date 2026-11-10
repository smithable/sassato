import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { type Row } from './storage.js';
import { check, safe, text } from './errors.js';
import { validateBusyChecks } from './busy-checks.js';

export function configPath(value: string, base = process.cwd()): string {
  text(value,'path',4096);
  return value.startsWith('~/') ? resolve(homedir(),value.slice(2)) : resolve(base,value);
}
export function workingDirectory(value: string, base = process.cwd()): string {
  const path=configPath(value,base);
  check(existsSync(path)&&statSync(path).isDirectory(),`Working directory must be an existing directory: ${path}`);
  return realpathSync(path);
}
/** Freeze and resolve the configuration once, before preview or mutation. */
export function loadConfig(path: string): Row {
  const absolute=realpathSync(configPath(path)),base=dirname(absolute);
  const input=JSON.parse(readFileSync(absolute,'utf8'));
  check(input&&typeof input==='object'&&!Array.isArray(input),'Config must be an object');safe(input);
  const allowed=['workspace','working_dir','default_human','import_timezone','stop_file','busy_checks','import_answer_markers','roles'];
  for(const key of Object.keys(input))check(allowed.includes(key),`Unknown config field: ${key}`);
  const config:Row={...input};
  if(config.working_dir!==undefined)config.working_dir=workingDirectory(config.working_dir,base);
  if(config.stop_file!=null)config.stop_file=configPath(config.stop_file,base);
  if(config.busy_checks!==undefined)config.busy_checks=validateBusyChecks(config.busy_checks,base);
  if(config.roles!==undefined) {
    check(Array.isArray(config.roles),'Config roles must be an array');
    config.roles=config.roles.map((role:Row)=>{
      check(role&&typeof role==='object'&&!Array.isArray(role),'Each role config must be an object');
      const result={...role};
      if(result.working_dir!==undefined&&result.working_dir!==null)result.working_dir=workingDirectory(result.working_dir,base);
      else if(config.working_dir!==undefined&&result.kind!=='human')result.working_dir=config.working_dir;
      return result;
    });
  }
  return config;
}
