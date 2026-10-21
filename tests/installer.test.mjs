import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { context, exists, assertSkillTarget } from '../src/installer/paths.mjs';
import { snapshot, readSkill, equalSnapshot, materializeSkill } from '../src/installer/resources.mjs';
import { buildInstallPlan, buildSyncPlan, buildUninstallPlan } from '../src/installer/plan.mjs';
import { executePlan, recoverTransactions } from '../src/installer/transaction.mjs';
import { readState, withInstallLock, atomicJson } from '../src/installer/state.mjs';
import { detectAgents } from '../src/agents/index.mjs';
import { listSkills } from '../src/installer/health.mjs';

const IDS = 'codex,deepseek-harness,vscode-copilot,claude-code';

function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-setup-'));
  const userHome = path.join(root, '用户 skills with spaces');
  fs.mkdirSync(userHome);
  const source = path.join(root, 'resources');
  fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: weapp-automation\ndescription: fixture\n---\nweapp page\n');
  fs.writeFileSync(path.join(source, 'references', 'guide.md'), 'example');
  const ctx = context({ homeDir: userHome, env: { PATH: '', ...env } });
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('weapp-setup-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, source, skill: readSkill(source), ctx, target: path.join(ctx.sharedRoot, 'weapp-automation') };
}

test('shared plan is read-only and native agents share one source plus one Claude link', t => {
  const { skill, ctx, target } = fixture(t);
  const plan = buildInstallPlan({ mode: 'shared', agents: IDS }, ctx, skill);
  assert.equal(plan.operations.length, 2);
  assert.equal(plan.bindings.length, 4);
  assert.equal(plan.operations[1].kind, 'link');
  assert.equal(exists(target), false);
  assert.equal(exists(ctx.stateDir), false);
});

test('four-agent shared install and repeated install preserve files without duplicate backups', t => {
  const { skill, ctx, target } = fixture(t);
  executePlan(buildInstallPlan({ mode: 'shared', agents: IDS }, ctx, skill), ctx);
  assert.ok(equalSnapshot(snapshot(target), skill.snapshot));
  const claude = path.join(ctx.roots['claude-code'], 'weapp-automation');
  assert.ok(fs.lstatSync(claude).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(claude, 'references', 'guide.md'), 'utf8'), 'example');
  assert.equal(Object.keys(readState(ctx).bindings).length, 4);
  const second = buildInstallPlan({ mode: 'shared', agents: IDS }, ctx, skill);
  assert.ok(second.operations.every(op => op.action === 'unchanged'));
  assert.equal(executePlan(second, ctx).backups.length, 0);
  assert.equal(listSkills(ctx).healthy, true);
});

test('custom shared directory connects all four private roots through links', t => {
  const { skill, ctx, root } = fixture(t);
  const plan = buildInstallPlan({ mode: 'shared', agents: IDS, sharedDir: path.join(root, '共享 custom') }, ctx, skill);
  assert.equal(plan.operations.length, 5);
  executePlan(plan, ctx);
  for (const binding of Object.values(readState(ctx).bindings)) {
    assert.ok(fs.lstatSync(binding.path).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(binding.path, 'SKILL.md')));
  }
});

test('copy mode creates only documentation, preserves unrelated skills and supports independent removal', t => {
  const { skill, ctx } = fixture(t);
  const unrelated = path.join(ctx.roots.codex, 'unrelated');
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, 'SKILL.md'), 'keep');
  executePlan(buildInstallPlan({ mode: 'copy', agents: IDS }, ctx, skill), ctx);
  for (const binding of Object.values(readState(ctx).bindings)) {
    assert.equal(fs.lstatSync(binding.path).isSymbolicLink(), false);
    assert.equal(exists(path.join(binding.path, 'node_modules')), false);
  }
  executePlan(buildUninstallPlan({ agents: 'codex' }, ctx), ctx);
  assert.equal(exists(path.join(ctx.roots.codex, 'weapp-automation')), false);
  assert.equal(fs.readFileSync(path.join(unrelated, 'SKILL.md'), 'utf8'), 'keep');
  assert.equal(Object.keys(readState(ctx).bindings).length, 3);
});

