import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
let errors=0,files=0;
function walk(dir) {
  for(const f of readdirSync(dir,{withFileTypes:true})) {
    const path=join(dir,f.name);
    if(f.isDirectory())walk(path);
    else if(/\.(?:ts|mjs|js)$/.test(path)) {
      files++;const text=readFileSync(path,'utf8');
      function report(message){console.error(`${path}: ${message}`);errors++;}
      if(/^(?:<{7}|={7}|>{7})/m.test(text))report('Unresolved merge marker');
      if(/[ \t]+$/m.test(text))report('Trailing whitespace');
      if(!text.endsWith('\n'))report('Missing final newline');
      const source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
      function visit(node) {
        if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['eval','Function'].includes(node.expression.text))report('Dynamic code execution is not allowed');
        if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='shell'&&node.initializer.kind===ts.SyntaxKind.TrueKeyword)report('Shell command execution is not allowed');
        ts.forEachChild(node,visit);
      }
      visit(source);
    }
  }
}
for(const dir of ['src','bin','scripts','test','examples'])walk(dir);
if(errors)process.exitCode=1;else console.log(`Lint passed (${files} source/script/test files).`);
