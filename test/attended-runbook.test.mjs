import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const doc=readFileSync('docs/attended-supervisor.md','utf8');

test('the evidence block restores every probe variable it uses from what trial.json records',()=>{
  const block=doc.split('```bash\n').map(part=>part.split('\n```')[0]).find(part=>part.includes('git-log.txt'));
  const recorded=[...doc.match(/'trial\.json'\)\.write_text\(json\.dumps\(\{(.*?)\}/)[1].matchAll(/'(\w+)':/g)].map(m=>m[1]);
  const restored=new Map([...block.matchAll(/^(PROBE_\w+)=.*\["(\w+)"\]/gm)].map(m=>[m[1],m[2]]));
  for(const [,name] of block.matchAll(/\$(PROBE_\w+)/g))assert.ok(recorded.includes(restored.get(name)),name+' is not restored from trial.json');
});
