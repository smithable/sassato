import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const doc=readFileSync('docs/attended-supervisor.md','utf8');

test('the evidence block restores the probe database and repository from trial.json before using them',()=>{
  const lines=doc.split('```bash\n').map(part=>part.split('\n```')[0]).find(part=>part.includes('git-log.txt')).split('\n');
  const recorded=[...doc.match(/'trial\.json'\)\.write_text\(json\.dumps\(\{(.*?)\}/)[1].matchAll(/'(\w+)':/g)].map(m=>m[1]);
  assert.ok(lines.findIndex(line=>line.startsWith('set -e'))>=0);
  const restored={};
  for(const line of lines){
    for(const [,name] of line.matchAll(/\$\{?(PROBE_\w+)/g))assert.ok(restored[name],name+' is used before it is restored');
    const set=line.match(/^(PROBE_\w+)=.*\["(\w+)"\].*trial\.json/);
    if(set){assert.ok(recorded.includes(set[2]),set[2]+' is not recorded');restored[set[1]]=set[2];}
  }
  assert.deepEqual(restored,{PROBE_DB:'database',PROBE_REPO:'repository'});
});
