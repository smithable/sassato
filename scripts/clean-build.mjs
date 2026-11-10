import { rmSync } from 'node:fs';

// Removed modules must not survive an incremental build or leak into npm packages.
rmSync(new URL('../dist',import.meta.url),{recursive:true,force:true});
