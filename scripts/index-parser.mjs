import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Ship the lockfile-resolved compiler, not a global install or a runtime download.
const require=createRequire(import.meta.url),root=dirname(require.resolve('typescript/package.json'));
mkdirSync('dist/vendor',{recursive:true});
copyFileSync(join(root,'lib/typescript.js'),'dist/vendor/typescript.cjs');
copyFileSync(join(root,'LICENSE.txt'),'dist/vendor/typescript.LICENSE.txt');
