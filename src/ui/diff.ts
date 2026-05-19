import { createPatch } from 'diff';
import chalk from 'chalk';

export function createDiffView(oldContent: string, newContent: string, filename = ''): string {
  const patch = createPatch(filename, oldContent, newContent, '', '');
  const lines = patch.split('\n');
  const output: string[] = [];

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('===')) {
      continue;
    } else if (line.startsWith('+')) {
      output.push(chalk.green(line));
    } else if (line.startsWith('-')) {
      output.push(chalk.red(line));
    } else if (line.startsWith('@@')) {
      output.push(chalk.cyan(line));
    } else {
      output.push(chalk.dim(line));
    }
  }

  return output.join('\n');
}
