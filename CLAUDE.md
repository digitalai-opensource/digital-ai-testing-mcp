# CLAUDE.md — Developer Guide for digital-ai-testing-mcp

## Project Overview

MCP server exposing the Digital.ai Continuous Testing REST API as Claude tools. Built with TypeScript + `@modelcontextprotocol/sdk` (McpServer class). All tools are registered via `McpServer.tool()` in `src/tools/`.

## Commands

```bash
npm run build          # tsc — must pass before committing
npm run test           # run all integration tests (requires .env)
npm run test:reporting # run only reporting tests
npm run dev            # nodemon + ts-node for local dev
```

## Architecture

```
src/
  api/           # One file per API domain — pure async functions, no tool logic
  tools/         # MCP tool/resource/prompt registrations — thin wrappers over api/
  types/         # Shared TypeScript interfaces
  utils/         # client.ts, response-formatter.ts, pagination.ts, etc.
```

**Rule:** `src/api/` functions throw `Error` on failure. `src/tools/` handlers catch and return `{ isError: true }`. Never let API errors propagate to the MCP transport uncaught.

## API Client (`src/api/client.ts`)

```ts
apiGet<T>(path, params?)         // GET
apiPost<T>(path, body?, params?) // POST — params go to query string, body to request body
apiPut<T>(path, body?, params?)  // params go to query string, body to request body
apiPatch<T>(path, body?)         // PATCH — body only
apiDelete<T>(path, params?)      // params go to query string; no body support
apiPostForm<T>(path, formData)   // multipart uploads
apiPutForm<T>(path, formData)    // multipart PUT uploads
apiDownload(path)                // returns Buffer for binary responses
```

Axios client is lazy-initialised on first call. Auth is `X-API-KEY: ${DIGITAL_AI_ACCESS_KEY}`.

**Retry:** `apiGet`/`apiDownload` and the read-only reporter POSTs (`/tests/list`, `/tests/grouped`, `/tests/distinct`, `/transactions/list`, `/testView/list`) retry up to 2× with backoff on transient failures (429/5xx/network). Mutating calls are never retried. Multi-page scans survive one transient error mid-scan.

## Credentials — single source of truth

**Never read `process.env.DIGITAL_AI_ACCESS_KEY` / `DIGITAL_AI_BASE_URL` outside `client.ts` and `profile-loader.ts`.** Env vars reflect the DEFAULT profile only and ignore `switch_environment` — reading them leaked the admin JWT into generated boilerplate/rdb scripts and pointed inspection sessions at the wrong cloud when a non-default profile was active.

Use the accessors from `src/api/client.ts`, which fall back to env before the lazy client initialises:

```ts
getActiveUrl()        // base URL of the active profile
getActiveAccessKey()  // credential of the active profile
getActiveKeyType()    // 'jwt' | 'api-key'
```

## Local path validation (`src/utils/path-guard.ts`)

- `validateOutputPath` — every tool that WRITES a local file (downloads) must call it
- `validateInputPath` — every tool that READS a local file (uploads) must call it; additionally refuses credential-file names (`.env*`, SSH private keys) so a steered request cannot exfiltrate secrets to the cloud repository

## Response Envelope Inconsistency

Most `/api/v1/*` endpoints wrap in `{ status, data, code }` — unwrap with `.data`:
```ts
const res = await apiGet<ApiResponse<Foo[]>>('/api/v1/devices');
return res.data; // Foo[]
```

**Exceptions that return data directly (no wrapper):**
- `GET /api/v1/applications` — returns `Application[]`
- `GET /api/v1/applications/:id` — returns `Application`
- `GET /api/v1/projects` — returns `Project[]`

**Reporter endpoints** (`/reporter/api/*`) also return directly:
- List endpoints return `{ count, data }` — NOT `ApiResponse`
- Single-resource endpoints return the object directly

See comments in `src/api/applications.ts` and `src/api/reporting.ts`.

## Device Query Syntax

`list_devices` accepts a `query` parameter for server-side filtering. `find_available_device` uses only the confirmed-working subset internally.

