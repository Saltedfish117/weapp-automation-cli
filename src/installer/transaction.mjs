import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PACKAGE } from '../package.mjs';
import { SetupError, configuration } from './errors.mjs';
import { exists, samePath, assertSkillTarget, assertRemoval, removeEntry } from './paths.mjs';
import { snapshot, equalSnapshot, materializeSkill, readSkill, copyEntry } from './resources.mjs';
import { withInstallLock, atomicJson, readState, pendingTransactions, resourceKey } from './state.mjs';
import { publicPlan } from './plan.mjs';

function validateJournal(journal, ctx) {
  if (!/^[0-9a-f-]{36}$/.test(journal?.id ?? '') || !Array.isArray(journal.operations)) throw configuration('Invalid recovery journal.', 'bad-journal');
  journal.operations.forEach((operation, index) => {
    assertSkillTarget(operation.path, ctx);
    const parent = path.dirname(operation.path);
    for (const [field, suffix] of [['oldPath', 'old'], ['stagePath', 'stage']]) {
      const expected = path.join(parent, `.weapp-automation-${journal.id}-${index}.${suffix}`);
      if (!samePath(expected, operation[field])) throw configuration('Unsafe recovery path.', 'bad-journal');
    }
  });
}

function rollback(journal, ctx) {
  validateJournal(journal, ctx);
  const failed = [];
  for (const operation of [...journal.operations].reverse()) {
    const parent = path.dirname(operation.path);
    try {
      if (!operation.started) { removeEntry(operation.stagePath, parent); continue; }
      if (exists(operation.oldPath)) {
        if (exists(operation.path)) {
          if (!equalSnapshot(snapshot(operation.path), operation.desired)) throw new Error('New target changed; preserved for manual recovery.');
          removeEntry(operation.path, parent);
        }
        fs.renameSync(operation.oldPath, operation.path);
      } else if (operation.before.kind === 'missing' && exists(operation.path)) {
        if (!equalSnapshot(snapshot(operation.path), operation.desired)) throw new Error('Created target changed; preserved for manual recovery.');
        removeEntry(operation.path, parent);
      } else if (operation.before.kind !== 'missing' && !equalSnapshot(snapshot(operation.path), operation.before)) {
        throw new Error('Original target is unavailable; preserved recovery journal.');
      }
      removeEntry(operation.stagePath, parent);
    } catch (error) { failed.push({ path: operation.path, error: error.message, oldPath: operation.oldPath }); }
  }
  return failed;
}

function cleanup(journal, ctx) {
  validateJournal(journal, ctx);
  for (const operation of journal.operations) {
    const parent = path.dirname(operation.path);
    removeEntry(operation.oldPath, parent);
    removeEntry(operation.stagePath, parent);
  }
}

export function recoverTransactions(ctx) {
  const recovered = [];
  for (const file of pendingTransactions(ctx)) {
    let journal;
    try { journal = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw configuration(`Cannot read recovery journal: ${file}`, 'bad-journal'); }
    validateJournal(journal, ctx);
    const committed = readState(ctx).lastTransactionId === journal.id || journal.status === 'committed';
    if (committed) cleanup(journal, ctx);
    else {
      const failed = rollback(journal, ctx);
      if (failed.length) throw new SetupError('Previous installation needs manual recovery.', { code: 'recovery-required', data: { journal: file, failed } });
    }
    fs.unlinkSync(file);
    recovered.push({ id: journal.id, action: committed ? 'cleanup' : 'rollback' });
  }
  return recovered;
}

function backup(operation, backupRoot, index) {
  if (operation.before.kind === 'missing') return null;
  const root = path.join(backupRoot, String(index));
  fs.mkdirSync(root, { recursive: true });
  atomicJson(path.join(root, 'entry.json'), { originalPath: operation.path, snapshot: operation.before });
  if (operation.before.kind === 'directory') {
    copyEntry(operation.path, path.join(root, 'weapp-automation'));
  } else if (operation.before.kind === 'file') fs.copyFileSync(operation.path, path.join(root, 'original-file'));
  return root;
}

