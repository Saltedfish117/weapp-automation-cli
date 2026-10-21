import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE } from '../package.mjs';
import { detectAgents } from '../agents/index.mjs';
import { context, exists, samePath } from './paths.mjs';
import { readState, pendingTransactions } from './state.mjs';
import { snapshot, equalSnapshot } from './resources.mjs';

export function listSkills(ctx = context()) {
  const state = readState(ctx);
  const resources = Object.values(state.resources).map(record => {
    const actual = snapshot(record.path);
    let status = actual.kind === 'missing' ? 'missing' : equalSnapshot(actual, record.snapshot) ? 'healthy' : 'modified';
    if (actual.kind === 'link') {
      try { if (!fs.statSync(record.path).isDirectory()) status = 'broken-link'; }
      catch { status = 'broken-link'; }
    }
    const referencedBy = Object.values(state.bindings).filter(binding => samePath(binding.path, record.path) || (binding.sharedPath && samePath(binding.sharedPath, record.path))).map(binding => binding.agentId);
    return { ...record, status, referencedBy, orphaned: referencedBy.length === 0 };
  });
  return {
    package: { name: PACKAGE.name, version: PACKAGE.version },
    stateDir: ctx.stateDir, manifest: exists(ctx.manifestFile) ? ctx.manifestFile : null,
    agents: detectAgents(ctx), bindings: Object.values(state.bindings), resources,
    recovery: pendingTransactions(ctx),
    loaded: 'not-verified',
    healthy: resources.every(record => record.status === 'healthy' && record.packageVersion === PACKAGE.version) && pendingTransactions(ctx).length === 0,
    next: resources.some(record => record.packageVersion !== PACKAGE.version) ? 'weapp skills sync' : null,
  };
}

export function installationHealth(ctx = context()) {
  try { return listSkills(ctx); }
  catch (error) { return { healthy: false, stateDir: ctx.stateDir, error: { code: error.code ?? 'inspection-failed', message: error.message } }; }
}