**CONFIRMED WORKING server-side fields** (tested live against the API):

| Field | Example | Notes |
|---|---|---|
| `@os` | `'android'`, `'iOS'` | Case-insensitive |
| `@version` | `'14.0'` | Decimal required — `'14'` matches nothing; supports `=`, `>`, `<`, `!=` |
| `@category` | `'PHONE'`, `'TABLET'` | **Case-sensitive — UPPERCASE required**; `'phone'` returns nothing |
| `@region` | `'US2'`, `'SG1'` | Exact match |
| `@serialNumber` | `'4hlfovzdxwnfu8xw'` | Exact device serial/UDID |
| `@name` | `'iPhone 12 SGDemo-0165'` | Exact device display name (NOT `@deviceName`) |
| `@model` | `'iPhone 12'`, `'M2007J22C'` | Exact model code or display name |
| `@modelName` | `'Xiaomi Redmi Note 9 5G'` | Exact human-readable model name |
| `@emulator` | `'false'`, `'true'` | (NOT `@isEmulator`) |

Combine with `and`:
```
@os='android' and @category='PHONE' and @version>'13.0'
@os='iOS' and @region='US2'
```

**Fields that look valid but silently return 0 results — do NOT use in queries:**
- `@manufacturer` — accepted without error but always returns empty; filter client-side
- `@tag` — same; filter client-side
- `@deviceName` — use `@name` (exact) instead
- `@id`, `@udid`, `@imei` — return nothing; use `@serialNumber` for device lookup
- `@status`, `@displayStatus`, `@available` — return nothing
- `@agentName`, `@host`, `@location`, `@agentLocation` — return nothing
- `@pool`, `@devicePool`, `@isEmulator` — return nothing
- `@project`, `@group`, `@deviceGroup` — return nothing
- `@phoneNumber`, `@notes`, `@resolution`, `@screenWidth` — return nothing

**`find_available_device` filtering model:**
- Server-side (fast): `@os`, `@category`
- Client-side (always works): `manufacturer`, `tags`, `model`, `osVersion`

Do not pass `@manufacturer` or `@tag` in the `query` parameter to `list_devices` — use the `model`/`region` params on `list_devices` or the dedicated params on `find_available_device` instead.

## Device Status Values (`displayStatus`)

Common values seen in production:

| Status | Meaning |
|---|---|
| `Available` | Ready to use |
| `In Use` | Currently occupied by a user/test |
| `Reserved` | Booked via reservation API |
| `Offline` | Agent not connected |
| `Cleanup` | Post-session cleanup in progress |
| `Initializing` | Coming online |

The `statusAgeInMinutes` field (string, parse with `parseFloat`) tells how long the device has been in its current status. Used by `release_orphaned_sessions`.

## Reporter API Field Names

The reporter API uses **snake_case** in list results (unlike the rest of the API which uses camelCase).
Single-record GET (`/reporter/api/tests/{id}`) uses camelCase (`startTime`, `id`) — normalised to snake_case by `normalizeSingleTest`.

| Field | Type | Notes |
|---|---|---|
| `uuid` | string | Test execution UUID |
| `test_id` | number | Numeric reporter ID |
| `name` | string | Test name |
| `status` | string | `Passed`, `Failed`, `Incomplete`, `Skipped`, `Error`, `Healed` |
| `success` | boolean | `true` when Passed |
| `start_time` | string | ISO 8601 |
| `create_time` | string | ISO 8601 |
| `duration` | number \| null | Milliseconds; `null` for in-progress sessions |
| `project_id` | number | |
| `has_attachment` | string | `"Y"` or `"N"` |
| `attachment_count` | number | |
| `attachments_size` | number | Bytes |
| `status_code` | number | |

`keyValuePairs` (device/app metadata) is only on single-record GET, not in list results.

## Reporter API: ID Taxonomy

