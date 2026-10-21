/**
 * Resolution order (first hit wins):
 *   1. explicit CLI flags  --project / --cli / --port
 *   2. environment         WEAPP_PROJECT / WEAPP_CLI / WEAPP_PORT
 *   3. nearest .weapp.json walking up from cwd
 *   4. auto-detect: nearest project.config.json walking up from cwd,
 *      and the known WeChat DevTools cli.bat locations
 */

import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './output.mjs';

export const DEFAULT_PORT = 9420;

const CLI_CANDIDATES = [
  ...(process.platform === 'darwin' ? [
    '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    '/Applications/微信开发者工具.app/Contents/MacOS/cli',
  ] : []),
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files (x86)\\Tencent\\微信开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信开发者工具\\cli.bat',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', '微信web开发者工具', 'cli.bat')
    : null,
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', '微信开发者工具', 'cli.bat')
    : null,
].filter(Boolean);

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Walk up from startDir looking for a file name. */
export function findUp(startDir, fileName, maxDepth = 12) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, fileName);
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Read the nearest .weapp.json, tolerating malformed JSON but reporting it. */
export function loadConfigFile(cwd = process.cwd()) {
  const file = findUp(cwd, '.weapp.json');
  if (!file) return { file: null, config: {}, warning: null };
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const config = JSON.parse(text);
    return { file, config: config && typeof config === 'object' ? config : {}, warning: null };
  } catch (err) {
    return {
      file,
      config: {},
      warning: `ignoring malformed ${file}: ${err.message}`,
    };
  }
}

function detectCliPath() {
  for (const candidate of CLI_CANDIDATES) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Look for a directory containing project.config.json (the devtools project root). */
function detectProjectPath(cwd) {
  const hit = findUp(cwd, 'project.config.json');
  return hit ? path.dirname(hit) : null;
}

const UNIAPP_BUILD_CANDIDATES = [
  'unpackage/dist/dev/mp-weixin',
  'unpackage/dist/build/mp-weixin',
  'dist/dev/mp-weixin',
  'dist/build/mp-weixin',
];

/**
 * Resolve the directory that actually contains app.json.
 *
 * WeChat DevTools cannot open a uni-app source root directly: the source has
 * project.config.json but app.json lives in the compiled output. Accept three
 * shapes:
 *   1. projectPath itself is the miniprogram root (app.json here)
 *   2. project.config.json has miniprogramRoot pointing at it
 *   3. known uni-app build outputs under projectPath
 *
 * @returns {string|null}
 */
export function resolveMiniprogramRoot(projectPath) {
  if (!projectPath) return null;
  const dir = path.resolve(projectPath);
  if (isFile(path.join(dir, 'app.json'))) return dir;

  const configPath = path.join(dir, 'project.config.json');
  if (isFile(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof config.miniprogramRoot === 'string' && config.miniprogramRoot.trim()) {
        const root = path.resolve(dir, config.miniprogramRoot);
        if (isFile(path.join(root, 'app.json'))) return root;
      }
    } catch {
      /* malformed project.config.json is handled elsewhere */
    }
  }

  for (const relative of UNIAPP_BUILD_CANDIDATES) {
    const root = path.join(dir, ...relative.split('/'));
    if (isFile(path.join(root, 'app.json'))) return root;
  }
  return null;
}

/**
 * Read the appid from the compiled project first, then the source project.
 * @returns {{appid: string|null, file: string|null}}
 */
export function resolveProjectAppId(projectPath, miniprogramRoot = resolveMiniprogramRoot(projectPath)) {
  const candidates = [];
  if (miniprogramRoot) candidates.push(path.join(miniprogramRoot, 'project.config.json'));
  if (projectPath) candidates.push(path.join(path.resolve(projectPath), 'project.config.json'));
  for (const file of candidates) {
    if (!isFile(file)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof config.appid === 'string' && config.appid.trim()) {
        return { appid: config.appid.trim(), file };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { appid: null, file: null };
}

/**
 * Port values come from flags/env/config, all of which are strings (or true
 * when the user forgot the value). Never silently fall back to 9420: a typo
 * would otherwise attach to the wrong devtools instance.
 */
function parsePort(value, source) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new CliError(`invalid port (${source}): a numeric value is required`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-port',
    });
  }
  const text = String(value).trim();
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliError(`invalid port (${source}): "${value}" is not an integer in 1..65535`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-port',
    });
  }
  return n;
}

