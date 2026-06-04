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

**Sort** by any field works, including `start_time` — the block is filter-only.

For date-range filtering, use `startDate`/`endDate` parameters on `list_test_reports` — these fetch pages sorted descending and apply the date comparison client-side.

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

Sort properties (all work, including date fields):

- `start_time` — ascending or descending

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

## Node.js Version & Vitest Pin

**Current local Node.js: 20.11.1** — too old for some dependencies in the tree.
Engine warnings from `eslint-visitor-keys@5` and `rolldown` (vitest 4.x's bundler) both require Node ≥ 20.12.0.

**Do NOT run `npm audit fix --force`** — it upgrades vitest to 4.x, which breaks the VS Code Vitest Explorer on Node 20.11.1 with `SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'`.

`vitest` is pinned to `^3.x` deliberately. The outstanding `npm audit` critical (`GHSA-5xrq-8626-4rwp`) is a Vitest UI server vulnerability. This project never runs the UI server (`vitest run` only), so there is no attack surface. `npm audit --omit=dev` reports zero vulnerabilities.

**To fully resolve:** upgrade local Node.js to 22 LTS, then `npm install vitest@^4 --save-dev`.

## Adding a New Tool

1. Add the API function to `src/api/<domain>.ts`
2. Add any new types to `src/types/digital-ai.ts`
3. Add a formatter to `src/utils/response-formatter.ts` if the output needs human-readable formatting
4. Register the tool in `src/tools/<domain>-tools.ts`
5. Run `npm run build` — fix all TypeScript errors before committing
6. Add an integration test in `tests/<domain>.test.ts`
7. Add the new script to `package.json` if it's a new test file
8. Add the tool to the README.md tool reference table
