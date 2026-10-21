import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT, withTimeout, sanitize } from './output.mjs';
import { capturePngGuarded } from './shot.mjs';
import { validateArtifactPath } from './result-path.mjs';

const safeName = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'run';

/** Bounded, best-effort failure capture. No navigation, mocks, mutations or restart. */
export function createDiagnostics(session, { directory, command = 'run', enabled = true,
  operationTimeoutMs = 1000, screenshotTimeoutMs = 1500, evidence = null } = {}) {
  const createdAt = Date.now();
  const root = path.resolve(directory ?? path.join(process.cwd(), '.weapp-evidence'),
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName(command)}-${process.pid}`);
  const steps = [], active = [];
  let saved = null, failurePromise = null;
  const route = async () => {
    const p = await withTimeout(session.mp.currentPage(), operationTimeoutMs, 'diagnostic route');
    return p ? { path: p.path, query: p.query } : null;
  };
  async function capture(error) {
    if (!enabled) return { captured: false, disabled: true };
    if (failurePromise) return failurePromise;
    failurePromise = (async () => {
      const warnings = [], state = { capturedAt: new Date().toISOString(), command,
        durationMs: Date.now() - createdAt,
        error: { code: error?.code ?? 'error', message: error?.message ?? String(error) },
        activeStep: active.at(-1) ?? null, steps, route: null, data: null, evidence };
      try {
        validateArtifactPath(root);
        await fs.mkdir(root, { recursive: true });
        try { state.route = await route(); } catch (e) { warnings.push(`route: ${e.message}`); }
        try {
          const p = await withTimeout(session.mp.currentPage(), operationTimeoutMs, 'diagnostic current page');
          if (p) state.data = await withTimeout(p.data(), operationTimeoutMs, 'diagnostic page data');
        } catch (e) { warnings.push(`data: ${e.message}`); }
        const statePath = path.join(root, 'state.json');
        // No silent preview limits in the on-disk snapshot. Cycles/special values remain JSON-safe.
        await fs.writeFile(statePath, JSON.stringify(sanitize(state, { maxDepth: Infinity, maxArrayLength: Infinity }), null, 2), 'utf8');
        let screenshotPath = null;
        try {
          const image = await capturePngGuarded(session.mp, screenshotTimeoutMs);
          screenshotPath = path.join(root, 'failure.png');
          await fs.writeFile(screenshotPath, image);
        } catch (e) { warnings.push(`screenshot: ${e.message}`); }
        saved = { captured: true, directory: root, statePath, screenshotPath,
          activeStep: state.activeStep, route: state.route, durationMs: state.durationMs, warnings };
        await fs.writeFile(path.join(root, 'diagnostics.json'), JSON.stringify(saved, null, 2), 'utf8');
      } catch (e) {
        saved = { captured: false, directory: root, warnings: [...warnings, e.message],
          activeStep: state.activeStep, route: state.route, durationMs: state.durationMs };
      }
      return saved;
    })();
    return failurePromise;
  }
  async function step(name, fn, { timeoutMs = 10000 } = {}) {
    if (typeof name !== 'string' || !name.trim() || typeof fn !== 'function' ||
        !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) {
      throw new CliError('step(name, fn, {timeoutMs}) needs a name, function and finite positive deadline', { exitCode: EXIT.CONFIG, code: 'bad-step' });
    }
    const item = { name, startedAt: new Date().toISOString(), status: 'running', durationMs: null, route: null };
    const start = Date.now();
    steps.push(item); active.push(item);
    try {
      const value = await withTimeout(Promise.resolve().then(fn), timeoutMs, `step ${name}`);
      item.status = 'passed';
      return value;
    } catch (error) {
      item.status = 'failed';
      item.error = { code: error?.code ?? 'error', message: error?.message ?? String(error) };
      const err = error instanceof CliError ? error : new CliError(error?.message ?? String(error), { code: 'step-failed' });
      if (err.code === 'timeout') { err.code = 'step-timeout'; err.exitCode = EXIT.RUNTIME; }
      item.durationMs = Date.now() - start;
      const diagnostic = await capture(err);
      err.data = { ...(err.data && typeof err.data === 'object' ? err.data : {}), step: { name, durationMs: item.durationMs }, diagnostics: diagnostic };
      throw err;
    } finally {
      item.durationMs ??= Date.now() - start;
      try { item.route = await route(); } catch { /* failure capture reports capabilities */ }
      const index = active.indexOf(item); if (index >= 0) active.splice(index, 1);
    }
  }
  return { step, capture, steps, get activeStep() { return active.at(-1) ?? null; }, get saved() { return saved; } };
}