function stringFlag(value, name) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError(`--${name} needs a path/value`, {
      exitCode: EXIT.CONFIG,
      code: 'missing-flag-value',
    });
  }
  return value;
}

function configString(config, key, file, warnings) {
  const value = config[key];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    warnings.push(`ignoring ${key} in ${file}: expected a non-empty string`);
    return null;
  }
  return value;
}

/**
 * @param {Record<string, unknown>} flags parsed CLI flags
 * @returns {{projectPath: string|null, miniprogramRoot: string|null, appid: string|null, appidFile: string|null, cliPath: string|null, port: number, sources: Record<string,string>, configFile: string|null, warnings: string[]}}
 */
export function resolveConfig(flags = {}, cwd = process.cwd()) {
  const { file, config, warning } = loadConfigFile(cwd);
  const sources = {};
  const warnings = warning ? [warning] : [];

  let projectPath = null;
  const projectFlag = stringFlag(flags.project, 'project');
  if (projectFlag) {
    projectPath = path.resolve(projectFlag);
    sources.projectPath = 'flag';
  } else if (process.env.WEAPP_PROJECT) {
    projectPath = path.resolve(process.env.WEAPP_PROJECT);
    sources.projectPath = 'env';
  } else {
    const configured = configString(config, 'projectPath', file ?? '.weapp.json', warnings);
    if (configured) {
      projectPath = path.resolve(path.dirname(file ?? cwd), configured);
      sources.projectPath = '.weapp.json';
    } else {
      projectPath = detectProjectPath(cwd);
      sources.projectPath = projectPath ? 'auto-detect' : 'none';
    }
  }

  let cliPath = null;
  const cliFlag = stringFlag(flags.cli, 'cli');
  if (cliFlag) {
    cliPath = path.resolve(cliFlag);
    sources.cliPath = 'flag';
  } else if (process.env.WEAPP_CLI) {
    cliPath = path.resolve(process.env.WEAPP_CLI);
    sources.cliPath = 'env';
  } else {
    const configured = configString(config, 'cliPath', file ?? '.weapp.json', warnings);
    if (configured) {
      cliPath = path.resolve(path.dirname(file ?? cwd), configured);
      sources.cliPath = '.weapp.json';
    } else {
      cliPath = detectCliPath();
      sources.cliPath = cliPath ? 'auto-detect' : 'none';
    }
  }

  let port = DEFAULT_PORT;
  if (flags.port !== undefined) {
    port = parsePort(flags.port, '--port');
    if (port === null) {
      throw new CliError('invalid port (--port): a numeric value is required', {
        exitCode: EXIT.CONFIG,
        code: 'bad-port',
      });
    }
    sources.port = 'flag';
  } else if (process.env.WEAPP_PORT !== undefined && process.env.WEAPP_PORT !== '') {
    port = parsePort(process.env.WEAPP_PORT, 'WEAPP_PORT');
    if (port === null) {
      throw new CliError('invalid port (WEAPP_PORT): a numeric value is required', {
        exitCode: EXIT.CONFIG,
        code: 'bad-port',
      });
    }
    sources.port = 'env';
  } else if (config.port !== undefined) {
    port = parsePort(config.port, '.weapp.json');
    if (port === null) {
      throw new CliError('invalid port (.weapp.json): a numeric value is required', {
        exitCode: EXIT.CONFIG,
        code: 'bad-port',
      });
    }
    sources.port = '.weapp.json';
  } else {
    sources.port = 'default';
  }

  if (projectPath && !fs.existsSync(projectPath)) {
    warnings.push(`project path does not exist: ${projectPath}`);
  } else if (projectPath && !isFile(path.join(projectPath, 'project.config.json'))) {
    warnings.push(`no project.config.json in ${projectPath}`);
  }
  const miniprogramRoot = resolveMiniprogramRoot(projectPath);
  const appidInfo = resolveProjectAppId(projectPath, miniprogramRoot);
  if (projectPath && fs.existsSync(projectPath) && !miniprogramRoot) {
    warnings.push(
      `no app.json under ${projectPath}. DevTools needs the compiled miniprogram root ` +
        `(for uni-app: unpackage/dist/dev/mp-weixin), not the source root.`,
    );
  }
  if (cliPath && !isFile(cliPath)) {
    warnings.push(`devtools cli not found: ${cliPath}`);
  }

  return {
    projectPath,
    miniprogramRoot,
    appid: appidInfo.appid,
    appidFile: appidInfo.file,
    cliPath,
    port,
    sources,
    configFile: file,
    warnings,
  };
}
