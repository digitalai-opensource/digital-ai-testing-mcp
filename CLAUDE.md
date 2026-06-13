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

**Always read `displayStatus`, never `currentStatus`** — `currentStatus` only ever holds
`online`/`offline`/`error` (confirmed live, v36). Filtering it for `'available'`/`'reserved'`
matches nothing; this bug made `check_ios_readiness` report `ready: false` permanently.

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
| `user` | `=` | Email, exact match — for "my reports" use the email from `get_my_account_info` (confirmed live, v34a) |
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

## Performance Comparison Tools

Built on transaction data. Layering follows the repo convention — pure math is isolated from the API and tool layers:

- `src/utils/performance-stats.ts` — pure statistics (mean/median/`trimmedMean`/`stddev`/`mad`/`detectOutliersMAD`/`summarizeMetric`). No network, no domain types — unit-tested with plain number arrays.
- `src/utils/performance-comparison.ts` — domain compute over a `Transaction[]` the caller already fetched: `resolveSide`, `buildComparison`, `buildConfoundAssessment`, `buildOutlierReport`. Pure in/out (fixture-tested).
- `src/tools/performance-tools.ts` — `compare_performance_transactions`, `assess_comparison_confounds`, `detect_performance_outliers`, `performance_transaction_control`. The list endpoint already carries `speedIndex`/`cpuAvg`/`memAvg`, so filter-based selection fetches `listTransactions()` ONCE and filters in memory (no N+1 `getTransaction`).

**`gatherPool()` — cross-scope ID resolution (confirmed live).** `listTransactions()` is PROJECT-SCOPED to the active JWT's reporter context: a transaction created under a different project's reporter instance is absent from the bulk list (live case — 1894 is in "DAIMCP POC", invisible to a Default-scoped JWT; 1895 is in "Default"). `getTransaction(id)` is a direct GET that works across scopes. So `gatherPool` resolves explicit `transactionIds` via `getTransaction` (cross-scope, and bounded by the IDs given — no full-list fetch when both sides are explicit) and only fetches the bulk list when a side uses a FILTER. Mixed selectors merge both, deduped by id.

**JWT gate:** the three analytical tools call `requireJwt()` (checks `getActiveKeyType() !== 'jwt'`) and return the `Cloud Admin JWT required … switch_environment("default")` message with `isError: true` BEFORE any API call — asserted in `tests/tools.test.ts`. `performance_transaction_control` is NOT gated (it drives an inspection session, which works on project keys) but reading the resulting transactions back IS JWT-only.

**Speed Index is composite, not duration (`SI`, not `ms`).** Speed Index is the area above the visual-progress curve (WebPageTest methodology: integral of `(1 − VisualCompletion(t))` over the render window) — a lower value means content was visible more completely earlier, NOT that the screen rendered N ms sooner. `METRIC_UNITS.speedIndex` is `'SI'` and every renderer (compare, summary, trend, `formatTransactionList`, `formatTransaction`) labels it `SI` with a composite-metric annotation. Misreading a `−160ms` delta as "renders 160ms faster" was the v42 failure. Reserve `ms`/wall-clock language for the `duration` metric. The compare tool emits `metricSemantics.speedIndex.{isCompositeMetric, unit, meaning}` in structured output.

**Speed Index is forced first in `compare_performance_transactions`.** `normalizeMetrics` (in `performance-tools.ts`) ensures `speedIndex` is always present and at `metrics[0]` regardless of what the caller passes — so it always anchors outlier exclusion and delta ranking. If the caller omitted it or listed it later, a note is prepended to the result. This is the v42 fix for an agent passing `["duration", cpuAvg, memAvg]` and silently dropping the primary signal — chosen over a schema reject because it can't be gotten wrong.

**Canonical workflow (the `performance_comparison_report` prompt is the authoritative sequence):** `find_available_device` → `get_test_boilerplate(includePerformanceTransactions, region)` → `list_nv_servers(region)` (confirm ONLINE+tunneled — Speed Index is invalid without it) → run tests → `list_transactions` → `detect_performance_outliers` → `assess_comparison_confounds` → `compare_performance_transactions(metrics=["speedIndex",…])`. `compare_performance_transactions`'s description encodes the NV/outlier/confound steps as prerequisites and points back to the prompt; no separate workflow resource — the prompt is it.