test('unmanaged legacy skill requires explicit conflict policy and is fully backed up', t => {
  const { skill, ctx, target } = fixture(t);
  fs.mkdirSync(path.join(target, 'node_modules', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'legacy custom');
  fs.writeFileSync(path.join(target, 'node_modules', 'fixture', 'index.js'), 'legacy runtime');
  const before = snapshot(target);
  const blocked = buildInstallPlan({ mode: 'shared', agents: 'codex' }, ctx, skill);
  assert.equal(blocked.conflicts.length, 1);
  assert.throws(() => executePlan(blocked, ctx), error => error.code === 'skill-conflict');
  assert.equal(exists(ctx.stateDir), false);
  const result = executePlan(buildInstallPlan({ mode: 'shared', agents: 'codex', conflict: 'backup' }, ctx, skill), ctx);
  assert.equal(result.backups.length, 1);
  assert.ok(equalSnapshot(snapshot(path.join(result.backups[0].backup, 'weapp-automation')), before));
  assert.equal(exists(path.join(target, 'node_modules')), false);
});

test('sync refuses modified files unless full-backup replacement is selected', t => {
  const { skill, ctx, target, source } = fixture(t);
  executePlan(buildInstallPlan({ mode: 'shared', agents: 'codex' }, ctx, skill), ctx);
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'user edit');
  fs.writeFileSync(path.join(source, 'references', 'guide.md'), 'new release');
  const current = readSkill(source);
  const blocked = buildSyncPlan({}, ctx, current);
  assert.equal(blocked.conflicts[0].reason, 'user-modified');
  assert.throws(() => executePlan(blocked, ctx), error => error.code === 'skill-conflict');
  const result = executePlan(buildSyncPlan({ conflict: 'backup' }, ctx, current), ctx);
  assert.equal(fs.readFileSync(path.join(result.backups[0].backup, 'weapp-automation', 'SKILL.md'), 'utf8'), 'user edit');
  assert.equal(fs.readFileSync(path.join(target, 'references', 'guide.md'), 'utf8'), 'new release');
});

test('uninstall keeps user-added files and their registration', t => {
  const { skill, ctx } = fixture(t);
  executePlan(buildInstallPlan({ mode: 'copy', agents: 'codex' }, ctx, skill), ctx);
  const target = path.join(ctx.roots.codex, 'weapp-automation');
  fs.writeFileSync(path.join(target, 'my-notes.md'), 'keep');
  const plan = buildUninstallPlan({}, ctx);
  assert.equal(plan.skipped[0].reason, 'user-modified');
  executePlan(plan, ctx);
  assert.equal(fs.readFileSync(path.join(target, 'my-notes.md'), 'utf8'), 'keep');
  assert.ok(readState(ctx).bindings.codex);
});

test('removing Claude junction never follows it to shared files; shared source is explicit', t => {
  const { skill, ctx, target } = fixture(t);
  executePlan(buildInstallPlan({ mode: 'shared', agents: IDS }, ctx, skill), ctx);
  assert.throws(() => buildUninstallPlan({ agents: 'claude-code', removeShared: true }, ctx), error => error.code === 'shared-in-use');
  executePlan(buildUninstallPlan({ agents: 'claude-code' }, ctx), ctx);
  assert.equal(exists(path.join(ctx.roots['claude-code'], 'weapp-automation')), false);
  assert.equal(fs.readFileSync(path.join(target, 'references', 'guide.md'), 'utf8'), 'example');
  executePlan(buildUninstallPlan({ removeShared: true }, ctx), ctx);
  assert.equal(exists(target), false);
  assert.equal(Object.keys(readState(ctx).bindings).length, 0);
});

