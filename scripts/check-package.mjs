import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PACKAGE_ROOT, PACKAGE } from '../src/package.mjs';
import { npmCli } from '../src/lifecycle/npm.mjs';

const packed = spawnSync(process.execPath, [npmCli(), 'pack', '--dry-run', '--json'], { cwd: PACKAGE_ROOT, encoding: 'utf8', windowsHide: true });
if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack --dry-run failed');
const [archive] = JSON.parse(packed.stdout);
const allowed = /^(?:bin\/|src\/|skills\/|examples\/|package\.json$|npm-shrinkwrap\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/;
const privatePaths = /(?:C:[\\/]+Users[\\/]+(?:18688|[^\s"'<>]+)[\\/]|D:[\\/]+zlf[\\/]|syfo-work|\.weapp-managed\.json|sk-[A-Za-z0-9_-]{20,})/i;
for (const entry of archive.files) {
  if (!allowed.test(entry.path) || /(?:^|\/)(?:node_modules|backups|\.weapp-evidence)(?:\/|$)/.test(entry.path)) throw new Error(`Unexpected published file: ${entry.path}`);
  const text = fs.readFileSync(path.join(PACKAGE_ROOT, entry.path), 'utf8');
  if (privatePaths.test(text)) throw new Error(`Private path or credential-shaped value in: ${entry.path}`);
}
for (const required of ['bin/weapp.mjs', 'src/cli.mjs', 'src/runtime/weapp.mjs', 'skills/weapp-automation/SKILL.md', 'npm-shrinkwrap.json', 'LICENSE']) {
  if (!archive.files.some(entry => entry.path === required)) throw new Error(`Missing package resource: ${required}`);
}
if (PACKAGE.scripts.postinstall || PACKAGE.scripts.install || PACKAGE.private) throw new Error('Public package must not require installation hooks or be private.');
process.stdout.write(JSON.stringify({ ok: true, name: archive.name, version: archive.version, files: archive.files.length, unpackedSize: archive.unpackedSize, bin: PACKAGE.bin }) + '\n');
