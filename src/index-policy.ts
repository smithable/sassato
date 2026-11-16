import { safe } from './errors.js';

const excludedDirectories=new Set(['.git','node_modules','dist','build','out','target','coverage','.next','.nuxt','.cache','vendor','__snapshots__']);
/** Apply before opening a file. Paths are always repository relative, never executable arguments. */
export function indexablePath(path:string):boolean {
  if(!path || path.length>4096 || /[\x00-\x1f\x7f\\]/.test(path) || path.startsWith('/'))return false;
  const parts=path.split('/'),name=parts.at(-1)!;
  if(parts.some(part=>!part || part==='.' || part==='..' || excludedDirectories.has(part)))return false;
  if(parts.some(part=>/^\.env(?:\.|$)/i.test(part)))return false;
  if(/(?:\.gen\.[^.]+|\.generated\.[^.]+|\.snap|\.map|\.min\.[^.]+|\.pem|\.key|\.p12|\.pfx|\.db(?:-.*)?)$/i.test(name))return false;
  if(/^(?:\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(name))return false;
  try {safe(path);return true;}catch{return false;}
}
export const isCodePath=(path:string):boolean=>/\.(?:[cm]?[jt]sx?)$/i.test(path);
export function safeSource(source:string):boolean {
  if(source.includes('\0'))return false;
  try {safe(source);return true;}catch{return false;}
}
export function safeName(value:string):boolean {
  if(!value || value.length>512 || /[\x00-\x1f\x7f]/.test(value))return false;
  try {safe(value);return true;}catch{return false;}
}