test('failure on a later target rolls back earlier changes and preserves complete backup', t => {
  const { skill, ctx, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'original');
  const plan = buildInstallPlan({ mode: 'shared', agents: 'claude-code', conflict: 'backup' }, ctx, skill);
  assert.throws(() => executePlan(plan, ctx, { beforeOperation(_operation, index) { if (index === 1) throw new Error('simulated disk failure'); } }), error => error.data.rollback.complete);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'original');
  assert.equal(exists(path.join(ctx.roots['claude-code'], 'weapp-automation')), false);
  assert.equal(exists(ctx.manifestFile), false);
});

test('changed target after planning is retained without overwriting it', t => {
  const { skill, ctx, target } = fixture(t);
  const plan = buildInstallPlan({ mode: 'shared', agents: 'codex' }, ctx, skill);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'concurrent edit');
  assert.throws(() => executePlan(plan, ctx), error => error.code === 'plan-changed');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'concurrent edit');
});

test('incomplete transaction is recovered from a persistent journal', t => {
  const { skill, ctx, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'original');
  const before = snapshot(target), id = crypto.randomUUID();
  const oldPath = path.join(path.dirname(target), `.weapp-automation-${id}-0.old`);
  const stagePath = path.join(path.dirname(target), `.weapp-automation-${id}-0.stage`);
  fs.renameSync(target, oldPath);
  materializeSkill(skill, target);
  const journalRoot = path.join(ctx.stateDir, 'transactions');
  fs.mkdirSync(journalRoot, { recursive: true });
  atomicJson(path.join(journalRoot, id + '.json'), { id, status: 'prepared', operations: [{ path: target, oldPath, stagePath, before, desired: skill.snapshot, started: true }] });
  assert.equal(recoverTransactions(ctx)[0].action, 'rollback');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'original');
  assert.equal(exists(oldPath), false);
});

test('a recovery target edited by the user is retained with actionable recovery information', t => {
  const { skill, ctx, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'original');
  const before = snapshot(target), id = crypto.randomUUID();
  const oldPath = path.join(path.dirname(target), `.weapp-automation-${id}-0.old`);
  const stagePath = path.join(path.dirname(target), `.weapp-automation-${id}-0.stage`);
  fs.renameSync(target, oldPath);
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'SKILL.md'), 'edited after crash');
  fs.mkdirSync(path.join(ctx.stateDir, 'transactions'), { recursive: true });
  atomicJson(path.join(ctx.stateDir, 'transactions', id + '.json'), { id, status: 'prepared', operations: [{ path: target, oldPath, stagePath, before, desired: skill.snapshot, started: true }] });
  assert.throws(() => recoverTransactions(ctx), error => error.code === 'recovery-required');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'edited after crash');
  assert.equal(fs.readFileSync(path.join(oldPath, 'SKILL.md'), 'utf8'), 'original');
});

test('active installation lock cannot be stolen', t => {
  const { ctx } = fixture(t);
  fs.mkdirSync(ctx.stateDir);
  fs.writeFileSync(path.join(ctx.stateDir, 'install.lock'), JSON.stringify({ pid: process.pid, token: 'other' }));
  assert.throws(() => withInstallLock(ctx, () => assert.fail('must not enter')), error => error.code === 'installer-busy');
});

test('invalid manifest does not get replaced by an empty state', t => {
  const { skill, ctx } = fixture(t);
  fs.mkdirSync(ctx.stateDir);
  fs.writeFileSync(ctx.manifestFile, '{ corrupt');
  assert.throws(() => buildInstallPlan({ mode: 'copy', agents: 'codex' }, ctx, skill), error => error.code === 'bad-manifest');
  assert.equal(fs.readFileSync(ctx.manifestFile, 'utf8'), '{ corrupt');
});

test('protected package and state roots cannot become installation targets, including junction parents', t => {
  const { ctx, root } = fixture(t);
  assert.throws(() => assertSkillTarget(ctx.userHome, ctx), error => error.code === 'unsafe-path');
  assert.throws(() => assertSkillTarget(path.join(ctx.stateDir, 'weapp-automation'), ctx), error => error.code === 'unsafe-path');
  const protectedRoot = path.join(root, 'protected');
  fs.mkdirSync(protectedRoot);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertSkillTarget(path.join(alias, 'weapp-automation'), { ...ctx, packageRoot: protectedRoot }), error => error.code === 'unsafe-path');
});

