import path from 'node:path';
import { AGENTS, agentIds } from '../agents/index.mjs';
import { PACKAGE, SKILL_NAME } from '../package.mjs';
import { context, assertSkillTarget, expandHome, samePath, inside } from './paths.mjs';
import { configuration } from './errors.mjs';
import { readState, resourceKey } from './state.mjs';
import { readSkill, snapshot, equalSnapshot } from './resources.mjs';

function basePlan(action, ctx) {
  const state = readState(ctx);
  return {
    action, package: { name: PACKAGE.name, version: PACKAGE.version },
    operations: [], conflicts: [], skipped: [], warnings: [], bindings: [],
    stateBefore: state, stateAfter: structuredClone(state), stateDir: ctx.stateDir,
  };
}

function addWrite(plan, target, desired, ctx, { skill, shared = false, conflict = 'error' } = {}) {
  assertSkillTarget(target, ctx);
  const key = resourceKey(target);
  const present = snapshot(target);
  const record = plan.stateBefore.resources[key];
  const managed = record && equalSnapshot(present, record.snapshot);
  const same = equalSnapshot(present, desired);
  const existingOperation = plan.operations.find(op => resourceKey(op.path) === key);
  if (existingOperation) {
    if (!equalSnapshot(existingOperation.desired, desired)) throw configuration(`Overlapping skill targets: ${target}`, 'overlapping-targets');
    return;
  }
  const collision = present.kind !== 'missing' && !managed;
  const status = same && managed ? 'unchanged' : collision && conflict !== 'backup' ? 'conflict' : present.kind === 'missing' ? 'create' : 'replace';
  const op = { path: target, action: status, before: present, desired, kind: desired.kind, shared, ...(skill ? { source: skill.source, skillHash: skill.hash } : {}) };
  if (collision) {
    op.reason = record ? 'user-modified' : 'not-managed';
    if (conflict !== 'backup') plan.conflicts.push({ path: target, reason: op.reason, resolution: 'Use --conflict backup after reviewing this target.' });
  }
  plan.operations.push(op);
  plan.stateAfter.resources[key] = {
    path: target, snapshot: desired, shared,
    packageVersion: PACKAGE.version, ...(skill ? { skillHash: skill.hash } : {}),
    installedAt: record?.installedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

export function buildInstallPlan(options, ctx = context(), skill = readSkill()) {
  if (!['shared', 'copy', 'cli-only'].includes(options.mode)) throw configuration('--mode must be shared, copy or cli-only.', 'missing-mode');
  if (options.conflict && !['error', 'backup'].includes(options.conflict)) throw configuration('--conflict must be error or backup.', 'bad-conflict-policy');
  if (options.mode === 'cli-only' && (options.agents || options.sharedDir)) throw configuration('cli-only does not accept agents or shared-dir.', 'conflicting-flags');
  if (options.mode === 'copy' && options.sharedDir) throw configuration('--shared-dir requires shared mode.', 'conflicting-flags');
  const ids = options.mode === 'cli-only' ? [] : agentIds(options.agents);
  const plan = basePlan('install', ctx);
  plan.mode = options.mode;
  if (!ids.length) return plan;
  let sharedPath;
  if (options.mode === 'shared') {
    sharedPath = assertSkillTarget(path.join(expandHome(options.sharedDir ?? ctx.sharedRoot, ctx.userHome), SKILL_NAME), ctx);
    addWrite(plan, sharedPath, skill.snapshot, ctx, { skill, shared: true, conflict: options.conflict });
    plan.warnings.push('Agents that natively scan the shared root may discover this skill even when not selected.');
  }
  for (const id of ids) {
    const privatePath = assertSkillTarget(path.join(ctx.roots[id], SKILL_NAME), ctx);
    let target;
    if (options.mode === 'copy') {
      target = privatePath;
      addWrite(plan, target, skill.snapshot, ctx, { skill, conflict: options.conflict });
    } else if (samePath(path.dirname(sharedPath), ctx.nativeShared[id]) || samePath(privatePath, sharedPath)) {
      target = sharedPath;
    } else {
      target = privatePath;
      if (inside(sharedPath, target) || inside(target, sharedPath)) throw configuration('Shared source and agent target overlap.', 'overlapping-targets');
      addWrite(plan, target, { kind: 'link', linkTarget: sharedPath }, ctx, { conflict: options.conflict });
    }
    const binding = { agentId: id, mode: options.mode, path: target, ...(sharedPath ? { sharedPath } : {}), reloadHint: AGENTS.find(a => a.id === id).reloadHint, loaded: 'not-verified' };
    plan.stateAfter.bindings[id] = binding;
    plan.bindings.push(binding);
  }
  // Two different agent roots may resolve to the same physical directory.
  for (const a of plan.operations) for (const b of plan.operations) {
    if (a !== b && !samePath(a.path, b.path) && (inside(resourceKey(a.path), resourceKey(b.path)) || inside(resourceKey(b.path), resourceKey(a.path)))) {
      throw configuration('Skill installation targets overlap.', 'overlapping-targets');
    }
  }
  if (options.mode === 'copy' && Object.values(plan.stateAfter.resources).some(record => record.shared)) {
    plan.warnings.push('Previous shared sources are retained. Native readers may still discover them; remove shared sources explicitly when no registrations need them.');
  }
  return plan;
}

export function buildSyncPlan(options, ctx = context(), skill = readSkill()) {
  const plan = basePlan('skills sync', ctx);
  const ids = options.agents ? agentIds(options.agents) : Object.keys(plan.stateBefore.bindings);
  for (const id of ids) {
    const binding = plan.stateBefore.bindings[id];
    if (!binding) throw configuration(`Agent is not registered: ${id}`, 'not-installed');
    for (const target of new Set([binding.sharedPath, binding.path].filter(Boolean))) {
      const record = plan.stateBefore.resources[resourceKey(target)];
      if (!record) throw configuration(`Managed resource is missing from manifest: ${target}`, 'bad-manifest');
      const desired = record.snapshot.kind === 'link' ? record.snapshot : skill.snapshot;
      addWrite(plan, target, desired, ctx, { ...(desired.kind === 'directory' ? { skill } : {}), shared: record.shared, conflict: options.conflict });
    }
    plan.bindings.push(binding);
  }
  return plan;
}

export function buildUninstallPlan(options, ctx = context()) {
  const plan = basePlan('skills uninstall', ctx);
  const ids = options.agents ? agentIds(options.agents) : Object.keys(plan.stateBefore.bindings);
  const candidatePaths = new Set();
  for (const id of ids) {
    const binding = plan.stateBefore.bindings[id];
    if (!binding) { plan.skipped.push({ agentId: id, reason: 'not-installed', harmless: true }); continue; }
    const record = plan.stateBefore.resources[resourceKey(binding.path)];
    if (record && !record.shared) candidatePaths.add(record.path);
    delete plan.stateAfter.bindings[id];
    plan.bindings.push(binding);
    if (binding.mode === 'shared') plan.warnings.push(`${id}: removing a registration does not prevent native discovery while the shared source exists.`);
  }
  if (options.removeShared) {
    for (const record of Object.values(plan.stateBefore.resources).filter(item => item.shared)) {
      const referenced = Object.values(plan.stateAfter.bindings).filter(binding => binding.sharedPath && samePath(binding.sharedPath, record.path));
      if (referenced.length) throw configuration(`Shared source is still registered by: ${referenced.map(b => b.agentId).join(', ')}`, 'shared-in-use');
      candidatePaths.add(record.path);
    }
  }
  for (const target of candidatePaths) {
    if (Object.values(plan.stateAfter.bindings).some(binding => samePath(binding.path, target) || (binding.sharedPath && samePath(binding.sharedPath, target)))) {
      plan.warnings.push(`Retained a skill resource still used by another registration: ${target}`);
      continue;
    }
    const key = resourceKey(target);
    const record = plan.stateBefore.resources[key];
    const present = snapshot(target);
    if (present.kind !== 'missing' && !equalSnapshot(present, record.snapshot)) {
      plan.skipped.push({ path: target, reason: 'user-modified', harmless: false });
      for (const binding of plan.bindings.filter(item => samePath(item.path, target))) plan.stateAfter.bindings[binding.agentId] = binding;
      continue;
    }
    plan.operations.push({ path: target, action: present.kind === 'missing' ? 'unchanged' : 'remove', before: present, desired: { kind: 'missing' }, kind: present.kind });
    delete plan.stateAfter.resources[key];
  }
  return plan;
}

export function publicPlan(plan) {
  const { stateBefore, stateAfter, ...visible } = plan;
  return visible;
}
