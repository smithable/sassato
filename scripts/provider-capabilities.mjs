import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Interface discovery only: no login, model call, server startup or settings write.
// Never include raw provider output: diagnostics can contain local/account details.
function probe(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8',timeout:15_000,maxBuffer:2_000_000,shell:false});
  return {ok:!result.error&&result.status===0,exit_code:result.status,text:result.stdout??''};
}
const codexVersion=probe('codex',['--version']), codexHelp=probe('codex',['--help']);
const claudeVersion=probe('claude',['--version']), claudeHelp=probe('claude',['--help']);
const report={
  report_version:1,observed_at:new Date().toISOString(),platform:process.platform,
  scope:'Installed CLI and protocol discovery only; no live transition compatibility established.',
  codex:{
    available:codexVersion.ok,version:codexVersion.text.match(/codex-cli\s+(\S+)/)?.[1]??null,
    remote_tui_flag:codexHelp.ok&&/--remote\s/.test(codexHelp.text),
    protocol_generated:false,protocol_methods:{},protocol_events:{},live_validated:false
  },
  claude:{
    available:claudeVersion.ok,version:claudeVersion.text.match(/^(\d+\.\d+\.\d+)\s+\(Claude Code\)/)?.[1]??null,
    print_flag:claudeHelp.ok&&/--print\s/.test(claudeHelp.text),
    streaming_input_flag:claudeHelp.ok&&/--input-format\s/.test(claudeHelp.text),
    explicit_session_flag:claudeHelp.ok&&/--session-id\s/.test(claudeHelp.text),
    explicit_resume_flag:claudeHelp.ok&&/--resume\s/.test(claudeHelp.text),
    live_validated:false
  }
};
if(codexVersion.ok) {
  const directory=mkdtempSync(join(tmpdir(),'sassato-provider-schema-'));
  try {
    const generated=probe('codex',['app-server','generate-json-schema','--out',directory]);
    if(generated.ok) {
      const requests=readFileSync(join(directory,'ClientRequest.json'),'utf8');
      const notifications=readFileSync(join(directory,'ServerNotification.json'),'utf8');
      JSON.parse(requests);JSON.parse(notifications);
      report.codex.protocol_generated=true;
      for(const method of ['thread/start','thread/resume','thread/compact/start','turn/start','turn/interrupt']) {
        report.codex.protocol_methods[method]=requests.includes(`"${method}"`);
      }
      for(const event of ['contextCompaction','item/started','item/completed','turn/completed']) {
        report.codex.protocol_events[event]=notifications.includes(`"${event}"`);
      }
    }
  } catch {
    // Missing or changed generated schemas mean unconfirmed, never implied support.
    report.codex.protocol_generated=false;
  } finally {rmSync(directory,{recursive:true,force:true});}
}
console.log(JSON.stringify(report,null,2));