| Identifier | Type | Source | Retrieval endpoint |
|---|---|---|---|
| `test_id` | `number` | List results, search results | `GET /reporter/api/tests/{test_id}` |
| `uuid` | `string` | List results | No direct GET by UUID — look up by `test_id` |
| `report_api_id` | `string` | Session-start API (`create_mobile_manual_test`, `start_manual_test_session`) | `GET /reporter/api/tests?report_api_id=X` (session-created tests only, after session ends) |

## Reporter API: Filter Capabilities

Confirmed live-tested on both Cloud Admin JWT and Project API key. Blocked fields fail with 401 on **both** key types — this is server middleware, not auth-type-dependent.

**CONFIRMED WORKING filter properties** (operators: `=`, `>`, `<`, `>=`, `<=`):

| Property | Operators | Notes |
|---|---|---|
| `status` | `=` | `"Passed"`, `"Failed"`, `"Incomplete"`, `"Skipped"`, `"Error"`, `"Healed"` |
| `name` | `=`, `contains` | `contains` is case-insensitive substring |
| `success` | `=` | Boolean `true`/`false` — string `"true"` is CSRF-blocked |
| `has_attachment` | `=` | `"Y"` or `"N"` |
| `test_id` | `=` | Returns 1 record |
| `project_id` | `=` | |
| `device.os` | `=` | `"Android"` or `"iOS"` — **case-sensitive** |
| `duration` | `=`, `>`, `<`, `>=`, `<=` | Milliseconds |
| `attachment_count` | `=`, `>`, `<`, `>=`, `<=` | |
| `attachments_size` | `=`, `>`, `<`, `>=`, `<=` | Bytes |
| `status_code` | `=` | |

**CSRF-BLOCKED** filter properties (fail with 401 regardless of auth type): `start_time`, `create_time`, `uuid`

**CSRF-BLOCKED** operators: `!=`, `like`, `startsWith`, `in`

**Sort** — ALL sort fields are CSRF-blocked for project API keys (non-JWT). Cloud Admin JWT only. `listTests` silently strips `sort` for project keys; callers must not rely on sorted order.

**Any caller that needs "latest"/"most recent" semantics must use `listTestsSortedDesc`** (in `reporting.ts`), never `listTests` with a sort param. JWT: single server-sorted call. Project keys: scans all pages (up to 5 000 records, returns `scanCapped: true` when truncated), sorts client-side, trims to the requested limit. Used by `find_latest_test_for_name`, `get_test_stability_report`, `get_project_test_summary`, `list_active_test_executions`, and the `recent-test-failures` resource.

The blocked-filter-property check and the `success` string→boolean coercion are shared by `listTests` and `getGroupedTests` via `sanitizeReporterFilter` — both endpoints accept the same filter syntax, so new reporter functions that accept a `filter` must apply it too.

For date-range filtering, use `startDate`/`endDate` parameters on `list_test_reports` — these fetch pages sorted descending (JWT) or unsorted with full-scan (project key) and apply the date comparison client-side.

## Reporter API: Project Scoping

Reporter endpoints (`/reporter/api/*`) have a split CSRF behavior on project-scoping query params:

| Param | CSRF status | Notes |
|---|---|---|
| `projectName` | ✅ NOT blocked | Use this to scope reporter calls to a specific project |
| `projectId` | ❌ CSRF-blocked (401) | Numeric ID triggers CSRF middleware — **never send to reporter endpoints** |

`reporting.ts` functions (`listTests`, `deleteTests`, `getGroupedTests`, `getDistinctKeyValues`) accept `projectId` in their TypeScript signature for forward-compatibility but **silently ignore it** when building query params — only `projectName` is sent.

Without `projectName`, Cloud Admin JWT searches its own scoped reporter context (which may not include projects with separate reporter instances). If tests from a specific project aren't appearing, pass `projectName` matching the exact project name from `list_projects`.

## Project settings — v2 vs v1

`GET /api/v2/projects/{id}` returns 35+ fields not in the v1 list: per-type license limits (`maxDevelopmentLicense`, `maxManualLicense`, `maxGridLicenses`, `maxEmulatorsLicense`, `maxSeleniumSessions`), all `enable*` cleanup flags, reservation policies (`maxReservations`, `maxReservationsPerUser`, `maxReservationTime`), feature flags, and user/app counts. Cloud Admin JWT only. Use `get_project_admin_settings` tool to access this.

