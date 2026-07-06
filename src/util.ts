export function formatEnvAssignment(key: string, value: string): string {
  if (process.platform === 'win32') {
    return `$env:${key}="${value}"`;
  }
  return `export ${key}=${value}`;
}

export function shellProfileHint(): string {
  if (process.platform === 'win32') {
    return 'your PowerShell profile or system environment settings';
  }
  return 'your shell profile (~/.bashrc, ~/.zshrc, etc.)';
}
