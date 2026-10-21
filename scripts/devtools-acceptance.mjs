import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PACKAGE_ROOT, PACKAGE } from '../src/package.mjs';
import { runNode } from '../src/lifecycle/npm.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-devtools-acceptance-'));
const suppliedProject = process.env.WEAPP_ACCEPTANCE_PROJECT;
const project = suppliedProject ? path.resolve(suppliedProject) : path.join(root, 'miniprogram');
const pageDir = path.join(project, 'pages', 'index');
const json = (relative, value) => fs.writeFileSync(path.join(project, relative), JSON.stringify(value, null, 2));
if (!suppliedProject) {
fs.mkdirSync(pageDir, { recursive: true });
json('project.config.json', { appid: 'touristappid', projectname: 'weapp-automation-cli-acceptance', compileType: 'miniprogram', miniprogramRoot: './', setting: { es6: true, minified: false } });
json('app.json', { pages: ['pages/index/index'], window: { navigationBarTitleText: 'weapp CLI acceptance', navigationBarBackgroundColor: '#ffffff', navigationBarTextStyle: 'black' } });
fs.writeFileSync(path.join(project, 'app.js'), 'App({});\n');
json('pages/index/index.json', {});
fs.writeFileSync(path.join(pageDir, 'index.js'), 'Page({data:{acceptanceReady:true}});\n');
fs.writeFileSync(path.join(pageDir, 'index.wxml'), '<view class="root"><view id="smoke-card"><text>weapp automation</text><text class="detail">deterministic simulator fixture</text></view></view>\n');
fs.writeFileSync(path.join(pageDir, 'index.wxss'), '.root{padding:24px;}#smoke-card{width:240px;height:120px;background:#e8f2ff;border-radius:12px;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#132d4f;font-size:18px;}.detail{font-size:12px;margin-top:10px;}\n');
}
const ready = path.join(root, 'ready.json');
fs.writeFileSync(ready, JSON.stringify({ conditions: [{ type: 'route', equals: 'pages/index/index' }, { type: 'data', keyPath: 'acceptanceReady', equals: true }, { type: 'selector', selector: '#smoke-card', minCount: 1 }], timeoutMs: 8000, intervalMs: 100, stableSamples: 3, stableWindowMs: 300 }));
const entry = process.env.WEAPP_ACCEPTANCE_ENTRY ?? path.join(PACKAGE_ROOT, 'bin', 'weapp.mjs');
const port = String(process.env.WEAPP_ACCEPTANCE_PORT ?? (suppliedProject ? 9420 : 19420));
const selector = process.env.WEAPP_ELEMENT_SELECTOR ?? (suppliedProject ? '.navbar-center' : '#smoke-card');
const report = { package: PACKAGE.name, version: PACKAGE.version, project, port, source: suppliedProject ? 'user-specified project, read-only acceptance' : 'temporary simulator fixture', deviceAcceptance: false, businessAssertions: false, checks: [] };

async function command(args, options = {}) {
  const result = await runNode(entry, [...args, '--project', project, '--port', port], { timeoutMs: 45_000, ...options });
  let value; try { value = JSON.parse(result.stdout); } catch { throw new Error(`${args[0]} did not return JSON: ${result.stderr}`); }
  fs.writeFileSync(path.join(root, `${report.checks.length}-${args[0]}.json`), JSON.stringify(value, null, 2));
  if (result.code !== 0) throw new Error(`${args[0]} failed: ${JSON.stringify(value.error)}; ${result.stderr}`);
  report.checks.push({ command: args[0], passed: true, evidence: value.meta?.evidence ?? null });
  process.stdout.write(JSON.stringify({ command: args[0], passed: true }) + '\n');
  return value.data;
}

try {
  report.connection = await command(suppliedProject ? ['up', '--attach-only'] : ['up', '--launch-timeout', '20000', '--timeout', '30000']);
  if (!suppliedProject) {
  await command(['open', '/pages/index/index', '--attach-only']);
  await command(['ready', '--spec', '@' + ready, '--attach-only']);
  }
  const current = await command(['page', '--attach-only']);
  if (!suppliedProject) assert.equal(current.path, 'pages/index/index');
  report.page = current;
  const card = await command(['find', selector, '--assert', '--index', '0', '--attach-only']);
  assert.ok(card.element.size.width > 0 && card.element.size.height > 0);
  if (!suppliedProject) assert.ok(Math.abs(card.element.size.width - 240) <= 0.5 && Math.abs(card.element.size.height - 120) <= 0.5);
  report.card = card;
  report.screenshot = await command(['shot', '--out', path.join(root, 'screen.png'), '--attach-only']);
  const baseline = path.join(root, 'element-baseline.png');
  await command(['shot', '--selector', selector, '--index', '0', '--out', path.join(root, 'element-first.png'), '--baseline', baseline, '--update-baseline', '--attach-only']);
  report.element = await command(['shot', '--selector', selector, '--index', '0', '--out', path.join(root, 'element-second.png'), '--baseline', baseline, '--attach-only']);
  assert.equal(report.element.baseline.passed, true);
  assert.equal(report.element.baseline.sizeMismatch, false);
  assert.ok(report.element.viewport && report.element.cropped.viewport);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
const file = path.join(PACKAGE_ROOT, '.artifacts', 'devtools-acceptance.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ report: file, evidence: root, ok: report.ok }) + '\n');