**Headline metric is always three numbers** — trimmed mean, median, and raw mean (user requirement) — so small/noisy N can't hide behind one figure. Delta uses trimmedMean (→ median → mean fallback) of B − A.

**Outlier model:** median/MAD modified z-score (`(x − median) / (1.4826·madRaw)`, default k=3.5, Iglewicz–Hoaglin). MAD over stddev because at N=5–10 one bad run inflates a stddev bound enough to mask itself. `degenerate: true` when madRaw=0 (>50% identical) — scoring is skipped, nothing flagged. `buildComparison` excludes outliers on the PRIMARY metric (`metrics[0]`) and drops those whole transactions from every metric summary, only when a side has ≥4 samples.

**Confound model (`buildConfoundAssessment`):** caller declares the `comparisonAxis` (what SHOULD differ). Every other inspectable dimension (appVersion, deviceModel, deviceOs, deviceVersion, networkProfile, deviceName, projectName, name, testId) is checked for cross-side splits (→ confound, severity by perf-impact) and within-side heterogeneity (→ noise). Plus all-zero CPU+memory = "no telemetry" flag (the live 1894 case), and ≥2× sample imbalance. Verdict: `confounded` (any high), `caveated` (any med/low), else `clean`. `region` is NOT on the transaction record — it returns an `info` flag saying it can't be verified here.

**Phase-2 generation (`performanceTransaction` in `webdriver.ts`):** `seetest:client.startPerformanceTransaction`/`endPerformanceTransaction` via the existing `execScript` (Grid `/execute`, OSS `/execute/sync`). These are cloud-proxy commands, not Appium, so they work on both modes. The Grid execute parser can't express a 0-arg seetest command, so `start` REQUIRES a `networkProfile`. `start` activates NV throttling immediately (ANR risk — keep the window tight); the record lands in the reporter ~1 min AFTER `end`, not instantly.

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

`seetest:client` commands use **dot-notation**: the method name is part of the script string, arguments are passed as **separate parameters** to `execute_script` — NOT embedded inside the script string.

```python
# Correct — arg is a separate parameter
self.driver.execute_script("seetest:client.startPerformanceTransaction", "Monitor")

# Wrong — inline in string; silently fails or produces no data
self.driver.execute_script('seetest:client.startPerformanceTransaction("Monitor")')
```

### The only working API: `startPerformanceTransaction` / `endPerformanceTransaction`

```java
// Java — correct
driver.executeScript("seetest:client.startPerformanceTransaction", "Monitor");
// ... steps to measure ...
driver.executeScript("seetest:client.endPerformanceTransaction", "Login Performance");

// Java — WRONG (rejected on both Grid and OSS)
driver.executeScript("seetest:client", new Object[]{"startPerformanceTransaction", "Monitor"});
```

```python
self.driver.execute_script("seetest:client.startPerformanceTransaction", "Monitor")
# ... steps to measure ...
self.driver.execute_script("seetest:client.endPerformanceTransaction", "Login Performance")
```

```js
await browser.execute('seetest:client.startPerformanceTransaction', 'Monitor');
// ... steps to measure ...
await browser.execute('seetest:client.endPerformanceTransaction', 'Login Performance');
```

**Argument semantics are asymmetric:**
- `startPerformanceTransaction` arg = **NV network profile name** (`"Monitor"` = observe without throttling; other profiles apply latency/bandwidth constraints)
- `endPerformanceTransaction` arg = **transaction name** — this is the name that appears in the reporter and is queryable via `list_transactions`

**Methods that silently do nothing (`startTransaction` / `endTransaction`):** These method names are accepted without error, the test passes, but **zero transaction records appear in the reporter**. They are not the performance transaction API. Do not use them.

**`stopTransaction` does not exist.** Fails with `Could not find a method 'stopTransaction' matching with N parameters` at every parameter count (0, 1, 2) — a Java reflection error. The correct stop method is `endPerformanceTransaction`.

**NV throttling warning:** `startPerformanceTransaction` activates network throttling immediately. If the app has background network calls during initialization (analytics, config fetches), start the transaction AFTER the UI is stable — or the app may ANR/crash.

**NV server pre-requisite:** An NV server must be ONLINE and tunnel-connected in the device's region for transactions to record. Verify with `list_nv_servers(region=<target region>)` before running instrumented tests.

**Reporter delay:** Transaction data appears approximately 1 minute after `endPerformanceTransaction`. `list_transactions` returns 0 results if queried immediately after the test run.

