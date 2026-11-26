/**
 * Failure causes made readable and countable (src/utils/failure-cause.ts), and the device-name hint after a start that
 * found no device (src/api/device-name-hint.ts). Shapes from UAT 2026-11-25, paraphrased.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { stripAnsi, causeText, causeGroupKey, causeQuote } from '../src/utils/failure-cause.js';
import { suggestDeviceNames } from '../src/api/device-name-hint.js';

describe('failure causes', () => {
  it('terminal colour codes are taken out', () => {
    assert.equal(stripAnsi('\u001b[31mTest timeout of 30000ms exceeded.\u001b[39m'), 'Test timeout of 30000ms exceeded.');
    assert.equal(stripAnsi(undefined), undefined);
    assert.equal(causeText('\u001b[2m  at login.spec.ts:12\u001b[22m'), 'at login.spec.ts:12');
  });

  it('a wrapped Appium error is read from what follows "Original error:", and a long one is cut at the END', () => {
    const wrapped = "Cannot start the 'com.example.app' application. Consider checking the driver's troubleshooting documentation. " +
      'Original error: Error executing adbExec. Original error: \'Command adb -P 5037 install failed\' exited with code 1; Stderr: INSTALL_FAILED_VERSION_DOWNGRADE';
    assert.match(causeText(wrapped), /^Error executing adbExec\. Original error: 'Command adb|^'Command adb/);
    const q = causeQuote(wrapped, 80);
    assert.doesNotMatch(q, /^Cannot start/, 'the wrapper is not what is quoted');
    assert.ok(q.length <= 81 && q.endsWith('…'));
  });

  it('a pytest cause is read from its "E" lines, not from the test source before them', () => {
    const pytest = 'driver = <appium.webdriver.webdriver.WebDriver (session="abc")>\n\n    def test_login_success(driver):\n>       login(driver)\n' +
      'E       selenium.common.exceptions.NoSuchElementException: Message: An element could not be located\nE       Stacktrace: none';
    assert.equal(causeText(pytest), 'selenium.common.exceptions.NoSuchElementException: Message: An element could not be located Stacktrace: none');
    assert.equal(causeText('driver = <x>\ndef test_a(driver): login'), 'driver = <x> def test_a(driver): login', 'no E lines: the text as it is');
  });

  it('causes that differ only in a session id, a UUID, a time or a long number are one group', () => {
    const a = 'Could not start appium test. The test request with the provided session id: CLOUD-SID:2026-11-23_15-01-46-a1b2 timed out';
    const b = 'Could not start appium test. The test request with the provided session id: CLOUD-SID:2026-11-23_14-59-45-c3d4 timed out';
    assert.equal(causeGroupKey(a), causeGroupKey(b));
    assert.equal(causeGroupKey('Session 7f9c2b1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f not found'), causeGroupKey('Session 00000000-1111-2222-3333-444444444444 not found'));
    assert.equal(causeGroupKey('Run 20261125211403 failed at 21:14:03'), causeGroupKey('Run 20261124090000 failed at 09:00:00'));
    assert.notEqual(causeGroupKey('Element not found: pay_button'), causeGroupKey('Element not found: login_button'));
    assert.equal(causeGroupKey(null), '(no cause recorded)');
    assert.equal(causeGroupKey('\u001b[31mTest timeout\u001b[39m'), causeGroupKey('Test timeout'));
  });
});

describe('device-name hint after "No available device matching"', () => {
  const names = ['Samsung Galaxy S25 Plus US-0311', 'Samsung Galaxy S25 Plus US-0312', 'Pixel 8 US-0100', null];
  it('a partial name gets the full names that contain it, and the contains() form', () => {
    const hint = suggestDeviceNames('Galaxy S25 Plus US-0311', names);
    assert.match(hint, /No device is named exactly 'Galaxy S25 Plus US-0311' .* did you mean 'Samsung Galaxy S25 Plus US-0311'\? Or match part of the name: contains\(@name,'Galaxy S25 Plus US-0311'\)\./);
    assert.doesNotMatch(hint, /US-0312/);
    assert.match(suggestDeviceNames('galaxy s25', names), /'Samsung Galaxy S25 Plus US-0311' or 'Samsung Galaxy S25 Plus US-0312'/);
  });
  it('nothing to add when the name exists; a plain pointer when nothing is close', () => {
    assert.equal(suggestDeviceNames('Pixel 8 US-0100', names), '');
    assert.match(suggestDeviceNames('iPhone 99', names), /No device is named 'iPhone 99' \(@name must match the whole name\) — list_devices shows the names\./);
  });
});