test('DSH and Claude custom configuration roots are honored', t => {
  const { root, ctx } = fixture(t);
  const custom = context({ homeDir: ctx.userHome, env: { PATH: '', DSH_HOME: path.join(root, 'dsh'), DSH_AGENTS_HOME: path.join(root, 'agents'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
  assert.equal(custom.roots['deepseek-harness'], path.join(root, 'dsh', 'skills'));
  assert.equal(custom.nativeShared['deepseek-harness'], path.join(root, 'agents', 'skills'));
  assert.equal(custom.roots['claude-code'], path.join(root, 'claude', 'skills'));
});

test('Copilot can be bundled in a versioned VS Code application; unrelated publishers do not count', t => {
  const { ctx, root } = fixture(t);
  const codeRoot = path.join(root, 'VS Code');
  const extension = path.join(codeRoot, 'commit-build', 'resources', 'app', 'extensions', 'copilot');
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ publisher: 'GitHub', name: 'copilot-chat', version: '0.70.0' }));
  const detected = detectAgents({ ...ctx, env: { PATH: '', WEAPP_VSCODE_ROOT: codeRoot } }).find(agent => agent.id === 'vscode-copilot');
  assert.equal(detected.installed, true);
  assert.equal(detected.detectedBy[0].type, 'bundled-extension');
  assert.equal(detected.loaded, 'not-verified');
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ publisher: 'unrelated', name: 'copilot-chat' }));
  assert.equal(detectAgents({ ...ctx, env: { PATH: '', WEAPP_VSCODE_ROOT: codeRoot } }).find(agent => agent.id === 'vscode-copilot').installed, false);
});

test('CLI-only and invalid combinations never write skills', t => {
  const { ctx, skill } = fixture(t);
  assert.equal(buildInstallPlan({ mode: 'cli-only' }, ctx, skill).operations.length, 0);
  for (const options of [{ mode: 'shared' }, { mode: 'copy', agents: 'unknown' }, { mode: 'copy', agents: 'codex', sharedDir: '/tmp/x' }, { mode: 'cli-only', agents: 'codex' }]) {
    assert.throws(() => buildInstallPlan(options, ctx, skill));
  }
  assert.equal(exists(ctx.stateDir), false);
});

test('one agent cannot uninstall another registration sharing the same physical copy', t => {
  const { ctx, skill } = fixture(t);
  ctx.roots['vscode-copilot'] = ctx.roots.codex;
  executePlan(buildInstallPlan({ mode: 'copy', agents: 'codex,vscode-copilot' }, ctx, skill), ctx);
  executePlan(buildUninstallPlan({ agents: 'codex' }, ctx), ctx);
  assert.ok(fs.existsSync(path.join(ctx.roots.codex, 'weapp-automation', 'SKILL.md')));
  assert.ok(readState(ctx).bindings['vscode-copilot']);
  assert.equal(readState(ctx).bindings.codex, undefined);
});

test('replaced managed junction is retained during uninstall', t => {
  const { ctx, skill, root } = fixture(t);
  executePlan(buildInstallPlan({ mode: 'shared', agents: 'claude-code' }, ctx, skill), ctx);
  const target = path.join(ctx.roots['claude-code'], 'weapp-automation');
  fs.unlinkSync(target);
  const userTarget = path.join(root, 'user-target'); fs.mkdirSync(userTarget);
  fs.writeFileSync(path.join(userTarget, 'keep.md'), 'keep');
  fs.symlinkSync(userTarget, target, process.platform === 'win32' ? 'junction' : 'dir');
  const plan = buildUninstallPlan({ agents: 'claude-code' }, ctx);
  assert.equal(plan.skipped[0].reason, 'user-modified');
  executePlan(plan, ctx);
  assert.equal(fs.readFileSync(path.join(userTarget, 'keep.md'), 'utf8'), 'keep');
  assert.ok(fs.lstatSync(target).isSymbolicLink());
});
