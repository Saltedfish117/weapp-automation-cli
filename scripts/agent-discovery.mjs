import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { PACKAGE_ROOT, PACKAGE } from '../src/package.mjs';
import { runNpm, runNode, globalStatus } from '../src/lifecycle/npm.mjs';
import { commandPaths, detectAgents } from '../src/agents/index.mjs';
import { context } from '../src/installer/paths.mjs';

const report = { package: PACKAGE.name, version: PACKAGE.version, checkedAt: new Date().toISOString(), agents: [] };
const ctx = context();

async function codexCatalog(entry) {
  const child = spawn(process.execPath, [entry, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let sequence = 0, buffer = '';
  const timer = setTimeout(() => {
    for (const { reject } of pending.values()) reject(new Error('Codex app-server catalog timeout'));
    child.kill();
  }, 30_000);
  child.stderr.on('data', () => {}); // Do not expose unrelated client logs.
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('Codex app-server exited before responding')); });
  try {
    await call('initialize', { clientInfo: { name: 'weapp-automation-cli-acceptance', version: PACKAGE.version } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await call('skills/list', { cwds: [PACKAGE_ROOT], forceReload: true });
    const target = result.data.flatMap(row => row.skills).find(skill => skill.name === 'weapp-automation');
    const errors = result.data.flatMap(row => row.errors).filter(error => error.path.includes('weapp-automation'));
    return { id: 'codex', check: 'actual-app-server-catalog', discovered: Boolean(target), enabled: target?.enabled ?? false, path: target?.path ?? null, errors, chatInvocation: 'not-run' };
  } finally { clearTimeout(timer); child.stdin.end(); child.kill(); }
}

try {
  const root = await runNpm(['root', '--global']);
  if (root.code !== 0) throw new Error('Cannot find the global Codex package.');
  const entry = path.join(root.stdout.trim(), '@openai', 'codex', 'bin', 'codex.js');
  report.agents.push(await codexCatalog(entry));
} catch (error) { report.agents.push({ id: 'codex', check: 'actual-app-server-catalog', discovered: false, error: error.message }); }

try {
  const launcher = commandPaths('dsh', ctx).find(file => file.toLowerCase().endsWith('.cmd'));
  if (!launcher) throw new Error('DSH launcher not found.');
  const command = fs.readFileSync(launcher, 'utf8');
  const match = command.match(/"([^"\r\n]+[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)"/);
  if (!match) throw new Error('Cannot resolve the installed DSH package from its launcher.');
  const require = createRequire(pathToFileURL(match[1]));
  const providerEntry = require.resolve('@deepseek-ai/dsh-skill-filesystem');
  const { FileSystemSkillProvider } = await import(pathToFileURL(providerEntry).href);
  const controller = new AbortController();
  const provider = new FileSystemSkillProvider({ get() { return undefined; }, logger: { warn() {} } }, { signal: controller.signal, invalidate() {} }, { watch: false });
  try {
    const catalog = await provider.list({ cwd: PACKAGE_ROOT });
    const candidates = Array.isArray(catalog) ? catalog : catalog.candidates;
    const target = candidates.filter(candidate => candidate.name === 'weapp-automation').sort((a, b) => a.rank - b.rank)[0];
    const loaded = target ? await provider.get(target, { cwd: PACKAGE_ROOT }) : null;
    report.agents.push({ id: 'deepseek-harness', check: 'installed-filesystem-provider', discovered: Boolean(target), bodyLoaded: Boolean(loaded?.content), source: target?.source, path: loaded?.path, usesGlobalCommand: loaded?.content.includes('weapp --version') ?? false, activeChat: 'not-verified' });
  } finally { await provider.dispose(); }
} catch (error) { report.agents.push({ id: 'deepseek-harness', check: 'installed-filesystem-provider', discovered: false, error: error.message }); }

for (const id of ['vscode-copilot', 'claude-code']) {
  const detected = detectAgents(ctx).find(agent => agent.id === id);
  const skillFile = id === 'claude-code' ? path.join(ctx.roots[id], 'weapp-automation', 'SKILL.md') : path.join(ctx.sharedRoot, 'weapp-automation', 'SKILL.md');
  report.agents.push({ id, check: 'installation-and-readable-skill', installed: detected.installed, readable: fs.existsSync(skillFile), path: skillFile, actualClientLoading: 'pending-reload-and-client-confirmation' });
}
const global = await globalStatus(ctx);
const cli = await runNode(global.installed?.entry ?? path.join(PACKAGE_ROOT, 'bin', 'weapp.mjs'), ['--version']);
report.cli = { available: Boolean(global.installed && global.pathReady && !global.pathConflict && cli.code === 0), version: cli.stdout.trim(), scope: global.installed ? 'global' : 'source-only' };
const file = path.join(PACKAGE_ROOT, '.artifacts', 'agent-discovery.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (!report.cli.available || report.agents.some(agent => agent.error || agent.discovered === false || agent.readable === false || agent.usesGlobalCommand === false)) process.exitCode = 1;
