import { parseArgs } from 'node:util';
import { PACKAGE } from './package.mjs';
import { context, expandHome } from './installer/paths.mjs';
import { SetupError, configuration } from './installer/errors.mjs';
import { AGENTS, detectAgents, agentIds } from './agents/index.mjs';
import { buildInstallPlan, buildSyncPlan, buildUninstallPlan, publicPlan } from './installer/plan.mjs';
import { executePlan } from './installer/transaction.mjs';
import { listSkills } from './installer/health.mjs';
import { globalStatus, ensureGlobal, handoff, runNpm, validateVersion } from './lifecycle/npm.mjs';

const DEFINITIONS = {
  mode: { type: 'string' }, agents: { type: 'string' },
  'shared-dir': { type: 'string' }, 'agent-dir': { type: 'string', multiple: true },
  yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
  help: { type: 'boolean' }, conflict: { type: 'string' },
  'remove-shared': { type: 'boolean' }, version: { type: 'string' },
  'allow-downgrade': { type: 'boolean' },
};
const ALLOWED = {
  install: ['mode', 'agents', 'shared-dir', 'agent-dir', 'yes', 'dry-run', 'json', 'help', 'conflict', 'allow-downgrade'],
  'skills list': ['json', 'help'],
  'skills sync': ['agents', 'yes', 'dry-run', 'json', 'help', 'conflict'],
  'skills uninstall': ['agents', 'yes', 'dry-run', 'json', 'help', 'remove-shared'],
  update: ['version', 'yes', 'dry-run', 'json', 'help', 'conflict', 'allow-downgrade'],
};

const HELP = `weapp ${PACKAGE.version} — WeChat DevTools automation and managed Agent Skills

Install:
  npx weapp-automation-cli@latest install
  npm i -g weapp-automation-cli
  weapp install

Lifecycle:
  weapp install [--mode shared|copy|cli-only] [--agents id,id] [--yes]
  weapp skills list [--json]
  weapp skills sync [--agents id,id] [--conflict backup] [--yes]
  weapp skills uninstall [--agents id,id] [--remove-shared] [--yes]
  weapp update [--version x.y.z] [--yes]
  weapp doctor [--project path]

Agents: codex, deepseek-harness, vscode-copilot, claude-code
Options: --shared-dir path, --agent-dir id=path (repeatable), --dry-run,
         --json, --conflict error|backup, --allow-downgrade

Shared skills are visible to every agent that natively reads the shared root.
No-TTY writes require --yes and explicit installation targets.
Use "weapp help" for the existing automation commands (JSON).
Windows is the v0.1 acceptance platform. macOS is not verified.
`;

function parsed(argv, cmd) {
  let values;
  try { values = parseArgs({ args: argv, options: DEFINITIONS, strict: true, allowPositionals: false }).values; }
  catch (cause) { throw configuration(cause.message, 'bad-arguments'); }
  for (const key of Object.keys(values)) if (!ALLOWED[cmd]?.includes(key)) throw configuration(`--${key} is not valid for ${cmd}.`, 'unknown-flag');
  if (values.conflict && !['error', 'backup'].includes(values.conflict)) throw configuration('--conflict must be error or backup.', 'bad-conflict-policy');
  return {
    mode: values.mode, agents: values.agents, sharedDir: values['shared-dir'], agentDirs: values['agent-dir'] ?? [],
    yes: values.yes ?? false, dryRun: values['dry-run'] ?? false, json: values.json ?? false,
    help: values.help ?? false, conflict: values.conflict ?? 'error', removeShared: values['remove-shared'] ?? false,
    version: values.version, allowDowngrade: values['allow-downgrade'] ?? false,
  };
}

function applyRoots(options, ctx) {
  for (const item of options.agentDirs) {
    const split = item.indexOf('=');
    if (split < 1 || split === item.length - 1) throw configuration('--agent-dir expects agent-id=skills-directory.', 'bad-agent-dir');
    const id = item.slice(0, split);
    agentIds(id);
    ctx.roots[id] = expandHome(item.slice(split + 1), ctx.userHome);
  }
}

