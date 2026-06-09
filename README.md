<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/images/dai-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/images/dai-logo-light.svg">
  <img alt="Digital.ai Continuous Testing MCP Server" src=".github/images/dai-logo-light.svg" width="600">
</picture>

# Digital.ai Continuous Testing — MCP Server

An MCP (Model Context Protocol) server that connects AI assistants like Claude to a Digital.ai Continuous Testing device farm. The server exposes **140 tools**, **2 resources**, and **4 prompts** covering 22 capability areas: device management, test execution, app lifecycle, reporting, analytics, performance, project administration, and more.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Access Keys](#access-keys)
- [Installation](#installation)
- [Configuration](#configuration)
- [Connecting AI Clients](#connecting-ai-clients)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code (VS Code)](#claude-code-vs-code)
  - [Claude Code (JetBrains / Android Studio)](#claude-code-jetbrains--android-studio)
  - [GitHub Copilot (VS Code)](#github-copilot-vs-code)
  - [Cursor](#cursor)
- [Tool Reference](#tool-reference)
  - [Users](#users)
  - [Devices](#devices)
  - [Device Groups](#device-groups)
  - [Reservations](#reservations)
  - [Applications](#applications)
  - [Repository](#repository)
  - [Browsers](#browsers)
  - [Projects](#projects)
  - [Provisioning Profiles](#provisioning-profiles)
  - [Backup](#backup)
  - [Health & Diagnostics](#health--diagnostics)
  - [Coverage Analytics](#coverage-analytics)
  - [Reporting](#reporting)
  - [Test Views](#test-views)
  - [Transactions & Performance](#transactions--performance)
  - [Agents](#agents)
  - [Regions](#regions)
  - [NV Servers](#nv-servers)
  - [Environment Management](#environment-management)
  - [Workflows](#workflows)
  - [Boilerplate Generation](#boilerplate-generation)
  - [Resources & Prompts](#resources--prompts)
- [Workflow Reference](#workflow-reference)
  - [POC Lifecycle](#poc-lifecycle)
  - [Project Lifecycle](#project-lifecycle)
- [Reference](#reference)
  - [Response Format](#response-format)
  - [Understanding maxResults](#understanding-maxresults)
  - [List Filters & Sorting](#list-filters--sorting)
  - [Test Reporting Schema](#test-reporting-schema)
- [Diagnostics](#diagnostics)
- [Safety Guards](#safety-guards)
- [Development](#development)
- [Known Limitations](#known-limitations)

---

## Prerequisites

- **Docker** — required to run the server
- **Node.js 22+** — required only if building from source (see Installation, Option B)
- **GitHub org membership** — required to pull the pre-built image from GHCR (see Installation, Option A)
- **Digital.ai Continuous Testing account** with a valid access key

---

## Access Keys

Your Digital.ai access key determines what the MCP server can do on your behalf. There are two types.

| Key type | Format | Access |
|---|---|---|
| **Cloud Admin JWT** | `eyJ…` (long base-64 string) | All 140 tools: device management, user provisioning, project administration, infrastructure, performance data |
| **Project API key** | `aut_1_…` | Scoped to the devices, apps, and reports within one specific project. v2 API tools (agents, regions, license data) return 403. |

When a Cloud Admin tool is called with a project key, the MCP returns a plain-language error explaining what happened — and, if a Cloud Admin profile is configured, a ready-to-use `switch_environment(...)` command.

### Finding your key

1. Log in to the Digital.ai Continuous Testing portal
2. Click your **name or avatar** in the top-right corner
3. Select **Access Key**

The key shown is tied to the **project currently selected in the portal**. If you belong to multiple projects, each has a separate key.

### Using multiple keys

Configure named profiles in `.env` to switch contexts at runtime without editing files:

```
# Default connection (typically a Cloud Admin JWT)
DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com
DIGITAL_AI_ACCESS_KEY=eyJ...your-cloud-admin-jwt...

# Project-scoped profiles
DAI_PROFILE_QA_URL=https://your-tenant.experitest.com
DAI_PROFILE_QA_KEY=aut_1_...your-qa-key...

DAI_PROFILE_STAGING_URL=https://your-tenant.experitest.com
DAI_PROFILE_STAGING_KEY=aut_1_...your-staging-key...
```

Then ask Claude:
- *"What environments are configured?"* → `list_environments`
- *"Switch to QA"* → `switch_environment("qa")`
- *"Switch back to Cloud Admin"* → `switch_environment("default")`

The switch takes effect immediately — no restart needed.

> **Security:** Never commit `.env` to source control. Each team member should use their own key obtained from the portal under their own account.

---

## Installation

### Option A — Pull from GitHub Container Registry (Recommended)

No cloning or building required. Use this for standard deployment.

**Step 1 — Authenticate with GHCR (one-time per machine)**

Generate a GitHub **classic** Personal Access Token with `read:packages` scope at https://github.com/settings/tokens/new, then:

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

**Step 2 — Pull the image**

```bash
docker pull ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest
```

**Step 3 — Set up your `.env`**

```bash
curl -O https://raw.githubusercontent.com/dai-continuous-testing/digital-ai-testing-mcp/main/.env.example
cp .env.example .env
# Edit .env — set DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY
```

Use `ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest` as the image name in your AI client configuration below.

> Images are published when a GitHub Release is created — not on every commit. If `latest` is not available yet, use [Option B](#option-b--build-from-source) to build from source.

> To update: `docker pull ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest`

---

### Option B — Build from source

Required only for local development or modifying the server.

```bash
git clone https://github.com/dai-continuous-testing/digital-ai-testing-mcp
cd digital-ai-testing-mcp
cp .env.example .env
# Edit .env — set DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY
docker build -t digital-ai-testing-mcp:latest .
```

Use `digital-ai-testing-mcp:latest` as the image name in your AI client configuration below.

> Rebuild after making changes: `docker build -t digital-ai-testing-mcp:latest .`

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DIGITAL_AI_BASE_URL` | ✅ | — | Your Digital.ai tenant URL |
| `DIGITAL_AI_ACCESS_KEY` | ✅ | — | Access key (JWT or project API key — see [Access Keys](#access-keys)) |
| `MCP_SERVER_NAME` | Optional | `digital-ai-testing-mcp` | Server identity shown in the AI client |
| `MCP_SERVER_VERSION` | Optional | `1.0.0` | Server version |
| `REQUEST_TIMEOUT_MS` | Optional | `30000` | API request timeout in milliseconds |
| `UPLOAD_TIMEOUT_MS` | Optional | `120000` | File upload timeout in milliseconds |

Additional `DAI_PROFILE_{NAME}_URL` / `DAI_PROFILE_{NAME}_KEY` pairs configure named profiles for multi-project or multi-environment use. See [Access Keys](#access-keys) and `.env.example` for examples.

---

## Connecting AI Clients

All clients launch the server as a Docker container. The examples below use the GHCR image name (Option A). If you built from source (Option B), replace the image name with `digital-ai-testing-mcp:latest`. Replace `/ABSOLUTE/PATH/TO/.env` with the full path to your `.env` file in all cases.

### Claude Desktop

Find your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** Open Claude Desktop → Settings → Developer → **Edit Config** (the path varies by install method — Windows Store vs. direct installer)

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/ABSOLUTE/PATH/TO/.env",
        "ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest"
      ]
    }
  }
}
```

> **Built from source?** Replace `ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest` with `digital-ai-testing-mcp:latest`.

Restart Claude Desktop after editing — the tools appear automatically.

### Claude Code (VS Code)

1. Open the Claude Code extension panel
2. Go to **Settings → MCP Servers**
3. Add a new server with the Docker command above

### Claude Code (JetBrains / Android Studio)

Install the [Claude Code](https://plugins.jetbrains.com/plugin/22828-claude-code) plugin from the JetBrains Marketplace, then open your project and run this command from the project root:

```bash
claude mcp add digital-ai-testing -- docker run --rm -i --env-file /ABSOLUTE/PATH/TO/.env ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest
```

This stores the server configuration in `~/.claude.json` scoped to the current project. Alternatively, use the Claude Code panel: **Settings → MCP Servers** and add the same Docker command used for Claude Desktop.

> **Built from source?** Replace the GHCR image name with `digital-ai-testing-mcp:latest`.

Restart the Claude Code panel after adding the server — the tools appear automatically.

### GitHub Copilot (VS Code)

GitHub Copilot supports MCP tools in **Agent mode** only. Register the server in one of two scopes:

**User settings** — available in all workspaces. Open `settings.json` (`Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)"):

```json
{
  "mcp": {
    "servers": {
      "digital-ai-testing": {
        "command": "docker",
        "args": [
          "run", "--rm", "-i",
          "--env-file", "/ABSOLUTE/PATH/TO/.env",
          "ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest"
        ]
      }
    }
  }
}
```

**Workspace settings** — scoped to one project. Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/ABSOLUTE/PATH/TO/.env",
        "ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest"
      ]
    }
  }
}
```

Committing `.vscode/mcp.json` to source control shares the server configuration with the entire team automatically.

To use the tools: open Copilot Chat (`Ctrl+Alt+I`), switch the mode dropdown to **Agent**, and type your request.

> GitHub Copilot on the web (`github.com/copilot`) does not support external MCP servers. VS Code is required.

### Cursor

Cursor supports MCP in **Agent mode**. Add the server in **Cursor Settings → MCP** (or `Cursor Settings → Features → MCP`) using the same Docker command:

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/ABSOLUTE/PATH/TO/.env",
        "ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest"
      ]
    }
  }
}
```

Alternatively, create a `.cursor/mcp.json` file in your project root with the same `mcpServers` object — this scopes the server to that workspace and can be committed to share it with your team.

> **Built from source?** Replace the GHCR image name with `digital-ai-testing-mcp:latest`.

> Cursor is available on macOS, Windows, and Linux. It is the recommended option for iOS developers on macOS where Xcode is the primary IDE but does not natively support MCP.

---

## Tool Reference

### Users

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_users` | List all user accounts | firstName, lastName, email, authenticationType, isCloudAdmin, tag; sortBy/sortOrder | Cloud Admin |
| `create_user` | Create a new user account | — | Cloud Admin |
| `delete_user` | Permanently delete a user account | — | Cloud Admin |
| `get_my_account_info` | Show the account tied to the active API key | — | Any |
| `assign_user_to_projects` | Grant user access to one or more projects | — | Cloud Admin |
| `unassign_user_from_projects` | Remove user from one or more projects | — | Cloud Admin |
| `get_user_tags` | List tags on a user | — | Cloud Admin |
| `set_user_tags` | Replace all tags on a user (max 10) | — | Cloud Admin |

### Devices

Device tools accept a **flexible device identifier**: numeric device ID, serial number, UDID, or device name — the server resolves it to the backend ID automatically.

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_devices` | List devices with status, OS, model, and agent | `query` (@-syntax), `region`, `model`; sortBy/sortOrder | Any |
| `get_device_detail` | Full device profile including groups and status history | — | Cloud Admin |
| `edit_device` | Update device name, notes, or category | — | Cloud Admin |
| `find_available_device` | Find the first available device matching OS, tags, or version | — | Any |
| `release_device` | Release a reserved or stuck device | — | Any |
| `release_orphaned_sessions` | Find and release devices stuck in "In Use" beyond a configurable time threshold | — | Any |
| `reboot_device` | Remote reboot | — | Cloud Admin |
| `reset_device_usb` | Reset USB connection | — | Cloud Admin |
| `start_device_web_control` | Open a browser-based control session | — | Cloud Admin |
| `open_mobile_studio` | Open Mobile Studio for a device | — | Any |
| `create_mobile_manual_test` | Create a structured manual test session | — | Any |
| `download_ios_app_container` | Download an iOS app data container | — | Cloud Admin |
| `get_device_health_summary` | Device farm health overview | — | Any |
| `get_device_tags` | List all tags on a device | — | Any |
| `add_device_tag` | Add a tag to a device | — | Cloud/Project Admin |
| `remove_device_tag` | Remove a specific tag | — | Cloud/Project Admin |
| `remove_all_device_tags` | Remove all tags | — | Cloud/Project Admin |
| `get_device_ca_certificates` | List CA certificates on an Android device | — | Cloud Admin |

**Device query syntax** (`list_devices` `query` parameter — server-side filtering):

```
@os='android'            @os='iOS'          (case-insensitive)
@version='14.0'          @version>'13.0'    (decimal required; supports =, >, <, !=)
@category='PHONE'        @category='TABLET' (uppercase required)
@region='US2'            @region='SG1'
@name='My Device'                           (exact display name)
@model='iPhone 12'       @modelName='Xiaomi Redmi Note 9 5G'
@serialNumber='4hlfov...'
@emulator='false'
```

Combine with `and`: `@os='android' and @category='PHONE' and @version>'13.0' and @region='US2'`

> **Fields that silently return empty results — do not use in queries:** `@manufacturer`, `@tag`, `@deviceName`, `@id`, `@udid`, `@status`, `@agentName`, `@location`, `@project`, `@group`. The API accepts these without error but returns nothing. Use the `manufacturer`, `tags`, `model`, and `region` parameters on `list_devices` and `find_available_device` instead — those filter client-side and reliably work.

### Device Groups

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_device_groups` | List all device groups | Cloud Admin |
| `get_devices_in_group` | List devices in a group | Cloud Admin |
| `get_projects_in_group` | List projects with access to a group | Cloud Admin |
| `create_device_group` | Create a new device group | Cloud Admin |
| `edit_device_group` | Rename or toggle auto-accept | Cloud Admin |
| `delete_device_group` | Delete a group (devices are not deleted) | Cloud Admin |
| `add_devices_to_group` | Add devices to a group | Cloud Admin |
| `remove_devices_from_group` | Remove devices from a group | Cloud Admin |
| `assign_group_to_project` | Grant a project access to a group | Cloud Admin |

### Reservations

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_reservations` | List current and upcoming reservations | username, project, deviceUid; sortBy/sortOrder | Any |
| `create_reservation` | Reserve one or more devices | — | Cloud/Project Admin |
| `reserve_device_for_duration` | Reserve a device for N hours starting now (e.g. `0.5` = 30 min, `1.0` = 1 hour) | — | Cloud/Project Admin |
| `delete_reservation` | Cancel a reservation | — | Cloud/Project/User |
| `check_device_availability_window` | Check a device's reservation schedule over a time window | — | Cloud Admin |

### Applications

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_applications` | List all apps in the repository | nameContains, osType, packageName, bundleIdentifier, fileType, isForSimulator; sortBy/sortOrder | Any |
| `get_application_info` | Full app detail | — | Any |
| `find_latest_application` | Find the newest uploaded version by name, bundle ID, or package name. Returns `appCapabilityString` (e.g. `cloud:MyApp`) ready for the Appium `app` capability. | — | Any |
| `upload_application_file` | Upload APK/IPA/AAB from a local file path | — | Cloud Admin |
| `upload_application_from_url` | Upload from a direct-download URL | — | Cloud Admin |
| `delete_application` | Delete an app from the repository | — | Cloud Admin |
| `update_application_plugins` | Update iOS plugin signing profiles | — | Cloud Admin |
| `install_application` | Install an app on one or more devices | — | Any |
| `uninstall_application` | Uninstall from one or more devices | — | Any |
| `uninstall_application_by_package` | Uninstall by package name on a single device | — | Any |
| `uninstall_application_by_package_from_devices` | Uninstall by package name across multiple devices | — | Any |
| `extract_app_language_files` | Download localization files from an app | — | Any |
| `bulk_install_to_group` | Install on every device in a device group | — | Any |

> **Upload from URL:** Must be a direct-download link accessible from the Digital.ai server's network. Redirect URLs, auth-gated URLs, and unsupported file types return a 400 with a diagnostic message.

> **File uploads from Docker:** The MCP server runs inside a container. Mount the directory containing your build artifacts as a volume (e.g. `-v /host/apps:/apps`) and reference the container path (e.g. `/apps/myapp.apk`). Alternatively, use `upload_application_from_url` for artifacts already on a network-accessible URL.

### Repository

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_repository_files` | List files in the repository | Any |
| `get_repository_file_info` | Get file details by ID | Any |
| `upload_repository_file` | Upload a file | Any |
| `download_repository_file` | Download a file by ID | Any |
| `update_repository_file` | Replace file content in-place | Any |
| `delete_repository_file` | Delete a file | Any |

### Browsers

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_available_browsers` | List available browser/OS combinations | Any |
| `start_selenium_session` | Open a Selenium browser session | Any |
| `start_manual_test_session` | Create a structured browser test | Any |

### Projects

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_projects` | List all projects | name filter; sortBy/sortOrder | Any |
| `create_project` | Create a project | — | Cloud Admin |
| `delete_project` | Delete a project | — | Cloud Admin |
| `list_project_users` | List users in a project | username, role; sortBy/sortOrder | Cloud/Project Admin |
| `assign_user_to_project` | Add a user to a project with a role | — | Cloud Admin |
| `remove_user_from_project` | Remove a user from a project | — | Cloud Admin |
| `get_project_tokens` | Get token configuration | — | Cloud/Project Admin |
| `set_project_tokens` | Update token mode | — | Cloud Admin |
| `get_project_settings` | Basic project settings | — | Cloud/Project Admin |
| `get_project_admin_settings` | Full project configuration via v2 API — 35+ fields in one call: per-type license limits, cleanup flags, reservation policies, feature flags, user/app counts | — | Cloud Admin (JWT) |
| `update_project_settings` | Update cleanup, concurrency, and limit settings | — | Cloud Admin |
| `set_telephony_status` | Enable/disable calls and SMS | — | Cloud Admin |
| `get_project_notes` | Get project notes | — | Any |
| `set_project_notes` | Set project notes | — | Cloud/Project Admin |
| `get_project_devices` | List devices accessible to a project | — | Cloud/Project Admin |
| `get_automation_properties` | Get Appium/automation properties | — | Any |
| `assign_app_to_project` | Make an app available to a project | — | Cloud Admin |

### Provisioning Profiles

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_provisioning_profiles` | List iOS signing profiles with expiry dates | Cloud Admin |
| `get_provisioning_profile` | Get profile details | Cloud Admin |
| `upload_provisioning_profile` | Upload P12 + mobileprovision | Cloud Admin |
| `download_provisioning_profile` | Download a profile | Cloud Admin |
| `delete_provisioning_profile` | Delete a profile | Cloud Admin |

### Backup

| Tool | What it does | Admin Required? |
|---|---|---|
| `create_backup` | Trigger a live system backup | Cloud Admin |

### Health & Diagnostics

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_environment_summary` | Full environment snapshot: devices, agents, groups | Any |
| `check_ios_readiness` | iOS device and provisioning profile readiness | Any |
| `check_android_readiness` | Android device readiness. If `available: 0`, counts may be project-scoped — `find_available_device` searches a broader pool. | Any |
| `get_agent_status` | Agent connectivity overview | Any |
| `get_server_info` | Server version, active profile, URL, tool count, and capability domains | Any |
| `check_connectivity` | Verify the MCP server can reach the Digital.ai API | Any |
| `check_workflow_readiness` | Readiness report for all workflow tools — which dependency tools are present or missing. Call this first when diagnosing workflow failures. | Any |
| `list_active_sessions` | Currently active browser/Selenium sessions | Cloud Admin |
| `get_reporter_project_storage` | Per-project disk usage: current MB, quota, usage %, artifact counts. Sorted by usage descending. | Cloud Admin |
| `get_license_info` | Platform license limits for devices and browser sessions | Cloud Admin |
| `get_license_utilization` | In-use counts vs. purchased limits | Cloud Admin |

### Coverage Analytics

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_device_coverage_summary` | Compares farm inventory against test execution history — which OS versions, models, and manufacturers have been tested vs. available. Identifies gaps. | Any |
| `get_regional_test_coverage` | Infrastructure coverage by region: device counts, OS split, and availability rate per region | Any |

### Reporting

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_test_reports` | Search, filter, sort, and paginate test reports. See [Test Reporting Schema](#test-reporting-schema) for supported filters. | Any |
| `get_test_report` | Full test execution report by numeric test ID or reporter URL | Any |
| `get_test_by_report_id` | Report by `report_api_id` (returned when starting a session) | Any |
| `find_latest_test_for_name` | Most recent run record for a test by name | Any |
| `get_grouped_test_reports` | Pass/fail counts grouped by field (use `groupBy`, e.g. `["device.os"]`). Supports `pivotBy` for per-status columns. | Any |
| `get_test_stability_report` | Last N runs of a named test: pass rate, sparkline trend, and consecutive streak count | Any |
| `get_cross_platform_divergence` | Tests passing on one OS but failing on the other, with configurable minimum run count and divergence threshold | Any |
| `get_daily_execution_trend` | Execution counts and pass rates bucketed by day or week. Stops at `lookbackDays` or `maxRecords` (default 5,000; max 25,000), whichever comes first. | Any |
| `get_project_test_summary` | All-time pass/fail totals and top failing tests in a time window | Any |
| `get_failure_rate_by_app_version` | Pass/fail breakdown grouped by app version | Any |
| `get_distinct_test_key_values` | Discover all distinct values recorded for a report metadata key | Any |
| `list_active_test_executions` | Currently-running test executions (Incomplete status with null duration) | Any |
| `list_test_attachments` | Attachment metadata for a test by numeric ID | Any |
| `download_test_attachments` | Download test attachments as a ZIP file | Any |
| `delete_test_reports` | Permanently delete test records by ID list | Cloud Admin |
| `delete_test_reports_before_date` | Delete all test records started before a given date | Cloud Admin |

### Test Views

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_test_views` | List all test view groups | Any |
| `search_test_views` | Search and paginate test view groups | Any |
| `get_test_view` | Get test view configuration detail | Any |
| `get_test_view_summary` | Pass/fail/skip counts for a view | Any |
| `create_test_view` | Create a test view group | Cloud Admin |
| `update_test_view` | Rename or toggle dashboard visibility | Cloud Admin |
| `delete_test_view` | Delete a test view group | Cloud Admin |

### Transactions & Performance

Transactions are performance-instrumented segments of a test session. Developers mark start and end points in their app or test script; the platform records CPU, memory, battery, and network metrics for each interval. These tools support performance regression testing — compare metrics across app versions or identify slow operations.

> Requires a Cloud Admin JWT. Server-side filtering is not supported on the transaction API; all filters are applied client-side after fetching.

| Tool | What it does |
|---|---|
| `list_transactions` | List transactions filtered by app, version, transaction name, device OS, date range, duration threshold, or network profile. Sorted newest first. |
| `get_transaction` | Full detail for one transaction, including time-series CPU, memory, battery, and network samples |
| `get_transaction_performance_summary` | Aggregate avg/max/min CPU, memory, battery, duration, and Speed Index grouped by app version, transaction name, device model, device type, or network profile. Sorted worst-first. |
| `get_performance_trend` | Metrics (Speed Index, CPU, memory, duration) bucketed by day/week/month over a configurable lookback window |

### Agents

> Requires a Cloud Admin JWT.

| Tool | What it does |
|---|---|
| `list_agents` | List all host machines / test agents with OS, region, device count, and health status. Filterable by region and OS type. |
| `get_agent_devices` | List devices connected to a specific agent |

### Regions

> Requires a Cloud Admin JWT.

| Tool | What it does |
|---|---|
| `list_regions` | List all geographic regions (US1, UK1, SG1, DE1, AU1, CA1, US2, CH1) with status |
| `get_region_topology` | Full infrastructure map of a region: NV servers, Selenium agents, signers, storages, reporters |

### NV Servers

> Requires a Cloud Admin JWT.

| Tool | What it does |
|---|---|
| `list_nv_servers` | List all Network Virtualization servers with status and tunneling connectivity. Filterable by region. |
| `get_nv_server` | Details for a specific NV server |

### Environment Management

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_environments` | List all named connection profiles — name, URL, auth type. Marks the active profile. Credentials are never exposed. | Any |
| `switch_environment` | Switch to a named profile instantly. Verifies the new connection and reports the connected user. All subsequent tool calls use the new credentials. | Any |

> **403 guidance:** When a tool returns 403, the error message includes the current auth type and — if a Cloud Admin profile is configured — a ready-to-use `switch_environment(...)` call.

### Workflows

Six tools cover POC and general project lifecycle management. See [Workflow Reference](#workflow-reference) for full documentation.

| Tool | Purpose | Admin Required? |
|---|---|---|
| `create_poc` | 10-step POC setup: device selection, project creation, user provisioning, app assignment | Cloud Admin |
| `close_poc` | Wind down a POC — removes devices and users; preserves the project and group | Cloud Admin |
| `delete_poc` | Full POC teardown including group and project deletion. Requires `confirmDeletion: true`. | Cloud Admin |
| `setup_project` | Guided project provisioning with optional device allocation, users, and app assignment | Cloud Admin |
| `close_project_resources` | Release project resources (devices, sessions, users) without deleting the project | Cloud Admin |
| `teardown_project` | Full project teardown. Requires `confirmDeletion: true`. | Cloud Admin |

### Boilerplate Generation

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_test_boilerplate` | Generate a complete, pre-configured Appium test script. See [Boilerplate Generation](#boilerplate-generation-1) below for full documentation. | Any |

### Resources & Prompts

**Resources** — ambient context the AI can pull on demand:

| Resource URI | What it provides |
|---|---|
| `digital-ai://farm/status` | Live device farm status: counts by availability, OS, and agent health |
| `digital-ai://reporting/recent-failures` | The 20 most recent failed test executions across all projects |

**Prompts** — invoked by name in prompt-aware clients (Claude Desktop). Tool-first clients like Claude Code use the equivalent tool directly.

| Prompt | Equivalent Tool | What it does |
|---|---|---|
| `create_poc` | `create_poc` | Guided POC setup — collects parameters upfront, confirms, then executes |
| `investigate_test_failures` | — | Step-by-step failure triage: summary → recent failures → OS/device breakdown |
| `device_farm_health_check` | — | Full farm health: device statuses → agent health → orphaned sessions |
| `prepare_test_run` | — | Pre-run readiness check: devices → app version → provisioning profile validity |

---

## Workflow Reference

### POC Lifecycle

Three tools cover the full POC lifecycle. All derive the project name (`"<Customer> POC"`) and device tag (`"<customername>poc"`) from `customerName` — pass the same value consistently across all three tools.

#### `create_poc` — Onboard a new POC environment

Collects all parameters upfront, presents a confirmation summary to the operator, then executes 10 sequential steps:

1. Create (or reuse) a device group named `<Customer> POC`
2. Locate the Default device group
3. Select available phones from the Default group — region-matched, conflict-tag-free, phones only (tablets excluded). Presents the selection to the operator for confirmation before proceeding.
4. Add selected devices to the POC group
5. Tag each device with the derived POC tag (e.g. `acmecorppoc`)
6. Remove devices from the Default group
7. Create (or reuse) a project; record the Salesforce URL and end date in project notes
8. Locate the Default project
9. Create users, assign to the POC project, remove from Default, and tag each account with the POC tag. Cloud Admin access is never granted through this workflow.
10. Assign ExperiBank (or a specified app) to the POC project — falls back to the latest available version if the exact version is not found

**Required parameters:**

| Parameter | Description |
|---|---|
| `customerName` | e.g. `"Acme Corp"` → derives project `"Acme Corp POC"` and tag `"acmecorppoc"` |
| `region` | Testing region, e.g. `"US2"`, `"EU"`, `"SG"` |
| `salesforceUrl` | Salesforce Opportunity URL — recorded in project notes |
| `endDate` | Accepts ISO (`"2026-08-31"`), relative offsets (`"+14d"`, `"+2w"`), or natural language (`"in 2 weeks"`) |
| `users` | Array of `{email, firstName, lastName, role}` — role must be `"User"` or `"ProjectAdmin"` |

**Optional parameters:**

| Parameter | Default |
|---|---|
| `deviceCount` | `6` |
| `iosCount` | `ceil(deviceCount / 2)` |
| `androidCount` | `floor(deviceCount / 2)` |
| `automationType` | `"appium-server"` (alternative: `"appium-grid"`) |
| `appName` | `"ExperiBank"` |
| `appVersion` | `"1.0"` |

Steps 1 and 7 check for an existing group/project by name before creating — safe to re-run after a partial failure.

---

#### `close_poc` — Wind down without deleting

Reverses the device and user changes from `create_poc` while leaving the project and device group intact:

1. Locate the POC project and device group by derived name
2. List devices in the POC group
3. Remove the POC tag from each device (all other tags are preserved)
4. Move devices out of the POC group and back into the Default group
5. Process users by POC tag: **delete accounts that have no other project memberships; revoke POC access only for users who also belong to other projects**

Only `customerName` is required.

> The Digital.ai REST API does not expose a user lock or disable endpoint. Deleting the account via `delete_user` is the only API-available way to remove access for users provisioned solely for the POC.

---

#### `delete_poc` — Full teardown

Performs all `close_poc` steps, then permanently deletes the device group and the project. Requires `confirmDeletion: true`.

Before any destructive action, the workflow gathers a full inventory (project ID, group ID, device list, user breakdown) and presents it for explicit confirmation.

**Best practice:** Run `close_poc` first — it safely winds down the POC and is reversible. Use `delete_poc` only once the project data is confirmed no longer needed. Calling `delete_poc` without `confirmDeletion: true` returns a safe explanation and suggests `close_poc` as the alternative.

---

### Project Lifecycle

Three tools mirror the POC lifecycle for general project management. They apply the same multi-project user protection rules: users who belong to other projects are revoked from this project only, never deleted from the platform.

#### `setup_project` — Provision a new project environment

At the start, the workflow asks whether to create a **simple** project record only, or a **full** environment (device group, device allocation, user provisioning, app assignment).

Full setup steps:

1. Create the project with the specified name and automation type
2. Create (or reuse) a device group for the project
3. Select available devices matching the target OS and region. By default, devices are added to the project while keeping all existing group links intact. Set `isolateDevices: true` to remove devices from all other groups before reassigning.
4. Tag each device with a project-derived tag
5. Assign the device group to the project
6. Create users and assign them to the project with the specified roles
7. Assign the specified application to the project
8. Record notes (owner, timeline, or any memo text) in the project record

**Required parameters:**

| Parameter | Description |
|---|---|
| `projectName` | The name for the new project |
| `region` | Target region for device selection |

**Optional parameters:**

| Parameter | Default | Description |
|---|---|---|
| `deviceCount` | `6` | Total devices to allocate |
| `iosCount` | `ceil(deviceCount / 2)` | iOS device count |
| `androidCount` | `floor(deviceCount / 2)` | Android device count |
| `automationType` | `"appium-server"` | `"appium-server"` or `"appium-grid"` |
| `isolateDevices` | `false` | Remove devices from all other groups before assignment |
| `users` | `[]` | Array of `{email, firstName, lastName, role}` |
| `appName` | _(none)_ | App to assign to the project |
| `memo` | _(none)_ | Notes to record on the project |

---

#### `close_project_resources` — Release resources without deleting

Wind down the project environment while leaving the project record intact:

1. Locate the project and its associated device group
2. Release any active or orphaned sessions on project devices
3. Remove the project-derived tag from each device
4. Return devices to the Default group
5. Process users: **delete accounts with no other project memberships; revoke project access only for multi-project users**
6. Uninstall the project application from assigned devices

Only `projectName` is required.

---

#### `teardown_project` — Full project deletion

Performs all `close_project_resources` steps, then permanently deletes the device group and the project. Requires `confirmDeletion: true`.

The workflow presents a full inventory summary before any irreversible action. The same multi-project user protection applies.

**Best practice:** Run `close_project_resources` first, then confirm the project is no longer needed before calling `teardown_project`.

---

## Boilerplate Generation

### `get_test_boilerplate`

Generates a complete, pre-configured Appium test script. The Digital.ai server URL and access key are pre-filled from the MCP server's environment.

| Parameter | Values | Default |
|---|---|---|
| `platform` | `android` \| `ios` | _(required)_ |
| `language` | `java-junit5` \| `java-testng` \| `nodejs` \| `python` | _(required)_ |
| `appId` | Numeric app ID from `list_applications` | Recommended |
| `deviceCategory` | `PHONE` \| `TABLET` | `PHONE` |
| `testName` | Any string | `"My First Mobile Test"` |
| `packageName` | Android package name (e.g. `com.mycompany.app`) | _(optional)_ |
| `mainActivity` | Android main activity (e.g. `.MainActivity`) | _(optional)_ |
| `bundleIdentifier` | iOS bundle ID (e.g. `com.mycompany.app`) | _(optional)_ |
| `projectType` | `standalone-gradle` \| `standalone-maven` \| `android-gradle-submodule` | `standalone-gradle` |
| `outputFormat` | `json` \| `human` | `json` |

**Recommended flow:** call `list_applications` to get the `appId`, then pass it to `get_test_boilerplate`. The server fetches the app record and pre-fills `appPackage`/`appActivity` (Android) or `bundleId` (iOS). Providing `packageName`/`bundleIdentifier` directly also works if the app is not yet in the repository.

`projectType` controls the Java output layout only (ignored for Node.js and Python): `standalone-gradle` produces `src/test/java/` with both `build.gradle` and `pom.xml`; `standalone-maven` produces `pom.xml` only; `android-gradle-submodule` scopes files under `e2e-tests/` for embedding in an existing Android Studio project.

**Files generated per language:**

| Language | Files |
|---|---|
| `java-junit5` / `java-testng` | `AndroidNative.java` or `iOSNative.java` + `build.gradle` + `pom.xml` |
| `nodejs` | `wdio.conf.js` + test file + setup shell steps |
| `python` | Test file + `requirements.txt` |

All boilerplate defaults to the ExperiBank demo app as the starting point. ExperiBank is available on most farm devices and can verify connectivity before switching to your own app.

---

## Reference

### Response Format

All data-returning tools accept an `outputFormat` parameter:

| Value | Default? | Use when |
|---|---|---|
| `"json"` | ✅ Yes | Chaining tool calls — IDs and values pass directly to the next tool without parsing |
| `"human"` | No | Displaying results to an operator — formatted prose with status indicators |

The default is `"json"` because the primary consumers are AI agents that need to extract IDs for follow-up calls. Agents can render JSON for human display; they cannot reliably parse prose for IDs.

```
# Example: pass device group IDs without string manipulation
list_device_groups { outputFormat: "json" }
→ {"deviceGroups":[{"id":"7","name":"Default"},{"id":"12","name":"Acme Corp POC"}]}

get_devices_in_group { groupId: "7" }
→ {"devices":[{"id":"abc123","name":"iPhone 14 Pro",...}]}

add_devices_to_group { groupId: "12", deviceIds: ["abc123"] }
```

Tools that only perform mutations (create, delete, install, etc.) return simple success strings and do not have an `outputFormat` parameter.

### Understanding maxResults

The Digital.ai API returns complete datasets — there is no server-side pagination for most endpoints. The MCP caps responses at `maxResults` (default: 50, max: 500) to keep response sizes manageable for AI assistants.

Use filters to narrow results rather than raising `maxResults`. When results are truncated, you will see:

> ⚠️ Showing 50 of 312 results. Use filters to narrow results, or increase maxResults (max 500) to see more.

### List Filters & Sorting

| Tool | Available Filters | Available `sortBy` values |
|---|---|---|
| `list_users` | firstName, lastName, email, authenticationType, isCloudAdmin, tag | firstName, lastName, email, userName, authenticationType |
| `list_devices` | query (@-syntax), region, model | deviceName, deviceOs, osVersion, manufacturer, displayStatus, agentName, region |
| `get_devices_in_group` | osType, status, category, excludeTags, requireTags | _(none)_ |
| `list_reservations` | username, project, deviceUid | reservationStart, reservationEnd, username, project, deviceUid |
| `list_projects` | name (partial match) | name, id |
| `list_project_users` | username (partial), role (exact) | firstName, lastName, email, userName, role |
| `list_applications` | nameContains, osType, packageName, bundleIdentifier, fileType, isForSimulator | applicationName, version, createdAt (default), osType |
| `list_test_reports` | status, name, has_attachment, success; startDate/endDate (date range) | start_time |

All list tools accept `sortOrder: "asc" | "desc"` (default: `"asc"`).

### Test Reporting Schema

Report fields use **snake_case** to match the API response:

| Field | Type | Description |
|---|---|---|
| `uuid` | string | Unique test execution identifier |
| `test_id` | number | Numeric reporter ID |
| `name` | string | Test name |
| `status` | string | `Passed`, `Failed`, `Incomplete`, `Skipped`, `Error`, `Healed` |
| `success` | boolean | True when status is Passed |
| `start_time` | string | ISO 8601 execution start timestamp |
| `duration` | number \| null | Milliseconds (`null` for in-progress sessions) |
| `project_id` | number | Owning project |
| `has_attachment` | string | `"Y"` or `"N"` |

**Confirmed working filter properties:** `status`, `name` (with `contains` for substring match), `has_attachment`, `success`, `test_id`, `project_id`, `device.os` (case-sensitive: `"Android"` / `"iOS"`), `duration`, `attachment_count`, `attachments_size`, `status_code`. Operators: `=`, `>`, `<`, `>=`, `<=`, `contains`.

**CSRF-blocked filters** — return 401 regardless of key type: `start_time`, `create_time`, `uuid`. Use the `startDate`/`endDate` parameters on `list_test_reports` for date-range filtering instead — these are applied client-side after fetching.

**Reporter ID types:**

| Identifier | Source | How to retrieve |
|---|---|---|
| `test_id` | List results | `get_test_report(testId: N)` |
| `uuid` | List results | No direct endpoint — look up via `test_id` |
| `report_api_id` | Returned by session-start tools | `get_test_by_report_id(reportApiId: "...")` — wait ~60 s after session close |

**Examples:**

```
# Recent failures
list_test_reports
  filter: [{"property":"status","operator":"=","value":"Failed"}]
  sort:   [{"property":"start_time","descending":true}]
  limit:  20

# Date range
list_test_reports
  startDate: "2026-05-01T00:00:00Z"
  endDate:   "2026-05-15T23:59:59Z"

# Pass/fail by OS
get_grouped_test_reports
  groupBy: ["device.os"]
  pivotBy: ["status"]

# Project summary
get_project_test_summary
  startDate:   "2026-05-01T00:00:00Z"
  projectName: "My Project"
```

---

## Diagnostics

If a workflow tool fails or a step returns an unexpected error, run this sequence:

```
1. get_server_info           — confirm tool count (expect 140) and active profile
2. check_workflow_readiness  — which dependency tools are present or missing
3. check_connectivity        — confirm the backend API is reachable
```

`check_workflow_readiness` returns a structured report:

```json
{
  "allWorkflowsReady": true,
  "registeredToolCount": 140,
  "workflows": {
    "create_poc":            { "ready": true, "missingRead": [], "missingWrite": [] },
    "setup_project":         { "ready": true, "missingRead": [], "missingWrite": [] }
  }
}
```

If `ready` is `false`, `missingRead` and `missingWrite` list exactly which tools are absent. The most common cause is a stale Docker image — rebuild:

```bash
docker build -t digital-ai-testing-mcp:latest .
```

The server also logs a readiness check at startup (visible in Docker logs):

```
[digital-ai-testing-mcp] Workflow readiness: all workflows ready ✓
```

or, if degraded:

```
[digital-ai-testing-mcp] ⚠️  DEGRADED: create_poc — missing: create_device_group, add_devices_to_group
```

---

## Safety Guards

All destructive operations require `confirmDeletion: true`. Without it:

> ⚠️ Safety guard triggered. "Delete user 42" is a destructive operation that cannot be undone. Include `confirmDeletion: true` to proceed. No changes were made.

The first call describes exactly what will be deleted. The second call — with `confirmDeletion: true` — executes. This prevents accidental data loss when an AI assistant misinterprets intent.

---

## Development

```bash
npm install
npm run build    # compile TypeScript to dist/
npm run dev      # nodemon + ts-node for live reload
```

**Running tests** — require a live `.env` with valid credentials; tests call the real Digital.ai API:

```bash
npm run test                  # all tests
npm run test:devices          # device management
npm run test:users            # user management
npm run test:applications     # app lifecycle
npm run test:reservations     # reservations
npm run test:projects         # project management
npm run test:reporting        # test reporting
npm run test:test-views       # test view groups
npm run test:browsers         # browser/Selenium
npm run test:device-groups    # device groups
npm run test:repository       # file repository
npm run test:provisioning     # iOS provisioning profiles
npm run test:health           # environment health
npm run test:utils            # utility functions
npm run test:transactions     # performance transactions
npm run test:analytics        # analytics tools
npm run test:infrastructure   # agents / regions / NV servers / sessions
```

Tests can also be run from VS Code: `Ctrl+Shift+P` → "Tasks: Run Task".

---

## Known Limitations

See [docs/limitations.md](docs/limitations.md) for the full list.