`GET /api/v1/projects` returns only `id`, `name`, `isAppiumOss`, `created`, `notes`. There is no `GET /api/v1/projects/{id}` single-record endpoint (returns 404).

## v2 API (Cloud Admin JWT only)

Several endpoints exist only under `/api/v2/` and require Cloud Admin JWT. Project API keys receive 403 Forbidden.

| Endpoint | Tool | Description |
|---|---|---|
| `GET /api/v2/agents` | `list_agents` | Host machines / test agents |
| `GET /api/v2/agents/{id}/devices` | `get_agent_devices` | Devices on a specific agent |
| `GET /api/v2/regions` | `list_regions` | Geographic regions (US1, UK1, SG1, etc.) |
| `GET /api/v2/regions/{id}` | `get_region_topology` | Full infrastructure map of a region |
| `GET /api/v2/nv-servers` | `list_nv_servers` | Network Virtualization servers |
| `GET /api/v2/nv-servers/{id}` | `get_nv_server` | Single NV server detail |
| `GET /api/v2/device-groups` | (used by `list_device_groups`) | Richer group data with `numberOfDevices`, `type` |
| `GET /api/v2/sessions` | `list_active_sessions` | Currently active browser/Selenium sessions |
| `GET /api/v2/license` | `get_license_info` | Platform license limits (devices, browsers) |
| `GET /reporter/api/projects` | `get_reporter_project_storage` | Per-project storage metrics (MB, quota, artifact counts) |
| `GET /api/v2/projects/{id}` | `get_project_admin_settings` | Full project config — 35+ fields: license limits, cleanup flags, reservation policies, feature flags |
| `POST /reporter/api/transactions/list` | `list_transactions` | Performance transaction records (CPU/memory/battery/network metrics) |
| `GET /reporter/api/transactions/{id}` | `get_transaction` | Single transaction with time-series sample arrays |

## Transactions API (Performance reporting)

`POST /reporter/api/transactions/list` returns ALL transaction records — no server-side pagination or filtering.
`filter`, `sort`, `limit`, `page` body params are CSRF-blocked (401). `startDate`, `endDate`, `pageSize` etc. are silently ignored.
All filtering is applied client-side in the MCP tools.

Fields (camelCase, unlike the tests list API which uses snake_case):
`id`, `name`, `appName`, `appVersion`, `startTime`, `date`, `deviceUid`, `deviceName`, `deviceModel`, `deviceOs`, `deviceManufacturer`, `deviceVersion`, `deviceScreen`, `deviceType`, `networkProfile`, `cpuAvg`, `cpuMax`, `memAvg`, `memMax`, `batteryAvg`, `batteryMax`, `totalUploadedBytes`, `totalDownloadedBytes`, `duration`, `speedIndex`, `videoStart`, `videoEnd`, `userName`, `testId`, `projectId`, `projectName`

Single-record GET (`/reporter/api/transactions/{id}`) adds time-series arrays: `cpuSamples`, `memorySamples`, `batterySamples`, `networkDownloadSamples`, `networkUploadSamples` — each is `[{timestamp: ms, value: number}]`.

`POST /reporter/api/transactions/compare` — CSRF-blocked, browser session only.
HAR/video download endpoints return Angular SPA HTML, not data.

Auth: Cloud Admin JWT only. Project API keys return 401 on all transaction endpoints.

## Reporter grouped endpoint

`POST /reporter/api/tests/grouped` requires the **`groupBy`** field (NOT `keys` — `keys` is silently ignored). Example:

```json
{"groupBy":["device.os"],"pivotBy":["status"],"returnTotalCount":true}
```

Returns one row per unique value combination. `null` OS value = browser/Selenium sessions. Multi-field grouping works: `["device.os","status"]`. Supports `filter` to scope the aggregation.