export function executePlan(plan, ctx, { beforeOperation } = {}) {
  if (plan.conflicts.length) throw configuration('Resolve skill conflicts before installing. Use --conflict backup to keep a full backup and replace.', 'skill-conflict', { plan: publicPlan(plan) });
  return withInstallLock(ctx, () => {
    const recovered = recoverTransactions(ctx);
    if (JSON.stringify(readState(ctx)) !== JSON.stringify(plan.stateBefore)) throw new SetupError('Installation state changed; run the command again.', { code: 'plan-changed' });
    const id = crypto.randomUUID();
    const operations = plan.operations.filter(op => !['unchanged', 'conflict'].includes(op.action)).map((operation, index) => ({
      ...operation,
      oldPath: path.join(path.dirname(operation.path), `.weapp-automation-${id}-${index}.old`),
      stagePath: path.join(path.dirname(operation.path), `.weapp-automation-${id}-${index}.stage`),
    }));
    const journal = { schemaVersion: 1, id, status: 'prepared', operations, createdAt: new Date().toISOString() };
    const journalRoot = path.join(ctx.stateDir, 'transactions');
    fs.mkdirSync(journalRoot, { recursive: true });
    const journalFile = path.join(journalRoot, id + '.json');
    const backupRoot = path.join(ctx.stateDir, 'backups', id);
    const backups = [];
    atomicJson(journalFile, journal);
    let committed = false;
    try {
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        assertSkillTarget(operation.path, ctx);
        if (!equalSnapshot(snapshot(operation.path), operation.before)) throw new SetupError(`Target changed after planning: ${operation.path}`, { code: 'plan-changed' });
        operation.started = true;
        atomicJson(journalFile, journal);
        fs.mkdirSync(path.dirname(operation.path), { recursive: true });
        const saved = backup(operation, backupRoot, index);
        if (!equalSnapshot(snapshot(operation.path), operation.before)) throw new SetupError(`Target changed during backup: ${operation.path}`, { code: 'plan-changed' });
        if (saved) {
          backups.push({ path: operation.path, backup: saved });
          const resource = plan.stateAfter.resources[resourceKey(operation.path)];
          if (resource) resource.backupPath = saved;
        }
        beforeOperation?.(operation, index);
        if (operation.desired.kind === 'directory') {
          const skill = readSkill(operation.source);
          if (!equalSnapshot(skill.snapshot, operation.desired)) throw new SetupError('Package skill changed after planning.', { code: 'plan-changed' });
          materializeSkill(skill, operation.stagePath);
        } else if (operation.desired.kind === 'link') {
          if (!fs.statSync(operation.desired.linkTarget).isDirectory()) throw new SetupError('Shared skill source is not readable.', { code: 'bad-shared-source' });
          fs.symlinkSync(operation.desired.linkTarget, operation.stagePath, ctx.platform === 'win32' ? 'junction' : 'dir');
        }
        if (operation.before.kind !== 'missing') fs.renameSync(operation.path, operation.oldPath);
        if (operation.desired.kind !== 'missing') fs.renameSync(operation.stagePath, operation.path);
        if (!equalSnapshot(snapshot(operation.path), operation.desired)) throw new SetupError(`Verification failed: ${operation.path}`, { code: 'verification-failed' });
      }
      // Re-check unchanged targets too; a successful transaction must not bless
      // a concurrent user edit as managed content.
      for (const operation of plan.operations.filter(op => op.action === 'unchanged')) {
        if (!equalSnapshot(snapshot(operation.path), operation.before)) throw new SetupError(`Target changed: ${operation.path}`, { code: 'plan-changed' });
      }
      plan.stateAfter.package = { name: PACKAGE.name, version: PACKAGE.version };
      plan.stateAfter.lastTransactionId = id;
      atomicJson(ctx.manifestFile, plan.stateAfter);
      committed = true;
      journal.status = 'committed';
      atomicJson(journalFile, journal);
      const warnings = [...plan.warnings];
      try { cleanup(journal, ctx); fs.unlinkSync(journalFile); }
      catch (error) { warnings.push(`Installation committed; cleanup will be retried on the next write: ${error.message}`); }
      return { ...publicPlan(plan), transactionId: id, recovered, backups, warnings, applied: true, loaded: 'not-verified' };
    } catch (cause) {
      if (committed) throw new SetupError('Files and manifest were committed, but final cleanup needs recovery.', { code: 'cleanup-required', cause, data: { journal: journalFile, backups } });
      const failed = rollback(journal, ctx);
      if (!failed.length) fs.unlinkSync(journalFile);
      throw new SetupError(failed.length ? 'Installation failed and rollback needs attention.' : `Installation failed; previous targets restored: ${cause.message}`, {
        code: failed.length ? 'rollback-failed' : cause.code ?? 'installation-failed',
        data: { reason: cause.message, rollback: { complete: !failed.length, failed }, journal: failed.length ? journalFile : null, backups }, cause,
      });
    }
  });
}
