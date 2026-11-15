#!/usr/bin/env node
/**
 * Build a clean runtime folder and ZIP:
 *   dist/openchamber-discord-rpc/ and dist/openchamber-discord-rpc-<version>.zip
 *
 * Only files the OpenChamber installer needs are copied: source, tests,
 * node_modules and the development scripts stay out.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'dist', 'openchamber-discord-rpc');
const zip = path.join(root, 'dist', `openchamber-discord-rpc-${pkg.version}.zip`);

await rm(path.join(root, 'dist'), { recursive: true, force: true });
await mkdir(output, { recursive: true });

const runtimePackage = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  license: pkg.license,
  description: pkg.description,
  openchamber: pkg.openchamber,
};
await writeFile(path.join(output, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8');
for (const file of ['README.md', 'LICENSE']) {
  await cp(path.join(root, file), path.join(output, file));
}
for (const directory of ['panel', 'service', 'assets']) {
  await cp(path.join(root, directory), path.join(output, directory), { recursive: true });
}

const result = spawnSync('zip', ['-qr', zip, 'openchamber-discord-rpc'], {
  cwd: path.join(root, 'dist'),
  stdio: 'inherit',
});
if (result.error?.code === 'ENOENT') {
  console.log('zip is not installed; the clean folder is still ready to install.');
} else if (result.status !== 0) {
  process.exit(result.status ?? 1);
} else {
  console.log(`Wrote ${path.relative(root, zip)}`);
}
console.log(`Wrote ${path.relative(root, output)}/`);
