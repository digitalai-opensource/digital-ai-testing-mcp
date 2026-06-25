import { parseApiDate } from './timestamp.js';
import type {
  Device,
  DeviceReservation,
  Application,
  Project,
  User,
  ProvisioningProfile,
  RepositoryFile,
  Browser,
  TestReport,
  TestView,
  TestViewSummary,
  Agent,
  AgentRegion,
  Region,
  RegionTopology,
  NvServer,
  DeviceGroupV2,
  Transaction,
} from '../types/digital-ai.js';

const STATUS_EMOJI: Record<string, string> = {
  available: '🟢',
  online: '🟢',
  reserved: '🟡',
  offline: '🔴',
  error: '🔴',
  cleanup: '🔵',
  initializing: '🔵',
  maintenance: '🔧',
  disconnected: '⛔',
};

export function getStatusEmoji(status: string): string {
  return STATUS_EMOJI[status.toLowerCase()] ?? '⚪';
}

export function formatDeviceList(devices: Device[]): string {
  if (devices.length === 0) return 'No devices found.';

  const ios = devices.filter((d) => d.deviceOs === 'iOS');
  const android = devices.filter((d) => d.deviceOs === 'Android');

  const formatDevice = (d: Device): string => {
    const emoji = getStatusEmoji(d.displayStatus);
    const tags = d.tags && d.tags.length > 0 ? ` | Tags: ${d.tags.join(', ')}` : '';
    const region = d.region || d.agentLocation || '';
    const regionStr = region ? ` | Region: ${region}` : '';
    return `${emoji} ${d.deviceName} (ID: ${d.id}) — ${d.deviceOs} ${d.osVersion} | ${d.deviceCategory} | ${d.displayStatus}${regionStr}${tags}`;
  };

  const lines: string[] = [];

  if (ios.length > 0) {
    lines.push(`iOS Devices (${ios.length}):`);
    ios.forEach((d) => lines.push(`  ${formatDevice(d)}`));
  }

  if (android.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Android Devices (${android.length}):`);
    android.forEach((d) => lines.push(`  ${formatDevice(d)}`));
  }

  return lines.join('\n');
}

export function formatDeviceHealthSummary(
  devices: Device[],
  offlineThresholdMinutes = 60
): string {
  if (devices.length === 0) return 'No devices found in the environment.';

  const statusCounts: Record<string, number> = {};
  for (const d of devices) {
    const s = d.displayStatus.toLowerCase();
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const available = statusCounts['available'] ?? 0;
  const reserved = statusCounts['reserved'] ?? 0;
  const offline = statusCounts['offline'] ?? 0;
  const other = devices.length - available - reserved - offline;

  const ios = devices.filter((d) => d.deviceOs === 'iOS').length;
  const android = devices.filter((d) => d.deviceOs === 'Android').length;

  const agentMap: Record<string, { online: number; total: number }> = {};
  for (const d of devices) {
    if (!agentMap[d.agentName]) agentMap[d.agentName] = { online: 0, total: 0 };
    agentMap[d.agentName].total++;
    if (d.displayStatus.toLowerCase() !== 'offline' && d.displayStatus.toLowerCase() !== 'disconnected') {
      agentMap[d.agentName].online++;
    }
  }

  const longOffline = devices.filter((d) => {
    const mins = parseFloat(d.statusAgeInMinutes);
    return d.displayStatus.toLowerCase() === 'offline' && !isNaN(mins) && mins > offlineThresholdMinutes;
  });

  const lines: string[] = [
    `📊 Device Health Summary (${devices.length} total)`,
    '',
    '── Status Breakdown ──',
    `  🟢 Available:    ${available}`,
    `  🟡 Reserved:     ${reserved}`,
    `  🔴 Offline:      ${offline}`,
    `  ⚪ Other:        ${other}`,
    '',
    '── By OS ──',
    `  🍎 iOS:          ${ios}`,
    `  🤖 Android:      ${android}`,
    '',
    '── By Agent ──',
  ];

  const agents = Object.entries(agentMap).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [agent, counts] of agents) {
    lines.push(`  ${agent}: ${counts.online} online / ${counts.total} total`);
  }

  if (longOffline.length > 0) {
    lines.push('');
    lines.push(`⚠️  Devices Offline > ${offlineThresholdMinutes} minutes:`);
    for (const d of longOffline) {
      lines.push(`  🔴 ${d.deviceName} (${d.agentName}) — offline for ${d.statusAgeInMinutes} min`);
    }
  }

  return lines.join('\n');
}

export function formatDeviceReservationList(reservations: DeviceReservation[]): string {
  if (reservations.length === 0) return 'No reservations found.';

  return reservations
    .map((r) => {
      const start = parseApiDate(r.reservationStart).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const end = parseApiDate(r.reservationEnd).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const notes = r.reservationNotes ? ` | Notes: ${r.reservationNotes}` : '';
      return `• Reservation #${r.reservationId} — Device UID: ${r.deviceUid} | User: ${r.username} | Project: ${r.project} | Start: ${start} → End: ${end}${notes}`;
    })
    .join('\n');
}