**NV profile names:** Must be configured on the NV server by your platform admin. `"Monitor"` (pass-through), `"wifi"`, and `"3G-average"` are common but not guaranteed to exist on all deployments.

## Boilerplate Generation — Device Routing

### Inspection gate (v42 — structural, not advisory)

When `get_test_boilerplate` targets a **real app** (`appId`, `packageName`, or `bundleIdentifier` set → `targetsCustomApp`), it returns **NO code** and a `{ status: 'blocked', reason: 'no_verified_selectors' }` response (`isError: true`) UNLESS one of:
- a **live inspection session exists** in this MCP process (`listActiveSessions().length > 0`), or
- the caller sets **`confirmSelectorsVerified: true`** (explicit escape hatch for selectors captured via rdb/UIAutomator, `open_mobile_studio`, `get_automation_properties`, or authoritative workspace source).

The built-in ExperiBank demo (no app identifiers) is **never gated** — it ships real working steps.

**Why structural, not another warning.** The v42 finding (written by the agent that committed the failure) is that advisory guards — warning text, the `requiresVerifiedSelectors` flag, the in-code `Assertions.fail()` guard — all lose to task-completion momentum: the agent stripped the `fail()` and shipped the placeholder as a finished test. Returning no code removes the object the agent dresses up. The gate runs at the TOP of the handler **before any network call** (`getMyAccountInfo`, the `appId` lookup), so it is asserted in `tests/tools.test.ts` against an unreachable host. The soft guards (`requiresVerifiedSelectors`, `placeholderWarning`, in-code fail-guard) are retained as defense-in-depth on the paths that DO pass the gate.

### v43 — the bypass, and the limits of MCP enforcement

The v42 gate controls only what `get_test_boilerplate` *emits*. v43 was a failure where the agent **never called the tool** — it called `list_applications`/`get_application_info`, then hand-wrote a `.java` file with fabricated resource IDs. **No MCP-server change can prevent freeform file authoring** — the server is not in the loop for the agent's Write tool. The reliable fix is harness-level (a skill / system prompt / CLAUDE.md in the *consuming* project). The MCP's levers, all advisory and layered as backstops:

- **Server `instructions`** (`src/index.ts`, `SERVER_INSTRUCTIONS`) — delivered at connect time, before the agent forms a plan (higher weight than tool descriptions, which are read at call time *after* a plan is committed — v43 root-cause 2a). Leads with the mode-first / no-guessed-selectors policy. Verified emitted via the `initialize` handshake.
- **`_testCreationGuidance`** (Fix C) — a structured field on `list_applications` and `get_application_info` responses (`testCreationGuidance()` in `application-tools.ts`). Structured data is treated as fact to act on; prose in a description is treated as context. Reports `liveInspectionSession` (the one selector source the MCP can verify).
- **`validate_test_script`** (Fix D) — a delivery backstop. `detectFabricationIssues()` (pure, in `boilerplate-tools.ts`, unit-tested) scans for unreplaced `<…>` placeholders, the scaffold fail-guard, placeholder credentials, and known fabricated IDs; high-severity hits return `isError`. Catches a hand-written script IF the agent calls it — which the server `instructions` direct it to do before delivering any test.

None of these is bulletproof against a bypassing agent; they raise compliance, and the harness-level governance is what actually binds.

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

## Node.js Version & Vitest

**Current local Node.js: 22 LTS** — all engine requirements satisfied.

`vitest` is on `^4.x` (4.1.8+). It was upgraded from 3.x to clear the dev-only `esbuild` advisories (`GHSA-gv7w-rqvm-qjhr` Deno-module RCE, `GHSA-g7r4-m6w7-qqqr` Windows dev-server file read) that the 3.x → vite → esbuild tree pulled in; neither code path (esbuild dev server, esbuild Deno module) is used by `vitest run`, but the upgrade removes the audit findings outright. `npm audit` reports **0 vulnerabilities** (both full and `--omit=dev`). Node 22 supports vitest 4.x fully; all 141 tests pass on it.

If a future `npm audit` flags the test toolchain again, prefer the in-range fix first: `npm audit fix` (no `--force`). The production runtime ships none of these (multi-stage Docker copies only `dist/` + prod deps), so `npm audit --omit=dev` is the number that matters for the shipped image.

