export interface SlashCommand {
  cmd: string;
  args?: string;
  desc: string;
  /** Requires an argument, so it is excluded from the numbered picker menu. */
  requiresArg?: boolean;
  /** Alias of another command; shown in help but excluded from the picker. */
  aliasOf?: string;
}

export interface SlashCommandGroup {
  label: string;
  commands: SlashCommand[];
}

export const SLASH_COMMAND_GROUPS: SlashCommandGroup[] = [
  {
    label: 'Session',
    commands: [
      { cmd: '/help', desc: 'show all slash commands' },
      { cmd: '/status', desc: 'show model / provider / mode / cost' },
      { cmd: '/cost', desc: 'alias for /status', aliasOf: '/status' },
      { cmd: '/history', desc: 'show tasks run this session' },
      { cmd: '/clear', desc: 'clear the screen' },
      { cmd: '/exit', desc: 'quit trident' },
    ],
  },
  {
    label: 'Agent',
    commands: [
      { cmd: '/retry', desc: 're-run the last task' },
      { cmd: '/undo', desc: 'revert last file write or edit' },
      { cmd: '/save', args: '[file]', desc: 'save session transcript to a .md file' },
      { cmd: '/compact', desc: 'trim session history and undo stack' },
      { cmd: '/budget', args: '[usd|clear]', desc: 'show, set, or clear the session budget' },
      { cmd: '/profile', args: '[name|clear]', desc: 'show or switch trained profile' },
      { cmd: '/profiles', desc: 'list trained profiles' },
      { cmd: '/override', args: '[text|clear]', desc: 'show or set system override' },
    ],
  },
  {
    label: 'Project',
    commands: [
      { cmd: '/init', desc: 'generate TRIDENT.md for the current project' },
      { cmd: '/context', desc: 'show current TRIDENT.md contents' },
      { cmd: '/tree', desc: 'show project file tree' },
      { cmd: '/cwd', desc: 'show working directory' },
      { cmd: '/diff', desc: 'show uncommitted git changes' },
      { cmd: '/commit', args: '[message]', desc: 'stage and commit; AI writes the message if omitted' },
    ],
  },
  {
    label: 'Config',
    commands: [
      { cmd: '/model', args: '<name>', desc: 'switch model (slash in name -> OpenRouter)', requiresArg: true },
      { cmd: '/provider', args: '<name>', desc: 'switch provider - anthropic | openrouter | codex', requiresArg: true },
      { cmd: '/mode', args: '<name>', desc: 'switch approval mode - yolo | review | lockdown', requiresArg: true },
      { cmd: '/yolo', desc: 'shortcut for /mode yolo' },
      { cmd: '/safe', desc: 'shortcut for /mode review' },
      { cmd: '/lock', desc: 'shortcut for /mode lockdown' },
      { cmd: '/models', desc: 'list available models' },
      { cmd: '/sessions', desc: 'list past session log files' },
    ],
  },
];