function interactive(options, ctx) {
  return !options.json && !ctx.env.CI && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function checked(prompt) {
  const prompts = await import('@clack/prompts');
  const result = await prompt;
  if (prompts.isCancel(result)) throw new SetupError('Cancelled before installation changes.', { code: 'cancelled', exitCode: 130, data: { applied: false } });
  return result;
}

async function selections(options, ctx) {
  if (!interactive(options, ctx)) return options;
  const ui = await import('@clack/prompts');
  ui.intro(`weapp ${PACKAGE.version} — Agent Skill setup`);
  if (!options.mode) options.mode = await checked(ui.select({ message: '安装方式', options: [
    { value: 'shared', label: '共享 Skills 目录（推荐）', hint: '一份 Skill；原生发现或逐技能链接' },
    { value: 'copy', label: '分别安装到所选 Agent', hint: '只复制轻量 Skill，CLI 共用' },
    { value: 'cli-only', label: '仅安装 CLI' },
  ] }));
  if (options.mode !== 'cli-only' && !options.agents) {
    const detected = detectAgents(ctx);
    const ids = await checked(ui.multiselect({ message: '选择 Agent（空格多选）', required: true, options: detected.map(agent => ({
      value: agent.id, label: agent.name,
      hint: `${agent.status}; ${agent.skillRoot}`,
    })) }));
    options.agents = ids.join(',');
  }
  if (options.mode === 'shared' && !options.sharedDir) options.sharedDir = await checked(ui.text({
    message: '共享 Skills 根目录', initialValue: ctx.sharedRoot,
    validate: value => !value?.trim() ? '请输入目录路径。' : undefined,
  }));
  return options;
}

async function approve(plan, options, ctx) {
  if (options.dryRun || options.yes) return true;
  if (!interactive(options, ctx)) throw configuration('Non-interactive writes require --yes. Run --dry-run --json to review first.', 'confirmation-required');
  const ui = await import('@clack/prompts');
  const lines = plan.operations.map(operation => `${operation.action}: ${operation.path}`);
  if (plan.global) lines.unshift(`CLI: ${plan.global.installed?.version ?? 'not installed'} → ${plan.package.version}; npm prefix: ${plan.global.prefix}`);
  if (!lines.length) lines.push('No skill files need to change.');
  ui.note([...lines, ...plan.warnings].join('\n'), '安装计划');
  const confirmed = await checked(ui.confirm({ message: '按上面的计划执行？', initialValue: false }));
  if (!confirmed) throw new SetupError('Cancelled before installation changes.', { code: 'cancelled', exitCode: 130, data: { applied: false } });
  return true;
}

async function conflicts(plan, options, ctx, rebuild) {
  if (!plan.conflicts.length || options.dryRun) return plan;
  if (!interactive(options, ctx) || options.yes) throw configuration('Existing or modified skills conflict with this installation. Review --dry-run, then use --conflict backup to replace with a full backup.', 'skill-conflict', { plan: publicPlan(plan) });
  const ui = await import('@clack/prompts');
  ui.note(plan.conflicts.map(item => `${item.reason}: ${item.path}`).join('\n'), '发现同名技能或用户修改');
  const choice = await checked(ui.select({ message: '处理方式', options: [
    { value: 'backup', label: '完整备份后替换' },
    { value: 'skip', label: '保留现有内容，跳过本次接入' },
    { value: 'cancel', label: '取消' },
  ] }));
  if (choice === 'cancel') throw new SetupError('Cancelled before installation changes.', { code: 'cancelled', exitCode: 130, data: { applied: false } });
  if (choice === 'skip') return { ...plan, skipRequested: true };
  options.conflict = 'backup';
  return rebuild();
}

function forwardedInstall(options) {
  const args = ['install', '--mode', options.mode, '--yes'];
  if (options.agents) args.push('--agents', options.agents);
  if (options.sharedDir) args.push('--shared-dir', options.sharedDir);
  for (const item of options.agentDirs) args.push('--agent-dir', item);
  if (options.conflict === 'backup') args.push('--conflict', 'backup');
  if (options.allowDowngrade) args.push('--allow-downgrade');
  return args;
}

function versionCompare(a, b) {
  const left = a.split(/[.-]/).slice(0, 3).map(Number), right = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  if (a === b) return 0;
  return a.includes('-') ? -1 : 1;
}

async function install(options, ctx) {
  await selections(options, ctx);
  applyRoots(options, ctx);
  const global = await globalStatus(ctx);
  const build = () => ({ ...buildInstallPlan(options, ctx), global, agentsDetected: detectAgents(ctx) });
  let plan = await conflicts(build(), options, ctx, build);
  if (options.dryRun) return { ...publicPlan(plan), applied: false, dryRun: true };
  if (plan.skipRequested) return { ...publicPlan(plan), applied: false, status: 'skipped' };
  if (global.installed && versionCompare(global.installed.version, PACKAGE.version) > 0 && !options.allowDowngrade) throw configuration('A newer global CLI is installed. Use it, or explicitly pass --allow-downgrade.', 'downgrade-refused');
  await approve(plan, options, ctx);
  const ready = await ensureGlobal(ctx, global, { log: chunk => process.stderr.write(chunk) });
  if (!ready.pathReady) throw configuration('CLI is installed, but the npm global bin directory is not on PATH. Add that directory or reopen your terminal, then run weapp install.', 'path-not-ready', { cliInstalled: true, prefix: ready.prefix });
  if (!ready.currentIsGlobal) {
    const data = await handoff(ready.installed.entry, forwardedInstall(options), ctx);
    return { ...data, bootstrap: { installedVersion: ready.installed.version, prefix: ready.prefix } };
  }
  if (options.mode === 'cli-only') return { ...publicPlan(plan), applied: false, cliInstalled: true, global: ready };
  return { ...executePlan(plan, ctx), global: ready };
}

async function skillMutation(cmd, options, ctx) {
  const build = () => cmd === 'skills sync' ? buildSyncPlan(options, ctx) : buildUninstallPlan(options, ctx);
  const plan = await conflicts(build(), options, ctx, build);
  if (options.dryRun) return { ...publicPlan(plan), applied: false, dryRun: true };
  if (plan.skipRequested) return { ...publicPlan(plan), applied: false, status: 'skipped' };
  await approve(plan, options, ctx);
  if (!plan.operations.length && !plan.bindings.length) return { ...publicPlan(plan), applied: false, status: 'nothing-registered' };
  const result = executePlan(plan, ctx);
  if (result.skipped.some(item => !item.harmless)) throw new SetupError('Modified skill content was preserved; some targets were not removed.', { code: 'user-modified', data: result });
  return result;
}

async function update(options, ctx) {
  const before = await globalStatus(ctx);
  if (!before.installed) throw configuration('Install the global CLI before running update.', 'not-installed');
  let target = options.version;
  if (!target) {
    const lookup = await runNpm(['view', `${PACKAGE.name}@latest`, 'version', '--json'], { env: ctx.env });
    if (lookup.code !== 0) throw new SetupError(`Cannot resolve latest version: ${lookup.stderr}`, { code: 'version-lookup-failed' });
    try { target = JSON.parse(lookup.stdout); } catch { throw new SetupError('npm returned an invalid version.', { code: 'version-lookup-failed' }); }
  }
  validateVersion(target);
  if (versionCompare(before.installed.version, target) > 0 && !options.allowDowngrade) throw configuration('Target is older than the installed CLI. Pass --allow-downgrade for an intentional downgrade.', 'downgrade-refused');
  const plan = { action: 'update', package: { name: PACKAGE.name, version: target }, global: before, operations: [], warnings: ['CLI is updated first; registered Skill resources are then synchronized by the new version.'] };
  if (options.dryRun) return { ...plan, applied: false, dryRun: true, skills: listSkills(ctx) };
  await approve(plan, options, ctx);
  const ready = await ensureGlobal(ctx, before, { version: target, log: chunk => process.stderr.write(chunk) });
  try {
    const args = ['skills', 'sync', '--yes'];
    if (options.conflict === 'backup') args.push('--conflict', 'backup');
    const skills = await handoff(ready.installed.entry, args, ctx);
    return { ...plan, applied: true, global: ready, skills };
  } catch (cause) {
    throw new SetupError('CLI was updated, but Skill synchronization failed. Run weapp skills sync after resolving the reported conflict.', { code: 'skill-sync-failed', data: { cliUpdated: true, version: target, cause: { code: cause.code, message: cause.message, data: cause.data } } });
  }
}

function envelope(cmd, data, error = null, exitCode = 0) {
  return { ok: exitCode === 0, cmd, data, ...(error ? { error } : {}), meta: { package: PACKAGE.name, version: PACKAGE.version } };
}

export async function runCli(argv, { ctx } = {}) {
  const started = Date.now();
  let cmd = argv[0] ?? 'help';
  const json = argv.includes('--json') || !process.stdout.isTTY;
  try {
    ctx ??= context();
    if (argv[0] === '--version' || argv[0] === '-v') {
      if (argv.some((value, index) => index > 0 && value !== '--json')) throw configuration('Unexpected version argument.');
      if (argv.includes('--json')) process.stdout.write(JSON.stringify(envelope('version', { version: PACKAGE.version })) + '\n');
      else process.stdout.write(PACKAGE.version + '\n');
      return;
    }
    if ((argv[0] === '--help' || argv[0] === '-h') && argv.length === 1) { process.stdout.write(HELP); return; }
    const skillsHasAction = cmd === 'skills' && argv[1] && !argv[1].startsWith('-');
    if (cmd === 'skills') cmd += ' ' + (skillsHasAction ? argv[1] : 'list');
    if (!Object.hasOwn(ALLOWED, cmd)) {
      if (argv[0] === 'skills') throw configuration('skills expects list, sync or uninstall.', 'unknown-command');
      const { main } = await import('./runtime/weapp.mjs');
      return await main(argv);
    }
    const options = parsed(argv.slice(cmd.startsWith('skills ') && skillsHasAction ? 2 : 1), cmd);
    if (options.help) {
      if (options.json) process.stdout.write(JSON.stringify(envelope(cmd, { help: HELP })) + '\n');
      else process.stdout.write(HELP);
      return;
    }
    let data;
    if (cmd === 'install') data = await install(options, ctx);
    else if (cmd === 'skills list') data = listSkills(ctx);
    else if (cmd === 'update') data = await update(options, ctx);
    else data = await skillMutation(cmd, options, ctx);
    const result = envelope(cmd, data);
    result.meta.durationMs = Date.now() - started;
    if (json) process.stdout.write(JSON.stringify(result) + '\n');
    else {
      const ui = await import('@clack/prompts');
      if (options.dryRun || cmd === 'skills list') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      else ui.outro(data.status === 'skipped' ? 'Skipped; existing skills retained.' : `Completed. Skill loading in the Agent remains a separate verification step.\nState: ${ctx.stateDir}`);
    }
  } catch (cause) {
    const error = cause instanceof SetupError ? cause : new SetupError(cause.message ?? String(cause), { code: 'setup-failed', cause });
    const result = envelope(cmd, error.data ?? null, { code: error.code, message: error.message }, error.exitCode);
    result.meta.durationMs = Date.now() - started;
    if (json) process.stdout.write(JSON.stringify(result) + '\n');
    else process.stderr.write(`${error.code}: ${error.message}\n${error.data ? JSON.stringify(error.data, null, 2) + '\n' : ''}`);
    process.exitCode = error.exitCode;
  }
}