## Applications — server-side filter capabilities

`GET /api/v1/applications` — confirmed working params (others silently ignored):

| Param | Works | Notes |
|---|---|---|
| `osType` | ✅ | Case-insensitive: `IOS` or `ios` both work |
| `packageName` | ✅ | Exact match only |
| `bundleIdentifier` | ✅ | Exact match only |
| `uniqueName` | ✅ | Exact match only |
| `fileType` | ✅ | `apk`, `ipa`, `aab`, `zip` |
| `buildVersion` | ✅ | Exact match only |
| `isForSimulator` | ✅ | |
| `cameraSupport` | ✅ | |
| `applicationName` | ❌ | Silently ignored — use client-side `nameContains` filter |
| `networkCaptureSupport` | ❌ | Silently ignored — filter client-side |

## Reservations — server-side filter capabilities

`GET /api/v1/device-reservations` — confirmed working params:

| Param | Works | Notes |
|---|---|---|
| `username` | ✅ | Exact match |
| `projectId` | ✅ | Numeric project ID |
| `deviceId` | ✅ | Numeric device ID |
| `serialNumber` | ✅ | Device UDID string |
| `project` | ❌ | Causes 400 error — use `projectId` instead |
| `deviceUid` | ❌ | Causes 400 error — use `deviceId` instead |
| `start`/`end` | ❌ | Silently ignored — apply date range client-side |

## Date format: MM/DD/YYYY HH:mm:ss

Several API endpoints return dates in `MM/DD/YYYY HH:mm:ss` format (not ISO 8601):
- `DeviceReservation.reservationStart`, `reservationEnd`
- `RepositoryFile.uploadTime`, `lastUpdate`
- `ProvisioningProfile.expirationDate`

Parse with the dedicated `parseProvisioningDate`/`parseReservationDate` helpers in the response formatter and API layer. Do NOT use `new Date(s)` directly — it is non-portable for this format.

## Sortable/Filterable Report Fields

Sort properties work for **Cloud Admin JWT only**. All sort fields are CSRF-blocked for project API keys — `listTests` silently strips them.

- `start_time` — ascending or descending (JWT only)

## Slow Endpoints

These make multiple or expensive API calls — avoid calling in tight loops:

- `get_environment_summary` — aggregates all devices + agents
- `get_project_test_summary` — makes 2 reporter API calls
- `delete_test_reports_before_date` — paginates to collect all IDs before deleting
- `bulk_install_to_group` — one API call per device in the group
- `get_transaction_performance_summary` — fetches ALL transactions then aggregates client-side
- `get_performance_trend` — fetches ALL transactions then buckets client-side
- `get_cross_platform_divergence` — calls `getGroupedTests` which can return large multi-field result sets
- `get_daily_execution_trend` — paginates up to `maxRecords` (default 5 000) test records serially
- `find_latest_test_for_name`, `get_test_stability_report`, `get_project_test_summary`, `list_active_test_executions` — fast for JWT, but under a **project API key** each does a full-scan via `listTestsSortedDesc` (up to 5 000 records) because server-side sort is CSRF-blocked

## Destructive Operations

All tools that delete or release must use `checkDestructiveGuard(confirmDeletion, description)`:

```ts
const guard = checkDestructiveGuard(confirmDeletion, 'Delete user 42');
if (guard) return { content: [{ type: 'text', text: guard }] };
// proceed with deletion
```

**Do NOT set `isError: true` on the guard response.** That makes the LLM treat the safety gate as a tool failure instead of an instruction to re-call with `confirmDeletion: true`.

## MCP SDK Notes

Use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` — NOT the low-level `Server` from `server/index.js`. The `.tool()`, `.resource()`, and `.prompt()` methods live on `McpServer` only.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
```

## Grid vs OSS Protocol Difference (Python)

The Android Java country picker is **intentionally different** between Grid and OSS variants:
- **Grid (JSONWP):** `countryTextField.sendKeys("US")` — works because JSONWP allows direct sends
- **OSS (W3C):** Click `countryButton` XPath, then select — required by W3C protocol