## Inspection Sessions (WebDriver-based Native Inspection)

`src/api/webdriver.ts` implements a **separate Axios instance** that connects to the Grid at
`{DIGITAL_AI_BASE_URL}/wd/hub`. It does **not** reuse the main `client.ts` instance (which sends
`X-API-KEY` headers — the Grid uses `digitalai:accessKey` inside the session capability instead).

The session create request is **dual-protocol**: it sends both `desiredCapabilities` (JWP, read by
the proprietary Appium Grid) and `capabilities.alwaysMatch` (W3C, read by standard Appium Server —
non-standard caps get the `appium:` prefix there). Works for both `isAppiumOss` project modes.
The detected response format is stored as `session.sessionFormat: 'jwp' | 'w3c'` and drives which
gesture/launch mechanism each command tries first.

### In-process session registry

```ts
const sessionRegistry = new Map<string, InspectionSession>(); // keyed by handle (8-char UUID slice)
const allReports = new Map<number, string | undefined>();      // reportTestId → projectName it was created under
```

Both are cleared on MCP server restart. Orphaned Grid sessions timeout on their own (default 4 min).

**Report IDs must be project-scoped.** Reporter `test_id`s are only unique per reporter instance —
a session created under a non-default profile (e.g. a project key) gets a `test_id` from that
project's instance. Deleting it later without `projectName` resolves the same numeric ID in the
default scope and deletes the WRONG report. `createInspectionSession` captures the active project
via `getMyAccountInfo()` and every delete (`quitInspectionSession`, `deleteAllTrackedReports`)
passes it to `deleteTests(ids, undefined, projectName)`.

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

`cleanup_inspection_sessions` iterates `allReports` for orphaned reports from sessions that
were abandoned without calling `stop_inspection_session`, deleting them grouped by the project
they were created under.

### Gestures & app/device control — protocol matrix (confirmed live, v34/v35)

The Digital.ai Grid (proprietary JWP proxy) and standard Appium Server support **disjoint**
command sets. Every gesture/launch/control helper in `webdriver.ts` tries the session's native
mechanism first and falls back through the others, reporting all failures together:

| Operation | Appium Grid (JWP, `isAppiumOss=false`) | Appium Server (W3C/OSS) |
|---|---|---|
| Swipe / drag | `POST /touch/perform` (press/wait/moveTo/release; moveTo is ABSOLUTE; `longPress` action works) | `POST /actions` (W3C pointer actions) |
| Double-tap | `touch/perform` `tap` action with `count: 2` | `/actions` two down/up pairs, 100 ms pause |
| Pinch/zoom | ❌ `touch/multi/perform` → **501** ("multiTouchActions not supported") | `/actions` two-finger, or `mobile: pinchOpen/CloseGesture` |
| App launch | `seetest:client.launch` via `POST /execute` — args `[activityUrl, instrument, stopIfRunning]`, **exactly 3 args** | `mobile: startActivity` via `POST /execute/sync` — args `[{intent, wait}]` |
| App terminate / clear data | `seetest:client.applicationClose` / `applicationClearData` — 1 arg (package) | `mobile: terminateApp` / `mobile: clearApp` — `[{appId}]` |
| App state | foreground only via `GET /appium/device/current_activity` | `mobile: queryAppState` → 0–4 |
| Deep link | best-effort: `seetest:client.launch(url, false, true)` — depends on device's URL handler state | `mobile: deepLink` — `[{url, package?}]` |
| Key press | `POST /appium/device/press_keycode` — `{keycode}` (also `seetest:client.deviceAction("Home")` / `sendText("{HOME}")`) | `mobile: pressKey` — `[{keycode}]` |
| Keyboard | `POST /appium/device/hide_keyboard`, `GET .../is_keyboard_shown` | `mobile: hideKeyboard` / `mobile: isKeyboardShown` |
| Orientation | `GET`/`POST /orientation` (both) | same |
| Clipboard | `POST /appium/device/get_clipboard` / `set_clipboard` (base64; also `seetest:client.setClipboardText`) | `mobile: getClipboard` / `setClipboard` |
| Geolocation set | `seetest:client.setLocation(lat, lng)` — **string args**; legacy `POST /location` also works | `mobile: setGeolocation` (legacy `POST /location` **500s** on OSS) |
| Geolocation reset | ❌ `clearLocation` is 0-arg and the Grid execute parser can't express 0-arg commands | `mobile: resetGeolocation` |
| Alerts | ❌ all alert routes → **501** (dialogs are normal UI elements — tap them) | `POST /alert/accept` / `/alert/dismiss` (404 "no such alert" when none open) |
| Files | `POST /appium/device/push_file` / `pull_file` — `{path, data}` | `mobile: pushFile` / `pullFile` — `[{remotePath, payload}]` |
| Back | `POST /back` (works on both) | `POST /back` |
| Window size | `GET /window/current/size` | `GET /window/rect` |