export function formatApplicationList(apps: Application[]): string {
  if (apps.length === 0) return 'No applications found.';

  const iosApps = apps.filter((a) => a.osType === 'IOS');
  const androidApps = apps.filter((a) => a.osType === 'ANDROID');

  const formatApp = (a: Application): string => {
    const uploaded = a.createdAtFormatted || new Date(a.createdAt).toISOString().split('T')[0];
    const unique = a.uniqueName ? ` | Unique: ${a.uniqueName}` : '';
    return `  • ${a.applicationName} v${a.releaseVersion} (build ${a.buildVersion}) — ${a.fileType.toUpperCase()} | Uploaded: ${uploaded}${unique}`;
  };

  const lines: string[] = [];

  if (iosApps.length > 0) {
    lines.push(`iOS Apps (${iosApps.length}):`);
    iosApps.forEach((a) => lines.push(formatApp(a)));
  }

  if (androidApps.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Android Apps (${androidApps.length}):`);
    androidApps.forEach((a) => lines.push(formatApp(a)));
  }

  return lines.join('\n');
}

export function formatProjectList(projects: Project[]): string {
  if (projects.length === 0) return 'No projects found.';

  return projects
    .map((p) => {
      const created = p.created
        ? new Date(p.created).toISOString().split('T')[0]
        : 'unknown';
      const mode = p.isAppiumOss === true ? 'Appium Server (OSS)' : 'Appium Grid';
      return `• ${p.name} (ID: ${p.id}) — ${mode} — Created: ${created}`;
    })
    .join('\n');
}

export function formatUserList(users: User[]): string {
  if (users.length === 0) return 'No users found.';

  return users
    .map((u) => {
      const roles = Object.entries(u.roles)
        .map(([role, projects]) => `${role}: ${projects.join(', ')}`)
        .join('; ');
      const lastLogin = u.lastAuthentication
        ? new Date(u.lastAuthentication).toISOString().split('T')[0]
        : 'never';
      const tagStr = u.tags?.length > 0 ? ` | Tags: ${u.tags.join(', ')}` : '';
      return `• ${u.userName} (ID: ${u.id}) — ${u.firstName} ${u.lastName} | ${roles} | Last login: ${lastLogin}${tagStr}`;
    })
    .join('\n');
}


export function formatProvisioningProfileList(profiles: ProvisioningProfile[]): string {
  if (profiles.length === 0) return 'No provisioning profiles found.';

  const now = Date.now();

  return profiles
    .map((p) => {
      const expiry = parseApiDate(p.expirationDate);
      const expiryMs = expiry.getTime();
      const daysLeft = Math.floor((expiryMs - now) / (1000 * 60 * 60 * 24));
      const dateStr = expiry.toISOString().split('T')[0];

      let status: string;
      if (daysLeft < 0) {
        status = `🔴 EXPIRED: ${p.profileName} (${p.profileUUID}) — Expired: ${dateStr}`;
      } else if (daysLeft <= 30) {
        status = `🟡 EXPIRING SOON: ${p.profileName} (${p.profileUUID}) — Expires: ${dateStr} (in ${daysLeft} days)`;
      } else {
        status = `🟢 VALID: ${p.profileName} (${p.profileUUID}) — Expires: ${dateStr} (in ${daysLeft} days)`;
      }
      return status;
    })
    .join('\n');
}

export function formatRepositoryFileList(files: RepositoryFile[]): string {
  if (files.length === 0) return 'No files found in the repository.';

  return files
    .map((f) => {
      const sizeKb = (f.size / 1024).toFixed(1);
      const uploaded = f.uploadTime ? new Date(f.uploadTime).toISOString().split('T')[0] : 'unknown';
      return `• ${f.uniqueName} (ID: ${f.id}) — ${sizeKb} KB | Project: ${f.projectName} | Uploaded by: ${f.uploadedUser} | ${uploaded}`;
    })
    .join('\n');
}

export function formatTestReport(report: TestReport): string {
  const statusEmoji = report.status === 'Passed' ? '✅' : report.status === 'Failed' ? '❌' : '⚠️';
  const durationSec = report.duration != null ? (report.duration / 1000).toFixed(1) : 'n/a';
  const started = new Date(report.start_time).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  const lines: string[] = [
    `${statusEmoji} ${report.name}`,
    `   UUID: ${report.uuid} | ID: ${report.test_id}`,
    `   Status: ${report.status} | Duration: ${durationSec}s | Started: ${started}`,
  ];

  if (report.cause) {
    lines.push(`   Cause: ${report.cause}`);
  }
  if (report.errorCategory) {
    const classification = report.errorClassification ? ` (${report.errorClassification})` : '';
    lines.push(`   Error Category: ${report.errorCategory}${classification}`);
  }

  if (report.testAttachments && report.testAttachments.length > 0) {
    lines.push(`   Attachments: ${report.testAttachments.length}`);
  }

  if (report.steps && report.steps.length > 0) {
    lines.push(`   Steps (${report.steps.length}):`);
    for (const step of report.steps) {
      const stepEmoji = step.status === 'Passed' ? '✅' : step.status === 'Failed' ? '❌' : '⚠️';
      lines.push(`     ${stepEmoji} ${step.name}`);
      if (step.subSteps && step.subSteps.length > 0) {
        for (const sub of step.subSteps) {
          const subEmoji = sub.status === 'Passed' ? '✅' : sub.status === 'Failed' ? '❌' : '⚠️';
          lines.push(`       ${subEmoji} ${sub.name}`);
        }
      }
    }
  }

  return lines.join('\n');
}

export function formatTestReportList(reports: TestReport[]): string {
  if (reports.length === 0) return 'No test reports found.';
  return reports.map(formatTestReport).join('\n\n');
}

export function formatTestAttachments(report: TestReport): string {
  const lines: string[] = [
    `Test: ${report.name}`,
    `UUID: ${report.uuid}`,
    `Has attachments: ${report.has_attachment === 'Y' ? 'Yes' : 'No'}`,
    `Attachment count: ${report.attachment_count}`,
    `Attachments size: ${(report.attachments_size / 1024).toFixed(1)} KB`,
  ];
  if (report.testAttachments && report.testAttachments.length > 0) {
    lines.push('\nAttachment details:');
    for (const a of report.testAttachments) {
      lines.push(`  • ${a.type} — ${a.filePath} (${(a.size / 1024).toFixed(1)} KB)`);
    }
  } else if (report.has_attachment === 'Y') {
    lines.push('\nUse download_test_attachments to retrieve the files as a ZIP.');
  }
  return lines.join('\n');
}

export function formatGroupedTestReports(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);
  const obj = result as Record<string, unknown>;

  const rows = Array.isArray(obj['data'])
    ? (obj['data'] as Record<string, unknown>[])
    : Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : null;

  if (!rows || rows.length === 0) {
    if (obj['totalCount'] !== undefined) return `Total: ${obj['totalCount']} — no grouped rows.`;
    return JSON.stringify(result, null, 2);
  }

  const totalLine = obj['totalCount'] !== undefined ? `Total: ${obj['totalCount']}\n\n` : '';

  const headers = Object.keys(rows[0]);
  const colWidths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[h] ?? '').length))
  );
  const divider = colWidths.map((w) => '─'.repeat(w + 2)).join('┼');
  const headerRow = headers.map((h, i) => ` ${h.padEnd(colWidths[i])} `).join('│');
  const dataRows = rows.map((r) =>
    headers.map((h, i) => ` ${String(r[h] ?? '').padEnd(colWidths[i])} `).join('│')
  );

  return totalLine + [headerRow, divider, ...dataRows].join('\n');
}

export function formatProjectTestSummary(
  statusCounts: Record<string, number>,
  total: number,
  timeWindow: string,
  topFailures: string[]
): string {
  const passed = statusCounts['Passed'] ?? 0;
  const failed = statusCounts['Failed'] ?? 0;
  const incomplete = statusCounts['Incomplete'] ?? 0;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';

  const lines = [
    `📊 Project Test Summary`,
    ``,
    `   All-time counts:`,
    `     Total:      ${total}`,
    `     ✅ Passed:   ${passed}`,
    `     ❌ Failed:   ${failed}`,
    `     ⚠️  Incomplete: ${incomplete}`,
    `     Pass rate:  ${passRate}%`,
  ];

  if (topFailures.length > 0) {
    lines.push(``, `   Top failing tests (${timeWindow}):`);
    for (const name of topFailures) lines.push(`     • ${name}`);
  } else {
    lines.push(``, `   No failures found in window: ${timeWindow}`);
  }

  return lines.join('\n');
}

export function formatTestViewList(views: TestView[]): string {
  if (views.length === 0) return 'No test views found.';
  return views
    .map((v) => {
      const dashboard = v.showInDashboard ? ' | Dashboard: ✅' : '';
      const keys = v.keys && v.keys.length > 0 ? ` | Keys: ${v.keys.join(', ')}` : '';
      return `• ${v.name} (ID: ${v.id}) — View by: ${v.byKey} | Created by: ${v.createdBy}${dashboard}${keys}`;
    })
    .join('\n');
}

export function formatTestViewSummary(summary: TestViewSummary): string {
  const total = summary._count_;
  const passRate = total > 0 ? ((summary.passedCount / total) * 100).toFixed(1) : '0.0';
  return [
    `📊 Test Results Summary (${total} total)`,
    `  ✅ Passed:     ${summary.passedCount}`,
    `  ❌ Failed:     ${summary.failedCount}`,
    `  ⚠️  Incomplete: ${summary.incompleteCount}`,
    `  ⏭️  Skipped:    ${summary.skippedCount}`,
    `  Pass rate:    ${passRate}%`,
  ].join('\n');
}

export function formatBrowserList(browsers: Browser[]): string {
  if (browsers.length === 0) return 'No browsers found.';

  const grouped: Record<string, Record<string, string[]>> = {};

  for (const b of browsers) {
    const os = b.osName || b.platform || 'Unknown OS';
    if (!grouped[os]) grouped[os] = {};
    if (!grouped[os][b.agentName]) grouped[os][b.agentName] = [];
    grouped[os][b.agentName].push(`${b.browserName} ${b.browserVersion}`);
  }

  const lines: string[] = [];

  for (const [os, agents] of Object.entries(grouped).sort()) {
    lines.push(`${os}:`);
    for (const [agent, browserList] of Object.entries(agents).sort()) {
      lines.push(`  • ${browserList.join(', ')} — Agent: ${agent}`);
    }
  }

  return lines.join('\n');
}

export function formatAgentList(agents: Agent[]): string {
  if (agents.length === 0) return 'No agents found.';
  return agents
    .map((a) => {
      const statusEmoji = a.available && a.enabled ? '🟢' : !a.enabled ? '⛔' : '🟡';
      const warn = a.warningMessages && a.warningMessages.length > 0 ? ` ⚠️ ${a.warningMessages.join('; ')}` : '';
      const xcodeStr = a.xcodeVersion ? ` | Xcode: ${a.xcodeVersion}` : '';
      return (
        `${statusEmoji} ${a.name} (ID: ${a.id}) — ${a.osType} ${a.osVersion} | ` +
        `Region: ${a.region?.name ?? a.region} | Devices: ${a.devicesCount} | Status: ${a.statusForDisplay}${xcodeStr}${warn}`
      );
    })
    .join('\n');
}

export function formatRegionList(regions: Region[]): string {
  if (regions.length === 0) return 'No regions found.';
  return regions
    .map((r) => {
      const masterStr = r.master ? ' [MASTER]' : '';
      const errStr = r.errors && r.errors.length > 0 ? ` ⚠️ Errors: ${r.errors.join('; ')}` : '';
      return `• ${r.name} (ID: ${r.id})${masterStr} — Status: ${r.status} | Host: ${r.hostOrIp}:${r.port} | Location: ${r.location}${errStr}`;
    })
    .join('\n');
}

export function formatRegionTopology(regionName: string, topology: RegionTopology): string {
  const section = (title: string, items: Array<{ name: string; status: string; host: string; error?: string }>) => {
    if (!items || items.length === 0) return '';
    const rows = items.map((c) => {
      const errStr = c.error ? ` ⚠️ ${c.error}` : '';
      const emoji = c.status === 'connected' || c.status === 'ok' || c.status === 'running' ? '🟢' : '🔴';
      return `    ${emoji} ${c.name} — ${c.host}${errStr}`;
    });
    return [`  ${title} (${items.length}):`, ...rows].join('\n');
  };
  const sections = [
    section('NV Servers', topology.nvservers ?? []),
    section('Selenium Agents', topology.seleniumAgents ?? []),
    section('Signers', topology.signers ?? []),
    section('Storages', topology.storages ?? []),
    section('DHMs', topology.dhms ?? []),
    section('EHMs', topology.ehms ?? []),
    section('Reporters', topology.reporters ?? []),
    section('Analytics', topology.analytics ?? []),
    section('MDMs', topology.mdms ?? []),
  ].filter(Boolean);
  return [`📡 Region Topology: ${regionName}`, ...sections].join('\n');
}

export function formatNvServerList(servers: NvServer[]): string {
  if (servers.length === 0) return 'No NV servers found.';
  return servers
    .map((s) => {
      const statusEmoji = s.status === 'connected' || s.status === 'ok' ? '🟢' : '🔴';
      const tunnelStr = s.tunnelingConnected ? ' | Tunneling: ✅' : ' | Tunneling: ❌';
      const errStr = s.error ? ` ⚠️ ${s.error}` : '';
      const regionStr = typeof s.region === 'object' && s.region !== null ? (s.region as AgentRegion).name : s.region;
      return `${statusEmoji} ${s.name} (ID: ${s.id}) — Region: ${regionStr} | Host: ${s.hostOrIp} | Status: ${s.status}${tunnelStr}${errStr}`;
    })
    .join('\n');
}

export function formatDeviceGroupV2List(groups: DeviceGroupV2[]): string {
  if (groups.length === 0) return 'No device groups found.';
  return groups
    .map((g) => `• ${g.name} (ID: ${g.id}) — ${g.numberOfDevices} device(s) | Type: ${g.type} | Accept new: ${g.acceptNewDevices}`)
    .join('\n');
}

const fmt1 = (n: number | null | undefined, unit = ''): string =>
  n == null ? 'n/a' : `${n.toFixed(1)}${unit}`;
const fmtBytes = (b: number): string =>
  b === 0 ? '0' : b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`;

export function formatTransactionList(transactions: Transaction[]): string {
  if (transactions.length === 0) return 'No transactions found.';
  return transactions
    .map((t) => {
      const dur = t.duration ? `${(t.duration / 1000).toFixed(2)}s` : 'n/a';
      const cpu = fmt1(t.cpuAvg, '%');
      const mem = t.memAvg != null ? `${t.memAvg.toFixed(0)}MB` : 'n/a';
      const net = `↑${fmtBytes(t.totalUploadedBytes)} ↓${fmtBytes(t.totalDownloadedBytes)}`;
      // Speed Index is a composite visual-progress score (lower = better), NOT a duration — labelled "SI" to avoid the ms confusion (v42).
      const si = t.speedIndex != null ? `${t.speedIndex.toFixed(0)} SI` : 'n/a';
      return (
        `• [${t.id}] "${t.name}" — ${t.appName} v${t.appVersion || '?'} | ` +
        `${t.deviceOs} ${t.deviceVersion} | ${t.deviceName}\n` +
        `  Speed Index: ${si} | Duration: ${dur} | CPU avg: ${cpu} | Mem avg: ${mem} | Net: ${net} | ${t.date}`
      );
    })
    .join('\n\n');
}

export function formatTransaction(t: Transaction): string {
  const dur = t.duration ? `${(t.duration / 1000).toFixed(2)}s` : 'n/a';
  const lines = [
    `📊 Transaction: "${t.name}" (ID: ${t.id})`,
    `  App:      ${t.appName} v${t.appVersion || 'unknown'}`,
    `  Device:   ${t.deviceName} — ${t.deviceOs} ${t.deviceVersion} (${t.deviceModel})`,
    `  Date:     ${t.startTime}`,
    `  Duration: ${dur}${t.speedIndex != null ? ` | Speed Index: ${t.speedIndex} SI (composite visual-progress score, not elapsed time)` : ''}`,
    `  Network:  ${t.networkProfile || 'none'} | ↑${fmtBytes(t.totalUploadedBytes)} ↓${fmtBytes(t.totalDownloadedBytes)}`,
    '',
    '  Performance metrics:',
    `    CPU:     avg ${fmt1(t.cpuAvg, '%')} / max ${fmt1(t.cpuMax, '%')}`,
    `    Memory:  avg ${fmt1(t.memAvg, 'MB')} / max ${fmt1(t.memMax, 'MB')}`,
    `    Battery: avg ${fmt1(t.batteryAvg, 'mW')} / max ${fmt1(t.batteryMax, 'mW')}`,
  ];
  if (t.cpuSamples && t.cpuSamples.length > 0) {
    lines.push(`  Time-series samples available: CPU(${t.cpuSamples.length}), Memory(${t.memorySamples?.length ?? 0}), Battery(${t.batterySamples?.length ?? 0}), Network-DL(${t.networkDownloadSamples?.length ?? 0}), Network-UL(${t.networkUploadSamples?.length ?? 0})`);
  }
  if (t.testId) lines.push(`  Linked test ID: ${t.testId}`);
  return lines.join('\n');
}

