import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDevicesByQuery, getDevice } from '../api/devices.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import type { Device } from '../types/digital-ai.js';

function resolveSerial(d: Device): string {
  return d.deviceOs === 'iOS' ? (d.iosUdid || d.udid) : d.udid;
}

function deviceLabel(d: Device): string {
  return `${d.deviceName} (${d.deviceOs} ${d.osVersion})`;
}

export function registerDebugTools(server: McpServer): void {
  server.tool(
    'get_remote_debug_command',
    'Use this when you want to interact with a cloud device as if it were physically connected to your machine — ' +
    'for manual exploration, UI inspection, locator discovery, or step-through debugging against a published app. ' +
    'Common entry points: "I want to manually test on a real device", "build a test script on a live device", ' +
    '"find the XPath or element ID for a control in my app", "inspect a running app", ' +
    '"test against a published app without a test script yet", "debug without owning hardware".\n\n' +
    'rdb creates a gRPC/TLS tunnel that proxies ADB (Android) or usbmuxd (iOS) to localhost. ' +
    'Once running, the cloud device appears as a locally connected device — Android Studio, Xcode, ' +
    'Appium MCP, and command-line ADB all see it without reconfiguration. ' +
    'The MCP server constructs a ready-to-run script file; the user runs it locally.\n\n' +
    'IMPORTANT — sequence before connecting rdb:\n' +
    '  1. install_application — install the app while the device is still available.\n' +
    '     install_application FAILS while a device is reserved via rdb.\n' +
    '  2. get_remote_debug_command — connect rdb (device is now reserved)\n' +
    '  3. adb shell am start -n <package>/<activity> — launch the app\n' +
    '  4. Inspect UI elements (see below)\n' +
    '  5. get_test_boilerplate — generate test script with discovered element IDs\n\n' +
    'UI element ID extraction — two paths:\n' +
    '  Primary (UIAutomator dump):\n' +
    '    adb shell uiautomator dump /data/local/tmp/ui.xml\n' +
    '    adb pull /data/local/tmp/ui.xml\n' +
    '    Parse the XML for resource-id attributes.\n' +
    '  Fallback (if dump exits silently with no output — known issue on Android 15+ Samsung devices; also observed on Samsung Galaxy S20 Ultra, Android 13):\n' +
    '    adb shell pm path <package>           # get APK path on device\n' +
    '    adb pull <apk-path> app.apk           # pull APK locally\n' +
    '    aapt dump xmltree app.apk res/layout/activity_login.xml   # find element hex IDs\n' +
    '    aapt dump resources app.apk | grep ":id/"                 # resolve hex IDs to names\n' +
    '    (aapt is in %LOCALAPPDATA%/Android/Sdk/build-tools/<version>/ on Windows,\n' +
    '    ~/Library/Android/sdk/build-tools/<version>/ on Mac)\n' +
    '  Android Studio Layout Inspector: use Tools → Layout Inspector directly\n' +
    '    (does not require an Android app module in the project).\n' +
    '    If the device is not detected after rdb connects, restart ADB:\n' +
    '    adb kill-server && adb start-server\n\n' +
    'Device diagnostics — rdb is not just for UI inspection. Once connected, ADB can verify device health before committing to a test run:\n' +
    '    adb shell ping -c 3 8.8.8.8              # check internet connectivity\n' +
    '    adb shell nslookup google.com            # check DNS resolution\n' +
    '    adb shell dumpsys activity activities | grep topResumedActivity   # confirm foreground activity\n' +
    '    adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS  # dismiss blocking overlays\n' +
    '  Network checks are especially important before running NV-dependent tests (startPerformanceTransaction):\n' +
    '  a device with broken DNS will crash immediately when NV throttling activates.\n\n' +
    'AUTH NOTE: rdb serial number resolution requires Cloud Admin credentials. If the active profile is a\n' +
    '  project API key (aut_1_...), device serial lookup may fall back to the internal numeric device ID,\n' +
    '  which rdb rejects ("validation error / Failed to reserve device"). If this happens, switch to your\n' +
    '  Cloud Admin profile first: switch_environment("default") → get_remote_debug_command → switch back.\n\n' +
    'Discovery → codification workflow:\n' +
    '  Use rdb to connect and discover element selectors, then call get_test_boilerplate\n' +
    '  with those identifiers to generate a reusable script. The rdb connection can stay\n' +
    '  open while you iterate — validating each selector — then close it and trigger the\n' +
    '  final script via RemoteWebDriver without any debug session.\n\n' +
    'For returning users who already have rdb installed, pass rdb_path to skip the download/extract guide.',
    {
      serialNumber: z.string().optional().describe(
        'Device serial number (ADB serial for Android, UDID for iOS) or internal device ID from find_available_device. ' +
        'If omitted, an available device is selected automatically using devicePlatform/osVersion filters.'
      ),
      localPlatform: z.enum(['windows', 'macos']).describe(
        'Platform of the machine where the user will run the rdb script. ' +
        'Required — cannot be inferred because the MCP server runs in Docker. ' +
        'Determines the download URL, script format (.ps1 vs .sh), and binary name.'
      ),
      devicePlatform: z.enum(['android', 'ios']).optional().describe(
        'OS filter used when auto-selecting a device (serialNumber not provided). Ignored if serialNumber is given.'
      ),
      osVersion: z.string().optional().describe(
        'Minimum OS version filter when auto-selecting, e.g. "14.0". Ignored if serialNumber is given.'
      ),
      rdbPath: z.string().optional().describe(
        'Absolute path to the directory containing the rdb binary — the folder rdb extracts to ' +
        '(e.g. C:/tools/rdb/SeeTestRemoteDebugging on Windows, ~/tools/rdb/SeeTestRemoteDebugging on macOS). ' +
        'If provided, the download/extract guide is skipped. Use this for returning users who already have rdb installed.'
      ),
      outputFormat: outputFormatParam,
    },
    async ({ serialNumber, localPlatform, devicePlatform, osVersion, rdbPath, outputFormat }) => {
      try {
        const accessKey = process.env.DIGITAL_AI_ACCESS_KEY ?? '';
        const baseUrl = (process.env.DIGITAL_AI_BASE_URL ?? '').replace(/\/$/, '');

        // ── Resolve device ──────────────────────────────────────────────────
        let serial: string;
        let label: string;

        if (serialNumber) {
          // Look up device details for the confirmation header. Best-effort — if lookup
          // fails we still produce the script with just the serial as the label.
          let resolved: Device | null = null;
          try {
            const bySerial = await getDevicesByQuery(`@serialNumber='${serialNumber}'`);
            if (bySerial.length > 0) {
              resolved = bySerial[0];
            } else {
              // Caller may have passed the internal device ID from find_available_device
              resolved = await getDevice(serialNumber);
            }
          } catch {
            // Device lookup is best-effort; proceed with serial-only label
          }

          if (resolved) {
            const actualSerial = resolveSerial(resolved);
            serial = actualSerial || serialNumber;
            label = deviceLabel(resolved);
          } else {
            serial = serialNumber;
            label = `Serial: ${serialNumber}`;
          }
        } else {
          // Auto-select an available device matching the requested criteria
          const clauses: string[] = [];
          if (devicePlatform === 'android') clauses.push(`@os='android'`);
          else if (devicePlatform === 'ios') clauses.push(`@os='iOS'`);
          clauses.push(`@category='PHONE'`);

          const devices = await getDevicesByQuery(clauses.join(' and '));
          const candidates = devices.filter((d) => {
            if (d.displayStatus !== 'Available') return false;
            if (osVersion && parseFloat(d.osVersion) < parseFloat(osVersion)) return false;
            return true;
          });

          if (candidates.length === 0) {
            const osLabel = devicePlatform ? ` ${devicePlatform}` : '';
            const versionLabel = osVersion ? ` ${osVersion}+` : '';
            return {
              content: [{
                type: 'text' as const,
                text: `No available${osLabel}${versionLabel} devices found. Run list_devices to see current availability.`,
              }],
              isError: true,
            };
          }

          const d = candidates[0];
          serial = resolveSerial(d);
          label = deviceLabel(d);
        }

        // ── Build script ────────────────────────────────────────────────────
        const isWindows = localPlatform === 'windows';
        const scriptFilename = isWindows ? 'start-rdb.ps1' : 'start-rdb.sh';
        const downloadUrl = `${baseUrl}/download-rdb/?exist=&os=${isWindows ? 'win' : 'mac'}`;

        // Path to the rdb binary inside the script (uses shell variable expansion, not %VAR%)
        const scriptBinaryPath = rdbPath
          ? (isWindows ? `${rdbPath}\\rdb.exe` : `${rdbPath}/rdb`)
          : (isWindows
            ? '$env:USERPROFILE\\tools\\rdb\\SeeTestRemoteDebugging\\rdb.exe'
            : '$HOME/tools/rdb/SeeTestRemoteDebugging/rdb');

        let scriptContent: string;
        if (isWindows) {
          scriptContent = [
            '# start-rdb.ps1 — Digital.ai Remote Debug Bridge',
            '# Generated by digital-ai-testing MCP',
            '# WARNING: This file contains your access key. Delete it when your session is complete.',
            `$key = "${accessKey}"`,
            '$envFile = Join-Path $PSScriptRoot ".env"',
            'if (Test-Path $envFile) {',
            '    $line = Get-Content $envFile | Where-Object { $_ -match "^DIGITAL_AI_ACCESS_KEY=" } | Select-Object -First 1',
            '    if ($line) { $key = ($line -split "=", 2)[1].Trim() }',
            '}',
            `& "${scriptBinaryPath}" start-remote-debug \``,
            `    --url ${baseUrl} \``,
            '    --access-key $key `',
            `    --serial-number ${serial}`,
          ].join('\n');
        } else {
          scriptContent = [
            '#!/bin/bash',
            '# start-rdb.sh — Digital.ai Remote Debug Bridge',
            '# Generated by digital-ai-testing MCP',
            '# WARNING: This file contains your access key. Delete it when your session is complete.',
            `KEY="${accessKey}"`,
            'if [ -f ".env" ]; then',
            '    _key=$(grep "^DIGITAL_AI_ACCESS_KEY=" .env | cut -d\'=\' -f2-)',
            '    [ -n "$_key" ] && KEY="$_key"',
            'fi',
            `"${scriptBinaryPath}" start-remote-debug \\`,
            `    --url ${baseUrl} \\`,
            '    --access-key "$KEY" \\',
            `    --serial-number ${serial}`,
          ].join('\n');
        }

        // ── Build human output ──────────────────────────────────────────────
        const isProjectApiKey = !accessKey.startsWith('eyJ');
        const serialLooksLikeInternalId = /^\d+$/.test(serial);

        const lines: string[] = [];
        lines.push(`Remote debug session ready for: ${label}`);
        lines.push(`Serial: ${serial}`);
        lines.push('');

        if (isProjectApiKey || serialLooksLikeInternalId) {
          lines.push('⚠️  AUTH WARNING: rdb serial resolution requires Cloud Admin credentials.');
          if (isProjectApiKey) {
            lines.push('   The active profile is a project API key — device serial lookup may be incomplete.');
          }
          if (serialLooksLikeInternalId) {
            lines.push(`   "${serial}" is an internal device ID, not an ADB serial. rdb will likely reject it.`);
          }
          lines.push('   Fix: switch_environment("default") → re-run get_remote_debug_command → switch back.');
          lines.push('');
        }

        if (rdbPath) {
          // Compact output — returning user already has rdb
          lines.push(`Script: ${scriptFilename}`);
          lines.push('');
          lines.push('```');
          lines.push(scriptContent);
          lines.push('```');
          lines.push('');
          lines.push(`Write the above to ${scriptFilename} in your project root, then run:`);
          lines.push(isWindows ? `  .\\${scriptFilename}` : `  chmod +x ${scriptFilename} && ./${scriptFilename}`);
          lines.push('');
          lines.push('Keep the terminal open for the duration of your session.');
          lines.push('Press Ctrl+C to terminate the session and release the device.');
        } else {
          // Full first-time setup guide
          lines.push(`─── Pre-flight: Is rdb already installed? ${'─'.repeat(23)}`);
          lines.push('');
          lines.push('If you have local shell access, run this check now:');
          lines.push('');
          if (isWindows) {
            lines.push('  # 1. Check PATH first (fastest — works regardless of install location)');
            lines.push('  Get-Command rdb -ErrorAction SilentlyContinue | Select-Object Source');
            lines.push('');
            lines.push('  # 2. Check the recommended install location (no recursion)');
            lines.push('  Test-Path "$env:USERPROFILE\\tools\\rdb\\SeeTestRemoteDebugging\\rdb.exe"');
            lines.push('');
            lines.push('  # 3. Check the project root (for teams that vendor the binary)');
            lines.push('  Test-Path ".\\rdb.exe"');
          } else {
            lines.push('  which rdb 2>/dev/null || find ~/tools /usr/local/bin -name "rdb" 2>/dev/null | head -3');
          }
          lines.push('');
          lines.push('If you do not have local shell access, ask the user:');
          lines.push('  "Do you already have rdb installed? If yes, what\'s the full path to the folder');
          lines.push('   containing the rdb binary (e.g. the folder that contains rdb.exe or ./rdb)?"');
          lines.push('');
          lines.push('→ If rdb is found: call get_remote_debug_command again with rdb_path=<result>.');
          lines.push('  The full setup guide will be skipped — output will be the script only.');
          lines.push('→ If all checks return nothing: proceed immediately to the download instructions below.');
          lines.push('  Do not search further — if rdb is not in PATH, the recommended location, or the project root,');
          lines.push('  it is not installed.');
          lines.push('');

          lines.push(`─── Step 1: Download rdb ${'─'.repeat(38)}`);
          lines.push(downloadUrl);
          lines.push('');

          lines.push(`─── Step 2: Extract ${'─'.repeat(43)}`);
          if (isWindows) {
            lines.push('Suggested location: C:\\Users\\<your-username>\\tools\\rdb\\');
            lines.push('After extracting, you should have: C:\\Users\\<your-username>\\tools\\rdb\\SeeTestRemoteDebugging\\');
            lines.push('  (SeeTestRemoteDebugging is the Digital.ai Remote Debug Bridge folder — the name is set by the installer)');
            lines.push('');
            lines.push('Or create the directory with PowerShell:');
            lines.push('  New-Item -ItemType Directory -Force "$env:USERPROFILE\\tools\\rdb"');
          } else {
            lines.push('Suggested location: ~/tools/rdb/');
            lines.push('After extracting, you should have: ~/tools/rdb/SeeTestRemoteDebugging/');
            lines.push('  (SeeTestRemoteDebugging is the Digital.ai Remote Debug Bridge folder — the name is set by the installer)');
          }
          lines.push('');

          lines.push(`─── Step 3: Run the remote debug session ${'─'.repeat(22)}`);
          lines.push(`A ready-to-run script has been prepared: ${scriptFilename}`);
          lines.push('');
          lines.push('```');
          lines.push(scriptContent);
          lines.push('```');
          lines.push('');
          lines.push(`Write the above to ${scriptFilename} in your project root, then open a terminal there and run:`);
          lines.push(isWindows ? `  .\\${scriptFilename}` : `  chmod +x ${scriptFilename} && ./${scriptFilename}`);
          lines.push('');
          lines.push('Keep the terminal open for the duration of your session.');
          lines.push('Press Ctrl+C to terminate the session and release the device.');
          lines.push('');

          lines.push(`─── Optional: Add rdb to PATH (run once) ${'─'.repeat(22)}`);
          if (isWindows) {
            lines.push('[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$env:USERPROFILE\\tools\\rdb\\SeeTestRemoteDebugging", "User")');
            lines.push('# Restart your terminal for PATH to take effect.');
          } else {
            lines.push(`echo 'export PATH="$HOME/tools/rdb/SeeTestRemoteDebugging:$PATH"' >> ~/.zshrc && source ~/.zshrc`);
            lines.push('# After this, you can run rdb from anywhere.');
          }
          lines.push('');

          lines.push(`─── Once running ${'─'.repeat(46)}`);
          lines.push('The device will appear as a locally connected ADB device.');
          lines.push('Android Studio, Xcode, and Appium MCP will detect it automatically.');
          lines.push('If Android Studio does not detect the device, run: adb kill-server && adb start-server');
        }

        const authWarning = (isProjectApiKey || serialLooksLikeInternalId)
          ? 'Project API key active — serial resolution may be incomplete. Switch to Cloud Admin profile before running.'
          : null;

        return respond(outputFormat, {
          device: { label, serial },
          localPlatform,
          downloadUrl: rdbPath ? null : downloadUrl,
          scriptFilename,
          scriptContent,
          setupRequired: !rdbPath,
          authWarning,
        }, lines.join('\n'));

      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text' as const, text: `Failed to build remote debug command: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