**Grid execute layer accepts ONLY `seetest:client.*` commands.** `mobile:` anything fails with
"missing 'client.' prefix"; the legacy `/appium/device/start_activity` route NPEs (500) and
`/appium/device/activate_app` 404s — yet other legacy `/appium/device/*` routes (press_keycode,
hide_keyboard, clipboard, files) DO work on the Grid. The Grid returns a mix of **500 and 501**
(not just 404) for unsupported things, so fallbacks cannot rely on status codes alone; error
messages from the body matter (`describeWdError` extracts them). The Grid execute parser cannot
express 0-arg seetest commands ("invalid parameters delimiter") — `clearLocation` is unreachable.
There is no activate-by-package command on the Grid — `launch_app` effectively requires the
activity there (from `get_application_info.mainActivity`).

`mobile:` gesture commands (`swipeGesture` etc.) arrived in the Appium 1.22 era — not available on
Appium 1.8 agents, which is why swipe uses raw W3C actions / JWP touch instead.

`stop_inspection_session` accepts `keepReport: true` — preserves the session's reporter record so
the platform-recorded video stays retrievable via `download_test_attachments` (kept reports are
removed from the orphan registry so `cleanup_inspection_sessions` won't delete them).

### iOS sessions (confirmed live on iPhone 13 Pro Max, Grid AND Appium Server)

`start_inspection_session(platform: "ios")`. The `InspectionSession.platform` field drives every
platform branch. Key differences from Android:

| Concern | iOS behavior |
|---|---|
| Element attributes | `name` / `label` / `value` / `type` — XCUITest **rejects** Android names (`class`, `text`, `bounds` → 500); the Grid exposes `class` instead of `type` (fetch both, take non-null) |
| Element geometry | `bounds` attr is EMPTY on Grid iOS — use `GET /element/{id}/rect` (W3C) or `/location` + `/size` (JWP); `elementRect()` handles both |
| Coordinate space | Grid = physical pixels (1284×2778); XCUITest = logical points (428×926). Always compute gestures from the session's own window size |
| App launch | bundle ID only, no activity: `seetest:client.launch(bundleId, false, true)` (Grid) / `mobile: launchApp {bundleId}` (OSS) |
| Back navigation | No Back button. `press_back` taps `//XCUIElementTypeNavigationBar/XCUIElementTypeButton[1]` (via the cheap single-element route), falling back to a left-edge swipe — synthetic edge swipes do NOT trigger the system back gesture on the Grid (confirmed live) |
| Keys | `mobile: pressButton {home/volumeup/volumedown}` (OSS) / `seetest:client.deviceAction("Home")` (Grid). No keycodes; ENTER = type `"\n"` |
| Clipboard | works on OSS; Grid iOS devices reject it ("not supported on this device") |
| clear_data | impossible on iOS (XCUITest limitation) — uninstall/reinstall instead |
| Geolocation | `mobile: setSimulatedLocation` / `resetSimulatedLocation` on OSS (NOT setGeolocation — that's UiAutomator2); `seetest:client.setLocation` on Grid |
| Alerts | proper support on OSS (`/alert/accept`); 501 on Grid (same as Android) |
| app_control query_state | works on OSS (`mobile: queryAppState {bundleId}`); unavailable on Grid iOS (no current_activity equivalent) |

**Dead-session detection:** a 404 on an established session means the Grid/agent terminated it
(idle timeout or WDA crash — observed live when WDA was hammered during a navigation transition).
`sessionAwareError` appends recovery guidance; `findFirstElementId` exists so internal helpers
don't pay findElements' ~9-requests-per-element enrichment cost.

Both Appium Grid and Appium Server (OSS) projects work for BOTH platforms — verified live on the
Default (Grid) and DAIMCP POC (Appium Server) projects with Android and iPhone devices.

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