This is not a bug. Do not "fix" one to match the other.

## Appium Grid vs Appium Server — Fundamental Protocol Difference

**Appium Grid is NOT standard Appium Server.** It is a proprietary Experitest framework built during
the JSON Wire Protocol (JWP) era, before the W3C WebDriver specification. It has been deprioritized
by Digital.ai; modern Appium Server is the recommended path. Legacy projects with `isAppiumOss=false`
are on Appium Grid.

When `serverMode` is `"grid"`, ALL boilerplate workarounds exist because of this protocol mismatch —
not because of Python version conflicts:

| Symptom | Root cause |
|---|---|
| `"Cant run Appium Grid with Appium client 8+"` | Appium Grid cannot parse W3C session requests; the error message is misleading — it is NOT a version check |
| `desired_capabilities=` works; `options=` rejected | JWP session format is what the proprietary protocol expects |
| `find_element()` returns `{"ELEMENT": "..."}` dicts | Appium Grid was never updated to return W3C element references |
| `is_displayed()` must use Appium's `WebElement`, not Selenium's | Selenium's version uses `execute_script` (JavaScript injection), which fails on native app contexts |

**`"Cant run Appium Grid with Appium client 8+"` is a misleading error.** It does not mean the client
version is too high. It means the session request was sent in W3C format that the proprietary protocol
cannot parse. The fix is to use JWP-style initialization, not to downgrade the client.

**Confirmed working Python/Grid configuration (5/5 tests verified on real Android devices):**
- `appium-python-client==2.2.0` + `selenium==4.9.0` — both pinned explicitly
  - `appium.options` package does NOT exist in 2.2.0
  - Selenium 4.10+ removed `desired_capabilities` from its `WebDriver.__init__`
- `appium.webdriver.Remote(..., desired_capabilities=dict)` — NOT `selenium.webdriver.Remote` with `options=`
- `_elem()` wrapper using `appium.webdriver.webelement.WebElement` — JWP sessions return raw dicts
- `self.driver.desired_capabilities.get(...)` in tearDown

**OSS template** uses `Appium-Python-Client>=4.0.0` with `AppiumOptions` + `options=` — standard W3C,
works with standalone Appium Server. `self.driver.capabilities` is correct for OSS tearDown.

`requirements.txt` files must be proper package manifests (one package per line, no `pip install` prefix).

## Remote Debug (`get_remote_debug_command`)

### Output format — script file, not inline command

