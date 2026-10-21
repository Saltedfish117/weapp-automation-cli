import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PACKAGE } from '../package.mjs';
import { configuration, SetupError } from './errors.mjs';
import { exists, assertSkillTarget, physicalParentPath, pathKey } from './paths.mjs';

export function resourceKey(target) { return pathKey(physicalParentPath(target)); }

export function emptyState() {
  return { schemaVersion: 1, package: { name: PACKAGE.name, version: PACKAGE.version }, resources: {}, bindings: {} };
}

export function readState(ctx) {
  if (!exists(ctx.manifestFile)) return emptyState();
  let state;
  try { state = JSON.parse(fs.readFileSync(ctx.manifestFile, 'utf8')); }
  catch (cause) { throw configuration(`Cannot read installation manifest: ${ctx.manifestFile}`, 'bad-manifest', { cause: cause.message }); }
  if (state.schemaVersion !== 1 || !state.resources || !state.bindings || typeof state.resources !== 'object' || typeof state.bindings !== 'object' || Array.isArray(state.resources) || Array.isArray(state.bindings)) {
    throw configuration(`Unsupported or corrupt installation manifest: ${ctx.manifestFile}`, 'bad-manifest');
  }
  for (const record of Object.values(state.resources)) {
    if (!record || typeof record.path !== 'string' || !['directory', 'link'].includes(record.snapshot?.kind)) throw configuration('Invalid managed resource.', 'bad-manifest');
    assertSkillTarget(record.path, ctx);
    if (record.snapshot.kind === 'directory' && (!record.snapshot.files || typeof record.snapshot.files !== 'object')) throw configuration('Invalid managed file hashes.', 'bad-manifest');
    if (record.snapshot.kind === 'link' && typeof record.snapshot.linkTarget !== 'string') throw configuration('Invalid managed link.', 'bad-manifest');
  }
  for (const binding of Object.values(state.bindings)) {
    if (!binding || !['shared', 'copy'].includes(binding.mode) || typeof binding.path !== 'string') throw configuration('Invalid agent binding.', 'bad-manifest');
    assertSkillTarget(binding.path, ctx);
    if (binding.sharedPath) assertSkillTarget(binding.sharedPath, ctx);
  }
  return state;
}

export function atomicJson(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temporary, file); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function withInstallLock(ctx, work) {
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  const file = path.join(ctx.stateDir, 'install.lock');
  const token = crypto.randomUUID();
  if (exists(file)) {
    let holder;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* incomplete lock */ }
    if (holder?.pid && alive(holder.pid)) throw new SetupError('Another installer is active.', { code: 'installer-busy', data: { pid: holder.pid, file } });
    if (!holder?.pid && Date.now() - fs.statSync(file).mtimeMs < 30_000) throw new SetupError('An installer lock is being initialized.', { code: 'installer-busy' });
    fs.unlinkSync(file);
  }
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
  catch (cause) { throw new SetupError('Could not acquire installation lock.', { code: 'installer-busy', cause }); }
  try { return work(); }
  finally {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch { /* keep another owner's lock */ }
  }
}

export function pendingTransactions(ctx) {
  const root = path.join(ctx.stateDir, 'transactions');
  if (!exists(root)) return [];
  return fs.readdirSync(root).filter(name => name.endsWith('.json')).map(name => path.join(root, name));
}
