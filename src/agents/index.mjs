import fs from 'node:fs';
import path from 'node:path';
import { context, exists } from '../installer/paths.mjs';
import { configuration } from '../installer/errors.mjs';

export const AGENTS = Object.freeze([
  { id: 'codex', name: 'Codex', commands: ['codex'], reloadHint: 'Start a new Codex chat if the skill is not listed.' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', commands: ['dsh'], reloadHint: 'The filesystem provider watches skills; reopen the session if discovery is stale.' },
  { id: 'vscode-copilot', name: 'VS Code Copilot', commands: ['code', 'code-insiders'], reloadHint: 'Reload the VS Code window, then check agent skills in Copilot Chat.' },
  { id: 'claude-code', name: 'Claude Code', commands: ['claude'], reloadHint: 'Check /weapp-automation in Claude Code; restart the session if needed.' },
]);

export function agentIds(value) {
  if (typeof value !== 'string' || !value.trim()) throw configuration('--agents requires a comma-separated list.', 'missing-agents');
  const ids = [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  const unknown = ids.filter(id => !AGENTS.some(agent => agent.id === id));
  if (unknown.length) throw configuration(`Unknown agents: ${unknown.join(', ')}. Supported: ${AGENTS.map(a => a.id).join(', ')}`, 'unknown-agent');
  return ids;
}

export function commandPaths(name, ctx = context()) {
  const directories = (ctx.env.PATH ?? ctx.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extensions = ctx.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  const found = [];
  for (const directory of directories) for (const extension of extensions) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), name + extension);
    try { if (fs.statSync(candidate).isFile()) found.push(candidate); } catch { /* not on PATH */ }
  }
  return [...new Set(found)];
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function subdirectories(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(root, entry.name)); }
  catch { return []; }
}

export function copilotInstallations(ctx, commands = []) {
  const codeRoots = [];
  for (const command of commands) {
    // Standard Windows/macOS/Linux CLI shims live under the app's bin folder.
    const resolved = fs.realpathSync(command);
    const parent = path.dirname(resolved);
    codeRoots.push(path.dirname(parent));
  }
  if (ctx.env.WEAPP_VSCODE_ROOT) codeRoots.push(path.resolve(ctx.env.WEAPP_VSCODE_ROOT));
  if (ctx.platform === 'win32' && ctx.env.LOCALAPPDATA) codeRoots.push(path.join(ctx.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'));
  if (ctx.platform === 'darwin') codeRoots.push('/Applications/Visual Studio Code.app/Contents');
  const roots = [path.join(ctx.userHome, '.vscode', 'extensions'), path.join(ctx.userHome, '.vscode-insiders', 'extensions')];
  for (const codeRoot of new Set(codeRoots)) {
    const appRoots = [path.join(codeRoot, 'resources', 'app'), path.join(codeRoot, 'Resources', 'app')];
    // New VS Code installers keep resources inside a commit-specific folder.
    for (const build of subdirectories(codeRoot)) appRoots.push(path.join(build, 'resources', 'app'));
    for (const app of appRoots) roots.push(path.join(app, 'extensions'));
  }
  const results = [];
  for (const root of new Set(roots)) for (const extension of subdirectories(root)) {
    if (!/copilot/i.test(path.basename(extension))) continue;
    const manifest = readJson(path.join(extension, 'package.json'));
    if (!manifest) continue;
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    if (!['github.copilot', 'github.copilot-chat'].includes(id)) continue;
    results.push({ id, version: manifest.version, path: extension, bundled: !root.startsWith(path.join(ctx.userHome, '.vscode')) });
  }
  return results;
}

export function detectAgents(ctx = context()) {
  return AGENTS.map(agent => {
    const commands = agent.commands.flatMap(name => commandPaths(name, ctx));
    const configRoot = path.dirname(ctx.roots[agent.id]);
    const extensions = agent.id === 'vscode-copilot' ? copilotInstallations(ctx, commands) : [];
    const detectedBy = commands.map(file => ({ type: 'command', path: file }));
    if (agent.id === 'vscode-copilot') for (const extension of extensions) detectedBy.push({ type: extension.bundled ? 'bundled-extension' : 'user-extension', ...extension });
    if (exists(configRoot)) detectedBy.push({ type: 'directory-only', path: configRoot });
    const installed = agent.id === 'vscode-copilot' ? extensions.length > 0 : commands.length > 0;
    return {
      id: agent.id, name: agent.name,
      status: installed ? 'detected' : commands.length ? 'application-only' : detectedBy.length ? 'directory-only' : 'not-detected',
      installed, detectedBy,
      skillRoot: ctx.roots[agent.id], nativeSharedRoot: ctx.nativeShared[agent.id],
      supports: ['shared', 'copy'], reloadHint: agent.reloadHint,
      loaded: 'not-verified',
    };
  });
}
