import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const offenders = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(name)) continue;
    const text = readFileSync(path, 'utf-8');
    if (/^\s*PLACEHOLDER(?:_WILL_FAIL)?\s*$/.test(text)) offenders.push(path);
  }
}
walk('src');
if (offenders.length) {
  console.error('Core source file(s) replaced by placeholder:', offenders.join(', '));
  process.exit(1);
}
