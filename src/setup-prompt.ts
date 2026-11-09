import { createInterface } from 'node:readline';
import { check, name } from './errors.js';

/** Collect all input before opening a database; EOF or Ctrl-C cancels setup. */
export async function promptSetup(workspace?: string): Promise<{workspace:string; humans:string[]; actor:string}> {
  const reader = createInterface({input:process.stdin,output:process.stdout,terminal:true});
  const lines = reader[Symbol.asyncIterator]();
  reader.on('SIGINT', () => reader.close());
  const ask = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    const line = await lines.next();
    check(!line.done, 'Setup cancelled; no workspace was created');
    return line.value.trim();
  };
  try {
    process.stdout.write('Names use lowercase letters, digits, underscores or hyphens.\n');
    const selected = name(workspace ?? await ask('Workspace name: '));
    const actor = name(await ask('Your human role name: '));
    const others = await ask('Other human role names (comma-separated, blank for none): ');
    const humans = [actor,...(others ? others.split(',').map(value => name(value.trim())) : [])];
    check(new Set(humans).size === humans.length, 'Human role names must be unique');
    return {workspace:selected,humans,actor};
  } finally {reader.close();}
}