The tool generates `start-rdb.ps1` (Windows) or `start-rdb.sh` (macOS) and outputs the script content for the agent to write to the project root. It does **not** emit an inline shell command. Reason: multi-line commands with line-continuation characters (`^` / `` ` ``) break silently on copy-paste due to invisible trailing spaces, and `&&` is not valid in PowerShell 5.1.

The script reads `DIGITAL_AI_ACCESS_KEY` from `.env` if present (avoids persisting credentials on disk), falls back to the hardcoded key from the MCP environment.

### Install-before-connect constraint

`install_application` **fails while a device is reserved via rdb**. The correct sequence is:

```
install_application(appId, deviceId)     ← device must be Available, not reserved
get_remote_debug_command(serialNumber)   ← device is now reserved
adb shell am start -n <pkg>/<activity>  ← launch the app
[inspect / iterate]
get_test_boilerplate(...)               ← generate reusable script
```

If the agent calls `install_application` after `get_remote_debug_command`, it will get a 400 error. Correct order: install first, connect second.

### UI element ID extraction

**Primary — UIAutomator dump:**
```
adb shell uiautomator dump /data/local/tmp/ui.xml
adb pull /data/local/tmp/ui.xml
```
Parse the XML for `resource-id` attributes.

**Fallback — APK inspection (when UIAutomator silently exits with no output):**
Known to fail silently on Android 15+ Samsung devices (OS restriction on UiAutomation). Also observed on Samsung Galaxy S20 Ultra (Android 13). On these devices, prefer `open_mobile_studio` (no ADB required) or Android Studio Layout Inspector over the APK path below.
```
adb shell pm path <package>
adb pull <path> app.apk
aapt dump xmltree app.apk res/layout/activity_login.xml
aapt dump resources app.apk | grep ":id/"
```
`aapt` is in `%LOCALAPPDATA%\Android\Sdk\build-tools\<version>\` (Windows) or `~/Library/Android/sdk/build-tools/<version>/` (Mac).

**Android Studio Layout Inspector:** accessible via **Tools → Layout Inspector** — does not require an Android app module. If the device is not detected after rdb connects: `adb kill-server && adb start-server`.

### Windows path requirements

Use `$env:USERPROFILE` (PowerShell variable) inside `.ps1` scripts — correct and expands at runtime.
Use `C:\Users\<username>\...` (literal) in any GUI-facing text (e.g. "Extract to this folder") — Windows Explorer does not expand `%USERPROFILE%`.
Never use `%USERPROFILE%` in paths passed to `claude mcp add` or stored in `~/.claude.json` — use forward slashes (`C:/path/to/.env`).

## Performance Transactions — `executeScript` Syntax

`seetest:client` commands use **dot-notation**: the method name is part of the script string, arguments are separate parameters.

```java
// Java — correct
driver.executeScript("seetest:client.startPerformanceTransaction", "3G-average");
driver.executeScript("seetest:client.endPerformanceTransaction", "Login");

// Java — WRONG (rejected on both Grid and OSS)
driver.executeScript("seetest:client", new Object[]{"startPerformanceTransaction", "3G-average"});
```

```python
# Python — correct
self.driver.execute_script("seetest:client.startPerformanceTransaction", "3G-average")
```

```js
// Node.js — correct
await browser.execute('seetest:client.startPerformanceTransaction', '3G-average');
```

**NV throttling warning:** `startPerformanceTransaction` activates network throttling immediately. If the app has background network calls during initialization (analytics, config fetches), start the transaction AFTER the UI is stable — or the app may ANR/crash. Use this to measure a specific action (e.g. button tap → next screen), not the full session.

**NV profile names:** Must be configured on the NV server and obtained from your platform admin. `"wifi"` and `"3G-average"` are common but not guaranteed to exist on all deployments.

## Boilerplate Generation — Device Routing

### `region` parameter (v23+)

`get_test_boilerplate` accepts an optional `region` parameter. When provided, it appends `and @region='<value>'` to the generated `digitalai:deviceQuery` capability for all platforms and languages.

**Recommended pre-run flow:**
```
find_available_device(os=android)  →  read region from response (e.g. "US2")
get_test_boilerplate(platform=android, ..., region="US2")
  → generates: "@os='android' and @category='PHONE' and @region='US2'"
```

Without `region`, the deviceQuery is evaluated against all devices in all regions — including devices that have been offline for weeks — producing silent routing failures.

### `NoSuchElementException` diagnostic rule

**Pattern:** Session connects successfully + app launches + `NoSuchElementException` on elements that other tests in the same suite find — and the failure is consistent across re-runs.

**This is a device health signal, not a code or timing issue.** The device is likely in an unexpected state (wrong Activity from a previous session, or offline entirely but still in the project pool).

**Do NOT:** increase `implicitly_wait`, add `noReset`, or re-run tests before checking device health.
**Do:** run `get_device_health_summary` or `list_devices` filtered to the project. Look for devices with `statusAge > 1440 minutes` (24 h) and status `Offline` — these should not be in the pool. If found, update the `deviceQuery` to add `@region='<healthy-region>'` to exclude the problem device.

## Node.js Version & Vitest Pin

**Current local Node.js: 22 LTS** — all engine requirements satisfied.

`vitest` is pinned to `^3.x` deliberately. The outstanding `npm audit` finding (`GHSA-5xrq-8626-4rwp`) is a Vitest UI server vulnerability. This project never runs the UI server (`vitest run` only), so there is no attack surface. `npm audit --omit=dev` reports zero vulnerabilities.

**To upgrade vitest:** run `npm install vitest@^4 --save-dev`. No Node version constraint — Node 22 supports vitest 4.x fully.

## Inspection Sessions (WebDriver-based Native Inspection)

`src/api/webdriver.ts` implements a **separate Axios instance** that connects to the Grid at
`{DIGITAL_AI_BASE_URL}/wd/hub` using JWP (`desiredCapabilities`) format. It does **not** reuse
the main `client.ts` instance (which sends `X-API-KEY` headers — the Grid uses `digitalai:accessKey`
inside the session capability instead).

### In-process session registry

```ts
const sessionRegistry = new Map<string, InspectionSession>(); // keyed by handle (8-char UUID slice)
const allReportIds = new Set<number>();                        // all reportTestIds created this process
```

Both are cleared on MCP server restart. Orphaned Grid sessions timeout on their own (default 4 min).

### Session response format — JWP vs W3C (regional)

Different agent regions run different Appium versions and return different response formats:

| Format | Region example | Response shape |
|---|---|---|
| **JWP** | SG region (Appium 1.8.0) | `{ sessionId: "CLOUD-SID:...", value: { caps... }, status: 0 }` |
| **W3C** | US2 region (Appium 3.1.2) | `{ value: { sessionId: "uuid...", capabilities: { caps... } } }` |

`createInspectionSession` handles both. The format is NOT determined by key type — it depends on which region allocates the device.

### Capability field names — JWP vs W3C

| Cap field | JWP (Appium 1.x) | W3C (Appium 2.x/3.x) |
|---|---|---|
| Report ID | `digitalai:reportTestId` | `digitalai:reportTestId` |
| Report URL | `digitalai:reportUrl` | `digitalai:reportUrl` |
| Mobile Studio link | `digitalai:cloudViewLink` | `digitalai:cloudViewLink` |
| Serial number | `deviceUDID` / `device.serialNumber` | `deviceUDID` / `udid` |
| Device display name | `device.name` | `digitalai:cloudDeviceName` |
| Model | `device.model` | `digitalai:publicModel` |
| OS | `device.os` | `platformName` |
| OS version | `device.version` | `platformVersion` |
| Screenshot format | PNG (`iVBORw0K`) | JPEG (`/9j/`) |
| Element ID format | short numeric `"11"` | UUID `"00000000-0000-..."` |

### WebDriver attribute names (Appium 1.x and 2.x)

Use XML-matching hyphenated names — **not** camelCase:
- `resource-id` (not `resourceId`)
- `content-desc` (not `contentDescription`)
- `class`, `text`, `bounds`, `clickable`, `enabled` — all work as-is

### Cleanup mechanism

`stop_inspection_session` → `quitInspectionSession(handle)` → calls
`deleteTests([reportTestId])` (POST `/reporter/api/tests/delete`) immediately after the Grid session
is deleted. The HTTP DELETE method on `/reporter/api/tests/{id}` is CSRF-blocked (confirmed); the
POST bulk-delete endpoint is the only working path.

`cleanup_inspection_sessions` iterates `allReportIds` for orphaned reports from sessions that
were abandoned without calling `stop_inspection_session`.

### Limitation: Android only / JWP only

The current implementation hardcodes `platformName: "Android"` and JWP session format.
iOS and W3C/OSS sessions are not yet supported.

## Adding a New Tool

1. Add the API function to `src/api/<domain>.ts`
2. Add any new types to `src/types/digital-ai.ts`
3. Add a formatter to `src/utils/response-formatter.ts` if the output needs human-readable formatting
4. Register the tool in `src/tools/<domain>-tools.ts`
5. Run `npm run build` — fix all TypeScript errors before committing
6. Add an integration test in `tests/<domain>.test.ts`
7. If the tool has a destructive guard, JWT gate, or path validation, add a handler-level case to `tests/tools.test.ts` — it exercises registered tools through an in-memory MCP transport against an unreachable host, so guards/gates are asserted without touching the live API
8. Add the new script to `package.json` if it's a new test file
9. Add the tool to the README.md tool reference table
