import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const hash=createHash('sha256');
function add(path) {hash.update(path+'\0');hash.update(readFileSync(path));hash.update('\0');}
function walk(dir) {
  for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;
    const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else add(path);
  }
}
for(const dir of ['src','bin','scripts','examples'])walk(dir);
add('package.json');add('package-lock.json');add('tsconfig.json');
const {version}=JSON.parse(readFileSync('package.json','utf8'));
writeFileSync('dist/build-info.json',JSON.stringify({version,build:hash.digest('hex').slice(0,16),built_at:new Date().toISOString()})+'\n');
