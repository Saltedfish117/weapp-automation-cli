import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './output.mjs';
import { PACKAGE_ROOT } from '../../package.mjs';

export function validateArtifactPath(requested, packageRoot = PACKAGE_ROOT, cwd = process.cwd()) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) throw new CliError('output path is required', {exitCode:EXIT.CONFIG,code:'bad-output-path'});
  const target=path.resolve(cwd,requested);
  // Resolve nearest existing ancestor, including junctions, before arming output.
  let parent=path.dirname(target), suffix=[];
  while(!fs.existsSync(parent)) { const next=path.dirname(parent); if(next===parent) break; suffix.unshift(path.basename(parent)); parent=next; }
  const physical=fs.existsSync(target) ? fs.realpathSync(target) : path.join(fs.realpathSync(parent),...suffix,path.basename(target));
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const root=fold(fs.realpathSync(packageRoot));
  const candidate=fold(physical);
  if(candidate===root || candidate.startsWith(root+path.sep)) throw new CliError('output cannot write inside the CLI package tree', {exitCode:EXIT.CONFIG,code:'bad-output-path'});
  return target;
}

export function validateResultPath(requested, packageRoot, cwd = process.cwd()) {
  if(typeof requested !== 'string' || path.extname(requested).toLowerCase()!=='.json') throw new CliError('--result-out must end with .json', {exitCode:EXIT.CONFIG,code:'bad-output-path'});
  return validateArtifactPath(requested, packageRoot, cwd);
}
