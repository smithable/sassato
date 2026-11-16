import { createRequire } from 'node:module';
import type TS from 'typescript';
import { MAX_SOURCE_BYTES, type FileAnalysis, type IndexSymbol } from './index-types.js';
import { safeName, safeSource } from './index-policy.js';

// The build copies the pinned compiler and its license. Ordinary commands never load it.
const ts:typeof TS=createRequire(import.meta.url)('./vendor/typescript.cjs');
export const parserVersion=ts.version;

export function analyzeSource(path:string,source:string):FileAnalysis {
  const result:FileAnalysis={symbols:[],imports:[],exports:[],uses:[]};
  if(Buffer.byteLength(source)>MAX_SOURCE_BYTES) return {...result,reason:'Source exceeds analysis size limit'};
  if(!safeSource(source))return {...result,reason:'Secret-like or binary content excluded'};
  const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  const line=(node:TS.Node)=>file.getLineAndCharacterOfPosition(node.getStart(file)).line+1;
  const exported=(node:TS.Node)=>ts.canHaveModifiers(node)&&Boolean(ts.getModifiers(node)?.some(mod=>mod.kind===ts.SyntaxKind.ExportKeyword));
  const defaultExport=(node:TS.Node)=>ts.canHaveModifiers(node)&&Boolean(ts.getModifiers(node)?.some(mod=>mod.kind===ts.SyntaxKind.DefaultKeyword));
  const nameOf=(node:TS.Node|undefined):string|undefined=>node&&(ts.isIdentifier(node)||ts.isStringLiteral(node)||ts.isNumericLiteral(node))&&safeName(node.text)?node.text:undefined;
  // Do not copy raw type text: literal types/default values can contain credentials or prose.
  const typeName=(type:TS.TypeNode|undefined):string=>{
    if(!type)return '';
    if(ts.isTypeReferenceNode(type))return nameOf(type.typeName)??'type';
    if(ts.isArrayTypeNode(type))return `${typeName(type.elementType)||'unknown'}[]`;
    return new Map<number,string>([[ts.SyntaxKind.StringKeyword,'string'],[ts.SyntaxKind.NumberKeyword,'number'],[ts.SyntaxKind.BooleanKeyword,'boolean'],[ts.SyntaxKind.VoidKeyword,'void'],[ts.SyntaxKind.UnknownKeyword,'unknown'],[ts.SyntaxKind.AnyKeyword,'any'],[ts.SyntaxKind.NeverKeyword,'never']]).get(type.kind)??'type';
  };
  const parameters=(node:TS.SignatureDeclarationBase)=>node.parameters.map(param=>{
    const type=typeName(param.type);return `${nameOf(param.name)??'pattern'}${param.questionToken?'?':''}${type?': '+type:''}`;
  }).join(', ');
  const add=(node:TS.Node,name:string|undefined,kind:string,signature:string,isExport=false)=>{
    if(!name || !safeName(name))return;
    const item:IndexSymbol={name,kind,line:line(node),signature:signature.slice(0,512),exported:isExport};
    result.symbols.push(item);
    if(isExport)result.exports.push({name:defaultExport(node)?'default':name,local:name});
  };
  const visit=(node:TS.Node):void=>{
    if(ts.isFunctionDeclaration(node)) {
      const name=nameOf(node.name)??(defaultExport(node)?'default':undefined);
      add(node,name,'function',`function ${name}(${parameters(node)})`,exported(node));
    } else if(ts.isVariableDeclaration(node)) {
      const name=nameOf(node.name),parent=node.parent.parent;
      const fn=node.initializer&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))?node.initializer:undefined;
      add(node,name,fn?'function':'variable',`${fn?'function':'const'} ${name}${fn?`(${parameters(fn)})`:''}`,exported(parent));
    } else if(ts.isClassDeclaration(node)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isEnumDeclaration(node)) {
      const name=nameOf(node.name)??(defaultExport(node)?'default':undefined);
      const kind=ts.isClassDeclaration(node)?'class':ts.isInterfaceDeclaration(node)?'interface':ts.isEnumDeclaration(node)?'enum':'type';
      add(node,name,kind,`${kind} ${name}`,exported(node));
    } else if(ts.isMethodDeclaration(node)) {
      const parent=ts.isClassDeclaration(node.parent)||ts.isClassExpression(node.parent)?nameOf(node.parent.name):undefined;
      const method=nameOf(node.name),name=parent&&method?`${parent}.${method}`:method;
      add(node,name,'method',`${name}(${parameters(node)})`);
    }
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&safeName(node.moduleSpecifier.text)) {
      const bindings:{local:string;imported:string}[]=[],clause=node.importClause;
      if(clause?.name)bindings.push({local:clause.name.text,imported:'default'});
      if(clause?.namedBindings) {
        if(ts.isNamespaceImport(clause.namedBindings))bindings.push({local:clause.namedBindings.name.text,imported:'*'});
        else for(const part of clause.namedBindings.elements)bindings.push({local:part.name.text,imported:part.propertyName?.text??part.name.text});
      }
      result.imports.push({specifier:node.moduleSpecifier.text,line:line(node),bindings,reexport:false});
    }
    if(ts.isExportDeclaration(node)) {
      const from=node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)?node.moduleSpecifier.text:undefined;
      if(from&&!safeName(from))return;
      if(from)result.imports.push({specifier:from,line:line(node),bindings:[],reexport:true});
      if(node.exportClause&&ts.isNamedExports(node.exportClause))for(const part of node.exportClause.elements)result.exports.push({name:part.name.text,local:part.propertyName?.text??part.name.text,...(from?{from}:{})});
      else if(from)result.exports.push({name:'*',from});
    }
    if(ts.isCallExpression(node)) {
      const name=ts.isIdentifier(node.expression)?node.expression.text:ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:undefined;
      if(name&&safeName(name))result.uses.push({name,line:line(node),kind:'call'});
      if((ts.isIdentifier(node.expression)&&node.expression.text==='require'||node.expression.kind===ts.SyntaxKind.ImportKeyword)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&safeName(node.arguments[0].text))result.imports.push({specifier:node.arguments[0].text,line:line(node),bindings:[],reexport:false});
    }
    if(ts.isIdentifier(node)&&safeName(node.text))result.uses.push({name:node.text,line:line(node),kind:'reference'});
    ts.forEachChild(node,visit);
  };
  visit(file);
  const seen=new Set<string>();
  result.uses=result.uses.filter(use=>{const key=`${use.name}:${use.line}:${use.kind}`;if(seen.has(key))return false;seen.add(key);return true;});
  return result;
}

/** Query-only operation dispatch hints. Arbitrary source literals are never cached as names. */
export function namedReferences(path:string,source:string,name:string):FileAnalysis['uses'] {
  if(!/^[A-Za-z_$][\w$]{0,127}$/.test(name)||!source.includes(name)||!safeSource(source))return [];
  const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),uses:FileAnalysis['uses']=[];
  const visit=(node:TS.Node):void=>{
    if(ts.isCallExpression(node))for(const arg of node.arguments)if(ts.isStringLiteral(arg)&&arg.text===name)uses.push({name,line:file.getLineAndCharacterOfPosition(arg.getStart(file)).line+1,kind:'named-reference'});
    ts.forEachChild(node,visit);
  };
  visit(file);return uses;
}
