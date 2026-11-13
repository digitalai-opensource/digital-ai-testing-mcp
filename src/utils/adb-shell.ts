/**
 * ADB shell on Android Appium Server sessions (`mobile: shell`) — verified live 2026-11-12 (Galaxy S22, Android 13):
 * ~0.5 s per command, runs as uid 2000 (shell), and the command string reaches a real shell (`echo hi; id` ran both).
 * Cloud devices are shared, so only commands that read state run without confirmation; everything else — including
 * any command with shell operators, which could chain a change onto a read — needs confirmChange: true.
 */

/** Characters that let one command string run, redirect or substitute another. */
const SHELL_OPERATORS = /[;&|`$<>\n\\]|\(|\)/;

/** Subcommands of read-only tools that change device state (dumpsys battery set/unplug/reset, …). */
const MUTATING_WORDS = new Set([
  'set', 'put', 'delete', 'reset', 'unplug', 'clear', 'enable', 'disable', 'install', 'uninstall', 'grant', 'revoke', 'kill', 'force-stop', 'start', 'stop', 'broadcast',
  // ip addr|route add/del/flush/…; dumpsys deviceidle force-idle/step/whitelist; dumpsys batterystats/procstats --write/--checkin
  'add', 'del', 'flush', 'change', 'replace', 'append', 'force-idle', 'force-inactive', 'unforce', 'step', 'whitelist', 'tempwhitelist', 'write', 'checkin',
]);

/** command → allowed first argument (null = any arguments that pass the other checks). */
const READ_ONLY: Record<string, ReadonlySet<string> | null> = {
  getprop: null,
  dumpsys: null,
  id: null,
  uname: null,
  df: null,
  ps: null,
  ls: null,
  cat: null,
  getenforce: null,
  uptime: null,
  settings: new Set(['get', 'list']),
  pm: new Set(['list', 'path', 'dump']),
  cmd: new Set(['package']), // checked further below: only "cmd package list|path|resolve-activity"
  wm: new Set(['size', 'density']), // with no value — "wm size 1080x1920" changes it
  ip: new Set(['addr', 'address', 'route', 'link']),
};

/**
 * Commands refused outright, with the better route. Live 2026-11-12: "logcat -d -t 3" hung 62 s then 500'd through
 * mobile: shell; a bare "dumpsys" (every service) ran 41 s and returned an empty string.
 */
export function shellCommandProblem(command: string): string | null {
  const words = command.trim().split(/\s+/);
  if (words[0] === 'logcat') return 'logcat hangs through mobile: shell — use get_device_log (it tails and filters the device log).';
  if (words[0] === 'dumpsys' && words.length === 1) return 'a bare "dumpsys" dumps every service and comes back empty — name one, e.g. "dumpsys battery", "dumpsys activity activities", "dumpsys window", "dumpsys meminfo <package>".';
  return null;
}

export interface ShellClassification {
  readOnly: boolean;
  /** Why confirmation is needed (empty when readOnly). */
  reason: string;
  /** The full command line as the device will run it. */
  commandLine: string;
}

export function shellCommandLine(command: string, args: string[] = []): string {
  return [command, ...args].join(' ').trim();
}

export function classifyShellCommand(command: string, args: string[] = []): ShellClassification {
  const commandLine = shellCommandLine(command, args);
  const change = (reason: string): ShellClassification => ({ readOnly: false, reason, commandLine });
  if (!commandLine) return change('empty command');
  if (SHELL_OPERATORS.test(commandLine)) return change('it contains shell operators (; | & $ ` < > or parentheses), which can chain or redirect commands');
  const words = commandLine.split(/\s+/);
  const [tool, first] = words;
  if (!(tool in READ_ONLY)) return change(`"${tool}" is not on the read-only list`);
  const allowedFirst = READ_ONLY[tool];
  if (allowedFirst && !(first && allowedFirst.has(first))) {
    return change(`"${[tool, first].filter(Boolean).join(' ')}" is not a read-only form of ${tool} (read-only: ${[...allowedFirst].join(', ')})`);
  }
  if (tool === 'cmd' && !['list', 'path', 'resolve-activity'].includes(words[2] ?? '')) return change('only "cmd package list|path|resolve-activity" is treated as read-only');
  if (tool === 'wm' && words.length > 2) return change(`"wm ${first}" with a value changes the display`);
  // Flags count too: "dumpsys batterystats --reset", "dumpsys procstats --clear", "--enable full-wake-history".
  const mutating = words.slice(1).find((w) => MUTATING_WORDS.has(w.toLowerCase().replace(/^-+/, '')));
  if (mutating) return change(`"${mutating}" changes device state`);
  return { readOnly: true, reason: '', commandLine };
}

export function shellGuardMessage(c: ShellClassification): string {
  return (
    `⚠️  Safety guard triggered.\n\n` +
    `"adb shell ${c.commandLine}" may change the device (${c.reason}). Cloud devices are shared: a reboot, uninstall, ` +
    `settings change or file deletion affects whoever uses the device next.\n\n` +
    `If the user asked for this change, re-call device_control with action "shell", the same command, and ` +
    `confirmChange: true.\n\nNo changes were made.`
  );
}

/** Cap returned output — `dumpsys` alone can be hundreds of KB. */
export const SHELL_OUTPUT_LIMIT = 20_000;

export function capShellOutput(out: string): string {
  if (out.length <= SHELL_OUTPUT_LIMIT) return out;
  return `${out.slice(0, SHELL_OUTPUT_LIMIT)}\n… output truncated (${out.length} chars in total). Narrow the command, e.g. "dumpsys battery" instead of "dumpsys".`;
}
