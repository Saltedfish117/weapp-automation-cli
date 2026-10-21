import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT, SKILL_NAME } from '../package.mjs';
import { configuration } from './errors.mjs';

export function expandHome(value, userHome) {
  if (value === '~') return userHome;
  if (/^~[/\\]/.test(value)) return path.join(userHome, value.slice(2));
  return path.resolve(value);
}

export function context({ env = process.env, homeDir, platform = process.platform } = {}) {
  const userHome = path.resolve(homeDir ?? env.WEAPP_USER_HOME ?? os.homedir());
  const stateDir = expandHome(env.WEAPP_STATE_DIR ?? path.join(userHome, '.weapp-automation'), userHome);
  const dshHome = expandHome(env.DSH_HOME?.trim() || path.join(userHome, '.dsh'), userHome);
  const agentsHome = expandHome(env.DSH_AGENTS_HOME?.trim() || path.join(userHome, '.agents'), userHome);
  const claudeHome = expandHome(env.CLAUDE_CONFIG_DIR?.trim() || path.join(userHome, '.claude'), userHome);
  const codexHome = expandHome(env.CODEX_HOME?.trim() || path.join(userHome, '.codex'), userHome);
  const ctx = {
    env, platform, userHome, stateDir,
    manifestFile: path.join(stateDir, 'manifest.json'),
    sharedRoot: path.join(userHome, '.agents', 'skills'),
    roots: {
      codex: path.join(codexHome, 'skills'),
      'deepseek-harness': path.join(dshHome, 'skills'),
      'vscode-copilot': path.join(userHome, '.copilot', 'skills'),
      'claude-code': path.join(claudeHome, 'skills'),
    },
    nativeShared: {
      codex: path.join(userHome, '.agents', 'skills'),
      'deepseek-harness': path.join(agentsHome, 'skills'),
      'vscode-copilot': path.join(userHome, '.agents', 'skills'),
      'claude-code': null,
    },
    packageRoot: PACKAGE_ROOT,
  };
  if (samePath(stateDir, userHome) || samePath(stateDir, path.parse(stateDir).root) || inside(stateDir, PACKAGE_ROOT) || inside(PACKAGE_ROOT, stateDir)) {
    throw configuration('State directory must be a dedicated directory outside the package, not home or a filesystem root.', 'unsafe-path');
  }
  return ctx;
}

export function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(a, b) { return a !== null && b !== null && pathKey(a) === pathKey(b); }

export function inside(candidate, root) {
  const rel = path.relative(pathKey(root), pathKey(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function exists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Resolve existing ancestors, including junctions, without following the last
// component. The caller must be able to remove a link rather than its source.
export function physicalParentPath(target) {
  let parent = path.dirname(path.resolve(target));
  const rest = [path.basename(target)];
  while (!exists(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    rest.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...rest);
}

export function assertSkillTarget(target, ctx) {
  const resolved = path.resolve(target);
  if (path.basename(resolved) !== SKILL_NAME) throw configuration(`Skill target must end with ${SKILL_NAME}: ${resolved}`, 'unsafe-path');
  const physical = physicalParentPath(resolved);
  if (samePath(physical, ctx.userHome) || [ctx.stateDir, ctx.packageRoot].some(root => inside(physical, root) || inside(root, physical))) {
    throw configuration(`Skill target overlaps a protected directory: ${resolved}`, 'unsafe-path');
  }
  if (samePath(resolved, path.parse(resolved).root)) throw configuration('Refusing filesystem root.', 'unsafe-path');
  return resolved;
}

export function assertRemoval(target, allowedParent) {
  const absolute = path.resolve(target);
  if (!inside(absolute, allowedParent) || samePath(absolute, allowedParent)) {
    throw configuration(`Refusing removal outside ${allowedParent}: ${target}`, 'unsafe-path');
  }
  const actual = physicalParentPath(absolute);
  const expected = fs.realpathSync(allowedParent);
  if (!inside(actual, expected) || samePath(actual, expected)) throw configuration(`Removal parent changed: ${target}`, 'unsafe-path');
}

export function removeEntry(target, allowedParent) {
  if (!exists(target)) return;
  assertRemoval(target, allowedParent);
  const stat = fs.lstatSync(target);
  // unlink never traverses a directory symlink/junction.
  if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(target);
  else fs.rmSync(target, { recursive: true });
}
