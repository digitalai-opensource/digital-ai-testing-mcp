/**
 * classifyShellCommand — which adb shell commands device_control runs without confirmation. Cloud devices are shared,
 * so the read-only list is narrow and anything that can chain a second command is treated as a change.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { classifyShellCommand, capShellOutput, shellCommandProblem, SHELL_OUTPUT_LIMIT } from '../src/utils/adb-shell.js';

const ro = (c: string) => classifyShellCommand(c).readOnly;

describe('classifyShellCommand', () => {
  it('read-only commands run without confirmation', () => {
    for (const c of [
      'getprop ro.build.version.release', 'dumpsys battery', 'dumpsys activity activities', 'settings get global airplane_mode_on',
      'settings list secure', 'pm list packages com.experitest', 'pm path com.experitest.ExperiBank', 'cmd package list packages',
      'wm size', 'wm density', 'ls /sdcard/Download', 'cat /proc/meminfo', 'df', 'ps -A', 'id', 'ip addr',
    ]) assert.equal(ro(c), true, c);
  });

  it('commands that change the device need confirmation', () => {
    for (const c of [
      'reboot', 'setprop debug.x 1', 'settings put global airplane_mode_on 1', 'settings delete global x', 'pm uninstall com.x',
      'pm clear com.x', 'pm grant com.x android.permission.CAMERA', 'cmd package install-existing com.x', 'rm -rf /sdcard/x',
      'am start -n com.x/.Main', 'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS', 'wm size 1080x1920',
      'wm density reset', 'dumpsys battery set level 5', 'dumpsys battery unplug', 'svc wifi disable', 'input keyevent 26',
      'logcat -c', 'ip link set wlan0 down',
    ]) assert.equal(ro(c), false, c);
  });

  it('shell operators make any command a change — a read cannot carry a write', () => {
    for (const c of ['getprop; reboot', 'dumpsys battery | grep level', 'cat x > /sdcard/y', 'getprop && reboot', 'echo $(reboot)', 'ls `reboot`']) {
      const r = classifyShellCommand(c);
      assert.equal(r.readOnly, false, c);
      assert.match(r.reason, /shell operators/, c);
    }
  });

  it('explains which forms are read-only', () => {
    assert.match(classifyShellCommand('pm install /sdcard/a.apk').reason, /read-only: list, path, dump/);
    assert.match(classifyShellCommand('reboot').reason, /not on the read-only list/);
  });

  it('refuses logcat and a bare dumpsys with the better route (both failed live 2026-11-12)', () => {
    assert.match(shellCommandProblem('logcat -d -t 3') ?? '', /get_device_log/);
    assert.match(shellCommandProblem('dumpsys') ?? '', /name one/);
    assert.equal(shellCommandProblem('dumpsys battery'), null);
    assert.equal(shellCommandProblem('getprop'), null);
  });

  it('caps long output with a narrowing hint', () => {
    assert.equal(capShellOutput('short'), 'short');
    const capped = capShellOutput('x'.repeat(SHELL_OUTPUT_LIMIT + 10));
    assert.match(capped, /output truncated \(\d+ chars in total\)/);
  });
});
