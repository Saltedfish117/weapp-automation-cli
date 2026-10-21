import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE = Object.freeze(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')));
export const SKILL_NAME = 'weapp-automation';
export const SKILL_SOURCE = path.join(PACKAGE_ROOT, 'skills', SKILL_NAME);
