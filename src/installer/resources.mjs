import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKILL_SOURCE } from '../package.mjs';
import { exists, pathKey } from './paths.mjs';

export function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

export function snapshot(target) {
  if (!exists(target)) return { kind: 'missing' };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    return { kind: 'link', linkTarget: path.resolve(path.dirname(target), fs.readlinkSync(target)) };
  }
  if (!stat.isDirectory()) return { kind: 'file', hash: hash(fs.readFileSync(target)) };
  const files = {};
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      const full = path.join(dir, entry.name);
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) files[relative] = `link:${fs.readlinkSync(full)}`;
      else if (info.isDirectory()) {
        files[relative + '/'] = 'directory';
        visit(full, relative + '/');
      } else if (info.isFile()) files[relative] = hash(fs.readFileSync(full));
      else files[relative] = 'special';
    }
  }
  visit(target);
  return { kind: 'directory', files };
}

export function equalSnapshot(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'link') return pathKey(a.linkTarget) === pathKey(b.linkTarget);
  if (a.kind === 'directory') {
    const keys = Object.keys(a.files).sort();
    return keys.length === Object.keys(b.files).length && keys.every(key => a.files[key] === b.files[key]);
  }
  return a.kind === 'missing' || a.hash === b.hash;
}

export function readSkill(source = SKILL_SOURCE) {
  const summary = snapshot(source);
  if (summary.kind !== 'directory' || !summary.files['SKILL.md']) throw new Error(`Skill resources are missing: ${source}`);
  if (Object.values(summary.files).some(value => value.startsWith('link:') || value === 'special')) throw new Error('Published skill resources must contain only ordinary files and directories.');
  return { source, snapshot: summary, hash: hash(JSON.stringify(Object.entries(summary.files).sort())) };
}

export function materializeSkill(skill, destination) {
  fs.mkdirSync(destination, { recursive: false });
  for (const relative of Object.keys(skill.snapshot.files).filter(key => key.endsWith('/')).sort((a, b) => a.length - b.length)) {
    fs.mkdirSync(path.join(destination, relative), { recursive: true });
  }
  for (const relative of Object.keys(skill.snapshot.files).filter(key => !key.endsWith('/'))) {
    fs.copyFileSync(path.join(skill.source, relative), path.join(destination, relative));
  }
}

// Node 22.18 on Windows can abort the entire process in fs.cpSync for a
// Unicode source path. Copy explicitly, and never recurse through links.
export function copyEntry(source, destination) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) {
    const rawTarget = fs.readlinkSync(source);
    let directory = false;
    try { directory = fs.statSync(source).isDirectory(); } catch { /* preserve a dangling file link */ }
    const target = process.platform === 'win32' && directory ? path.resolve(path.dirname(source), rawTarget) : rawTarget;
    fs.symlinkSync(target, destination, process.platform === 'win32' && directory ? 'junction' : directory ? 'dir' : 'file');
  } else if (info.isDirectory()) {
    fs.mkdirSync(destination);
    for (const entry of fs.readdirSync(source)) copyEntry(path.join(source, entry), path.join(destination, entry));
  } else if (info.isFile()) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  else throw new Error(`Cannot back up special filesystem entry: ${source}`);
}
