/** Names and locations only. Source text and declaration initializers never enter the cache. */
export const INDEX_SCHEMA=2;
export const MAX_SOURCE_BYTES=2*1024*1024;
export interface IndexSymbol {name:string;kind:string;line:number;signature:string;exported:boolean;}
export interface IndexImport {specifier:string;line:number;bindings:{local:string;imported:string}[];reexport:boolean;}
export interface IndexUse {name:string;line:number;kind:'call'|'reference'|'named-reference';}
export interface FileAnalysis {
  symbols:IndexSymbol[];
  imports:IndexImport[];
  exports:{name:string;line:number;local?:string;from?:string}[];
  uses:IndexUse[];
  reason?:string;
}
export interface IndexFile extends FileAnalysis {path:string;hash:string;module:string;}
export interface IndexSnapshot {
  schema:number;parser:string;repository:string;commit:string;object_format:string;
  files:IndexFile[];
}
export interface IndexHit {path:string;line:number;name:string;kind:string;signature?:string;relation?:string;related_tests?:string[];}
export interface IndexResult {
  schema:number;repository:string;checkout:string;commit:string;view:string;
  state:'current'|'overlay'|'missing'|'stale';fallback:boolean;reason?:string;
  query:string;items:IndexHit[];total:number;truncated:boolean;
  modules:{path:string;description:string}[];
}
