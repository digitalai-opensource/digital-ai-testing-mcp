/**
 * Terminal styling of the setup command (src/cli/ui.ts): color by meaning in a real terminal, plain text everywhere
 * else — tests, `setup doctor > report.txt`, NO_COLOR.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as ui from '../src/cli/ui.js';
import { runSetupCli } from '../src/cli/setup.js';

const ESC = '\x1b[';

afterEach(() => {
  ui.setColor(false);
  ui.setWidth(0);
});

describe('wrapping to the terminal width', () => {
  it('breaks at word boundaries and indents continuation lines under the item', () => {
    ui.setWidth(31); // 30 usable columns
    const wrapped = ui.wrap('  The URL is the address you open the portal with.');
    expect(wrapped.split('\n')).toEqual(['  The URL is the address you', '    open the portal with.']);
    for (const l of wrapped.split('\n')) expect(l.length).toBeLessThanOrEqual(30);
  });

  it('a line styled from its first character keeps its color code whole', () => {
    ui.setColor(true);
    ui.setWidth(31);
    const wrapped = ui.wrap(ui.gray('  The URL is the address you open the portal with.'));
    expect(ui.stripStyle(wrapped).split('\n')).toEqual(['  The URL is the address you', '    open the portal with.']);
    expect(wrapped.startsWith('  \x1b[90mThe')).toBe(true);
    expect(wrapped).not.toMatch(/(^|[^\x1b])\[\d+m/); // no code without its ESC
  });

  it('counts visible characters only, so styling never causes an early break', () => {
    ui.setColor(true);
    ui.setWidth(31);
    const line = `  ${ui.green('OK')} — a short line`;
    expect(ui.wrap(line)).toBe(line);
  });

  it('never wraps a command to copy, a long single word, or anything when the width is unknown', () => {
    ui.setColor(true);
    ui.setWidth(31);
    const cmd = `  ${ui.command('npx -y digital-ai-testing-mcp@latest setup clients add')}`;
    expect(ui.wrap(cmd)).toBe(cmd);
    expect(ui.wrap('  C:\\Users\\someone\\AppData\\Roaming\\digital-ai-testing\\profiles.json')).not.toContain('\n');
    ui.setWidth(0);
    const long = 'word '.repeat(40).trim();
    expect(ui.wrap(long)).toBe(long);
  });
});

describe('setup styling', () => {
  it('is plain text unless a terminal turned it on', () => {
    expect(ui.green('OK')).toBe('OK');
    expect(ui.prompt('Add the server to them? [Y/n] ')).toBe('Add the server to them? [Y/n] ');
    ui.setColor(true);
    expect(ui.green('OK')).toBe(`${ESC}32mOK${ESC}39m`);
    expect(ui.stripStyle(ui.bold(ui.red('x')))).toBe('x');
    expect(ui.gray('')).toBe(''); // nothing to style, no stray codes
  });

  it('a question is bold; its answer choices, default and example are gray', () => {
    ui.setColor(true);
    const choices = ui.prompt('Add the server to them? [Y/n] ');
    expect(choices).toBe(`${ui.bold('Add the server to them?')}${ui.gray(' [Y/n]')} `);
    const example = ui.prompt('Digital.ai Testing URL (e.g. https://yourcompany.experitest.com): ');
    expect(example).toBe(`${ui.bold('Digital.ai Testing URL')}${ui.gray(' (e.g. https://yourcompany.experitest.com)')}: `);
    expect(ui.stripStyle(ui.prompt('Profile name [admin]: '))).toBe('Profile name [admin]: ');
  });

  it('colors only for a terminal; NO_COLOR and TERM=dumb turn it off, FORCE_COLOR on', () => {
    expect(ui.colorWanted({ isTTY: true }, {})).toBe(true);
    expect(ui.colorWanted({ isTTY: false }, {})).toBe(false); // piped: setup doctor > report.txt
    expect(ui.colorWanted({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(ui.colorWanted({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(ui.colorWanted({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(ui.colorWanted({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false);
  });

  it('a scripted run (no terminal) prints no escape codes', async () => {
    const out: string[] = [];
    const io = {
      out: (t: string) => void out.push(t),
      err: (t: string) => void out.push(t),
      ask: async () => '',
      askSecret: async () => '',
      readStdin: async () => '',
      interactive: false,
      verify: async () => ({ ok: false as const, problem: 'unreachable' as const }),
    };
    await runSetupCli(['help'], io);
    await runSetupCli(['nonsense'], io);
    expect(out.join('\n')).not.toContain(ESC);
  });
});
