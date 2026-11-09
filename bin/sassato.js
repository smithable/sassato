#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 13)) {
  console.error('sassato requires Node.js 24.13 or newer.');
  process.exitCode = 2;
} else {
  const { main } = await import('../dist/cli.js');
  await main();
}
