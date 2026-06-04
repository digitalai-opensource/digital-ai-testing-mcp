# Digital.ai Continuous Testing — MCP Server

An MCP (Model Context Protocol) server that lets AI assistants like Claude manage a Digital.ai Continuous Testing device farm. This server exposes **140 tools**, **2 resources**, and **4 prompts** across **22 capability areas**: iOS and Android device management, app lifecycle management, test session control, project and user administration, Selenium browser testing, file repository management, iOS provisioning profiles, environment health monitoring, server backup, automated test reporting, test analytics and stability, performance/transaction reporting, test coverage analytics, test view management, host agent management, regional infrastructure, NV server management, multi-environment connection management, project and POC lifecycle automation, and guided workflow automation.

---

## Prerequisites

- **Node.js 20+**
- **Docker** (for containerized deployment)
- **Digital.ai SaaS account**
- **Access Key** — find it in the Digital.ai web UI under: Your name (top-right) → Access Key

Two key types are supported:
- **JWT token** (`eyJ…`) — Cloud Administrator. Full access to all tools.
- **API key** (`aut_1_…`) — Project user. Access restricted to tools within your assigned projects.

---

## Quick Start

```bash
git clone <this-repo>
cd digital-ai-testing-mcp
npm install
cp .env.example .env
# Edit .env: set DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY
npm run build
```

---

## Build the Docker Image

All AI client connection methods (Claude Desktop, GitHub Copilot, Claude Code) launch the server as a **Docker container**. Build the image once from this directory — it packages the compiled server so clients can run it from anywhere on your machine without needing to reference this source folder again.

```bash
docker build -t digital-ai-testing-mcp:latest .
```

After this, the image lives in Docker's local registry. You only need to rebuild when you pull updates or change the server code.

> **How it works:** When an AI client starts the server it runs `docker run --rm -i --env-file /path/to/.env digital-ai-testing-mcp:latest`. Docker finds the image by name in its local registry, spins up a container with your credentials injected via the env file, and communicates with the server over stdio. The source code directory is not involved at runtime.

---

## Run Tests from VS Code

Open the project in VS Code. Then:

1. Press `Ctrl+Shift+P` → "Tasks: Run Task"
2. Choose any test task (e.g. "Test: Devices")

Or run from the terminal:

```bash
npm run test                  # Run all tests
npm run test:devices          # Device management API
npm run test:users            # User management API
npm run test:applications     # App lifecycle API
npm run test:reservations     # Reservations API
npm run test:projects         # Project management API
npm run test:reporting        # Test reporting API
npm run test:test-views       # Test view groups API
npm run test:browsers         # Browser/Selenium API
npm run test:device-groups    # Device group API
npm run test:repository       # File repository API
npm run test:provisioning     # iOS provisioning profiles API
npm run test:health           # Environment health API
npm run test:utils            # Utility functions
npm run test:transactions     # Performance transactions API
npm run test:analytics        # Analytics tool foundations
npm run test:infrastructure   # v2 agents / regions / NV servers / sessions
```

> **Note:** Tests require a live `.env` with valid credentials — they call the real Digital.ai API.

---

## Connect to Claude Desktop

Find your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this entry:

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/ABSOLUTE/PATH/TO/.env",
        "digital-ai-testing-mcp:latest"
      ]
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/.env` with the full path to your `.env` file. Restart Claude Desktop after editing — the tools appear automatically.

---

## Connect to Claude Code (VS Code)

1. Open the Claude Code extension panel in VS Code
2. Go to Settings → MCP Servers
3. Add a new server with the Docker command above

---

## Connect to GitHub Copilot (VS Code)

GitHub Copilot in VS Code uses MCP tools in **Agent mode** only. There are two ways to register the server depending on whether you want it available globally or scoped to a single project.

### Option A — User settings (available in all workspaces)

Open your VS Code user `settings.json` (`Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)") and add:

```json
{
  "mcp": {
    "servers": {
      "digital-ai-testing": {
        "command": "docker",
        "args": [
          "run", "--rm", "-i",
          "--env-file", "/ABSOLUTE/PATH/TO/.env",
          "digital-ai-testing-mcp:latest"
        ]
      }
    }
  }
}
```

### Option B — Workspace settings (scoped to one project)

Create or edit `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/ABSOLUTE/PATH/TO/.env",
        "digital-ai-testing-mcp:latest"
      ]
    }
  }
}
```

> Committing `.vscode/mcp.json` to source control shares the server configuration with your whole team automatically.

### Using the tools

1. Open **Copilot Chat** (`Ctrl+Alt+I`)
2. Switch the chat mode dropdown to **Agent**
3. Type your request — Copilot will call the Digital.ai tools as needed

You can also add the server via the Command Palette: `Ctrl+Shift+P` → **MCP: Add Server**.

> **Note:** GitHub Copilot on the web (`github.com/copilot`) does not support connecting external MCP servers. VS Code is required.

---

## Understanding Access Keys

### What your key controls

Your Digital.ai access key is not just a password — it determines **who you are to the platform**, which directly shapes what the MCP can do on your behalf.

| Key type | Looks like | What you can do |
|---|---|---|
| **Cloud Admin JWT** | `eyJ…` (long base-64 string) | Full access to all 140 tools: device management, user provisioning, project administration, infrastructure, performance data, and everything else |
| **Project API key** | `aut_1_…` | Access scoped to the devices, apps, and test reports within **one specific project** and role. Cloud Admin tools (v2 API, provisioning profiles, user management) return 403. |

When a Cloud Admin tool is called with a project key the MCP returns a plain-language error explaining what happened and — if a Cloud Admin profile is configured — a ready-to-use `switch_environment(...)` command.

### How to find your key

1. Log in to the Digital.ai Continuous Testing web portal (your `DIGITAL_AI_BASE_URL`)
2. Click your **name or avatar** in the top-right corner
3. Select **Access Key** from the dropdown menu
4. Your key for the **currently selected project** is displayed — copy it in full

> **Important:** The key shown is specific to the project you have open in the portal at that moment. If you belong to multiple projects, each one has its own separate key.

### Switching project context to get a different key

If you are a member of more than one project, each project has its own API key with its own scope and permissions:

1. In the Digital.ai portal, use the **project selector** (usually a dropdown near the top of the page) to switch to the project you want
2. Navigate back to **Your name → Access Key**
3. Copy the new key — it will be different from the previous one

### Using multiple keys with the MCP

Rather than editing your `.env` every time you want to switch contexts, configure named profiles so you can switch at runtime by asking Claude:

```
# .env — configure once, switch any time
DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com
DIGITAL_AI_ACCESS_KEY=eyJ...your-cloud-admin-jwt...

DAI_PROFILE_QA_URL=https://your-tenant.experitest.com
DAI_PROFILE_QA_KEY=aut_1_...your-qa-project-key...

DAI_PROFILE_STAGING_URL=https://your-tenant.experitest.com
DAI_PROFILE_STAGING_KEY=aut_1_...your-staging-project-key...
```

Then ask Claude:
- *"What environments are configured?"* → calls `list_environments`
- *"Switch to the QA project"* → calls `switch_environment("qa")`
- *"Switch back to Cloud Admin"* → calls `switch_environment("default")`

The switch takes effect instantly for all subsequent tool calls — no restart needed.

> **Security note:** Never share your `.env` file or commit it to source control. Each team member should use their own personal access key obtained from the portal under their own account.

---

## Configuration Reference

| Variable | Description | Required | Default |
|---|---|---|---|
| `DIGITAL_AI_BASE_URL` | Your Digital.ai tenant URL | ✅ Required | — |
| `DIGITAL_AI_ACCESS_KEY` | Access key (JWT or API key — see above) | ✅ Required | — |
| `MCP_SERVER_NAME` | Server identity shown in the AI client | Optional | `digital-ai-testing-mcp` |
| `MCP_SERVER_VERSION` | Server version | Optional | `1.0.0` |
| `REQUEST_TIMEOUT_MS` | API request timeout | Optional | `30000` |
| `UPLOAD_TIMEOUT_MS` | File upload timeout | Optional | `120000` |

---

## Tool Reference

### Users

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_users` | List all user accounts | firstName, lastName, email, authenticationType, isCloudAdmin, tag filters; sortBy/sortOrder | Cloud Admin |
| `create_user` | Create a new user account | — | Cloud Admin |
| `delete_user` | Permanently delete a user account | — | Cloud Admin |
| `get_my_account_info` | Show the account for the active API key | — | Any |
| `assign_user_to_projects` | Grant user access to one or more projects | — | Cloud Admin |
| `unassign_user_from_projects` | Remove user from one or more projects | — | Cloud Admin |
| `get_user_tags` | Return the tags currently assigned to a user | — | Cloud Admin |
| `set_user_tags` | Replace all tags on a user (max 10) | — | Cloud Admin |

### Devices

Device tools accept a **flexible device identifier**: numeric device ID, serial number, UDID, or device name. The server resolves the identifier to the backend ID automatically.

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_devices` | List all devices with status, OS, model, and agent | `query` (@-syntax), `region`, `model` filters; sortBy/sortOrder | Any |
| `get_device_detail` | Full device profile including groups and status history | — | Cloud Admin |
| `edit_device` | Update device name, notes, or category | — | Cloud Admin |
| `release_device` | Release a reserved or stuck device | — | Any |
| `reboot_device` | Remote reboot a device | — | Cloud Admin |
| `reset_device_usb` | Reset USB connection | — | Cloud Admin |
| `start_device_web_control` | Open a browser-based control session | — | Cloud Admin |
| `open_mobile_studio` | Open Mobile Studio for a device | — | Any |
| `create_mobile_manual_test` | Create a structured manual test session | — | Any |
| `download_ios_app_container` | Download an iOS app data container | — | Cloud Admin |
| `get_device_tags` | List all tags on a device | — | Any |
| `add_device_tag` | Add a tag to a device | — | Cloud/Project Admin |
| `remove_device_tag` | Remove a specific tag from a device | — | Cloud/Project Admin |
| `remove_all_device_tags` | Remove all tags from a device | — | Cloud/Project Admin |
| `get_device_ca_certificates` | List CA certificates on an Android device | — | Cloud Admin |
| `get_device_health_summary` | Device farm health overview | — | Any |
| `find_available_device` | Find the first available device matching OS, tags, or version | — | Any |
| `release_orphaned_sessions` | Find and release devices stuck in "In Use" beyond a time threshold | — | Any |

**Device query syntax** (`list_devices` query parameter — server-side fields only):

```
@os='android'            @os='iOS'          (case-insensitive)
@version='14.0'          @version>'13.0'    (decimal required; supports = > < !=)
@category='PHONE'        @category='TABLET' (UPPERCASE required)
@region='US2'            @region='SG1'
@name='My Device'                           (exact device display name)
@model='iPhone 12'       @modelName='Xiaomi Redmi Note 9 5G'
@serialNumber='4hlfov...'                   (exact serial/UDID)
@emulator='false'
```

Combine with `and`: `@os='android' and @category='PHONE' and @version>'13.0' and @region='US2'`

> **Fields that silently return empty results — do not use in queries:** `@manufacturer`, `@tag`, `@deviceName`, `@id`, `@udid`, `@status`, `@agentName`, `@location`, `@project`, `@group`. The API accepts these without error but returns nothing. Use the `manufacturer`, `tags`, `model`, and `region` parameters on `list_devices` and `find_available_device` instead — those filter client-side and always work.

Use the `region` and `model` parameters for region/model filtering — these are applied client-side and more reliably than `@` query syntax for those fields.

### Device Groups

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_device_groups` | List all device groups | Cloud Admin |
| `get_devices_in_group` | List devices in a group | Cloud Admin |
| `get_projects_in_group` | List projects that have access to a group | Cloud Admin |
| `create_device_group` | Create a new device group | Cloud Admin |
| `edit_device_group` | Rename a group or change auto-accept setting | Cloud Admin |
| `delete_device_group` | Delete a device group (devices are not deleted) | Cloud Admin |
| `add_devices_to_group` | Add devices to a group | Cloud Admin |
| `remove_devices_from_group` | Remove devices from a group | Cloud Admin |
| `assign_group_to_project` | Grant a project access to a device group | Cloud Admin |

### Reservations

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_reservations` | List current and upcoming reservations | username, project, deviceUid filters; sortBy/sortOrder | Any |
| `create_reservation` | Reserve one or more devices | — | Cloud/Project Admin |
| `reserve_device_for_duration` | Reserve a device starting now for N hours (e.g. 0.5 = 30 min, 1.0 = 1 hour) | — | Cloud/Project Admin |
| `delete_reservation` | Cancel a reservation | — | Cloud/Project/User |
| `check_device_availability_window` | Check a device's reservation schedule over a time window | — | Cloud Admin |

### Applications

| Tool | What it does | Filters / Sort | Admin Required? |
|---|---|---|---|
| `list_applications` | List all apps in the repository | sortBy/sortOrder (default: newest first) | Any |
| `get_application_info` | Full app detail | — | Any |
| `upload_application_file` | Upload APK/IPA/AAB from a local file path | — | Cloud Admin |
| `upload_application_from_url` | Upload an app from a direct-download URL | — | Cloud Admin |
| `delete_application` | Delete an app from the repository | — | Cloud Admin |
| `update_application_plugins` | Update iOS plugin signing profiles | — | Cloud Admin |
| `install_application` | Install an app on one or more devices | — | Any |
| `uninstall_application` | Uninstall an app from one or more devices | — | Any |
| `uninstall_application_by_package` | Uninstall by package name on a single device | — | Any |
| `uninstall_application_by_package_from_devices` | Uninstall by package name across multiple devices | — | Any |
| `find_latest_application` | Find the newest uploaded version of an app by name (`appName`), bundle ID, or package name. `osType` is optional when searching by name. Returns `appCapabilityString` (e.g. `cloud:MyApp`) ready to paste into the `app` desired capability. | — | Any |
| `extract_app_language_files` | Download localization files from an app | — | Any |
| `bulk_install_to_group` | Install an app on every device in a device group | — | Any |

> **Upload from URL:** The URL must be a direct-download link accessible from the Digital.ai server's network. Redirect URLs (shortened links, CDN redirects), auth-required URLs, and URLs that don't resolve to a supported file type (.apk, .ipa, .aab, .zip) will return a 400 with a diagnostic message.

> **Docker uploads:** The MCP server runs in a Docker container and cannot access host filesystem paths. Mount the directory containing your APK/IPA as a volume (e.g. `-v /host/apps:/apps`) and reference the container path (e.g. `/apps/myapp.apk`).

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
| `create_project` | Create a new project with optional device group and automation type | — | Cloud Admin |
| `delete_project` | Delete a project | — | Cloud Admin |
| `list_project_users` | List users in a project | username, role filters; sortBy/sortOrder | Cloud/Project Admin |
| `assign_user_to_project` | Grant user access to a project with a role | — | Cloud Admin |
| `remove_user_from_project` | Remove user from a project | — | Cloud Admin |
| `get_project_tokens` | Get token configuration | — | Cloud/Project Admin |
| `set_project_tokens` | Update token mode | — | Cloud Admin |
| `get_project_settings` | Get basic project settings (6 v1 calls) | — | Cloud/Project Admin |
| `get_project_admin_settings` | Full admin configuration via v2 API — 35+ fields in one call: per-type license limits, all cleanup flags, reservation policies, feature flags, user/app counts | — | Cloud Admin (JWT only) |
| `update_project_settings` | Update cleanup, concurrency, and limit settings | — | Cloud Admin |
| `set_telephony_status` | Enable/disable calls and SMS | — | Cloud Admin |
| `get_project_notes` | Get project notes/memo | — | Any |
| `set_project_notes` | Set project notes/memo | — | Cloud/Project Admin |
| `get_project_devices` | List devices accessible to a project | — | Cloud/Project Admin |
| `get_automation_properties` | Get Appium/automation properties | — | Any |
| `assign_app_to_project` | Make an app available to a project | — | Cloud Admin |

### Provisioning Profiles

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_provisioning_profiles` | List iOS signing profiles | Cloud Admin |
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
| `get_environment_summary` | Full environment snapshot (devices, agents, groups) | Any |
| `check_ios_readiness` | iOS device and provisioning profile readiness | Any |
| `check_android_readiness` | Android device readiness. If `available: 0`, counts may be project-scoped — try `find_available_device` which may search a broader pool. | Any |
| `get_agent_status` | Agent connectivity overview | Any |
| `get_server_info` | Server version, target URL, tool count, and capability domains | Any |
| `check_connectivity` | Verify the MCP server can reach the Digital.ai API | Any |
| `check_workflow_readiness` | Structured readiness report for all workflow tools — lists which dependency tools are present or missing. Call this first when diagnosing workflow execution failures. | Any |
| `list_active_sessions` | List currently active browser/Selenium sessions from the session registry. More reliable than `list_active_test_executions` for browser sessions. | Cloud Admin |
| `get_reporter_project_storage` | Per-project disk storage usage in the reporter — current MB, quota, usage %, artifact counts. Sorted by usage descending. | Cloud Admin |
| `get_license_info` | Platform license limits: dedicated devices, shared devices, virtual devices, browser sessions. | Cloud Admin |
| `get_license_utilization` | Current in-use counts vs. purchased limits for devices and browser sessions. Soft-fails gracefully if sessions endpoint is unavailable. | Cloud Admin |

### Coverage Analytics

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_device_coverage_summary` | Cross-references the device farm inventory against test execution history — which OS values, models, and manufacturers have been tested vs. available. Identifies OS values with no test history. | Any |
| `get_regional_test_coverage` | Device farm composition by region (device counts, OS split, availability rate per region). Note: test records lack a region field, so this shows infrastructure coverage rather than execution coverage. | Any |

### Reporting

| Tool | What it does | Admin Required? |
|---|---|---|
| `get_test_report` | Retrieve a full test execution report by numeric test ID or by the `digitalai:reportUrl` capability value printed in `tearDown` | Any |
| `get_test_by_report_id` | Retrieve a report by its `report_api_id` (returned when starting a session) | Any |
| `list_test_reports` | Search, filter, sort, and paginate test reports. Confirmed working filters: `status`, `name` (with `contains`), `success`, `has_attachment`, `test_id`, `project_id`, `device.os` (case-sensitive: `"Android"`/`"iOS"`), `duration`, `attachment_count`, `attachments_size`. Operators: `=`, `>`, `<`, `>=`, `<=`, `contains`. CSRF-blocked: `start_time`, `create_time`, `uuid` — use `startDate`/`endDate` params instead. | Any |
| `find_latest_test_for_name` | Return the most recent run record for a test by name | Any |
| `get_grouped_test_reports` | Pass/fail counts grouped by field values (use `groupBy` param, e.g. `["device.os"]`). Supports `pivotBy` for per-status columns. `null` OS = browser sessions. | Any |
| `get_test_stability_report` | Last N runs of a named test with per-run pass/fail, overall pass rate, sparkline trend, and consecutive streak count. | Any |
| `get_cross_platform_divergence` | Find tests passing on one OS but failing on the other. Configurable minimum run count and divergence threshold (percentage points). | Any |
| `get_daily_execution_trend` | Test execution counts and pass rates bucketed by day or week. Stops at `lookbackDays` OR `maxRecords` (default 5 000, max 25 000) whichever comes first. | Any |
| `get_project_test_summary` | All-time pass/fail counts + top failing tests in a time window | Any |
| `get_failure_rate_by_app_version` | Pass/fail breakdown grouped by app version metadata key | Any |
| `get_distinct_test_key_values` | Discover all distinct values recorded for a report key | Any |
| `list_active_test_executions` | List currently-running test executions (Incomplete + null duration) | Any |
| `delete_test_reports` | Permanently delete test records by ID list | Cloud Admin |
| `delete_test_reports_before_date` | Delete all test records started before a given date | Cloud Admin |
| `download_test_attachments` | Download test attachments as a ZIP file | Any |
| `list_test_attachments` | Show attachment metadata for a test by numeric test ID | Any |

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

### Transactions / Performance Reporting (Cloud Admin JWT only)

Transactions are performance-instrumented segments of a mobile test session. Developers mark start/end points in the app or test script; the platform records CPU, memory, battery, and network metrics for each interval. Use these tools for performance regression testing — compare metrics across app versions or identify slow operations.

> **Note:** Server-side filtering is not available on the transaction API (CSRF-blocked). All filters are applied client-side after fetching all records.

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_transactions` | List performance transactions filtered by app, version, transaction name, device OS, date range, duration threshold, or network profile. Sorted newest first. | Cloud Admin |
| `get_transaction` | Full detail for one transaction including time-series CPU, memory, battery, and network samples (`cpuSamples`, `memorySamples`, etc.). | Cloud Admin |
| `get_transaction_performance_summary` | Aggregate avg/max/min CPU, memory, battery, duration, and speed index grouped by `appVersion`, `name`, `deviceModel`, `deviceType`, `deviceScreen`, `deviceName`, or `networkProfile`. Sorted worst-first. | Cloud Admin |
| `get_performance_trend` | Performance metrics (Speed Index, CPU, memory, duration) bucketed by day/week/month over a configurable lookback window. Accepts all transaction filters. | Cloud Admin |

### Agents (v2 API — Cloud Admin only)

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_agents` | List all host machines / test agents with OS, region, device count, and status. Filterable by region and OS type. | Cloud Admin |
| `get_agent_devices` | List all devices connected to a specific agent by numeric agent ID. | Cloud Admin |

### Regions (v2 API — Cloud Admin only)

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_regions` | List all geographic regions (US1, UK1, SG1, DE1, AU1, CA1, US2, CH1) with status and host details. | Cloud Admin |
| `get_region_topology` | Full infrastructure map of a region: NV servers, Selenium agents, signers, storages, DHMs, EHMs, reporters. | Cloud Admin |

### NV Servers (v2 API — Cloud Admin only)

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_nv_servers` | List all Network Virtualization servers with status and tunneling connectivity. Filterable by region. | Cloud Admin |
| `get_nv_server` | Get details for a specific NV server by numeric ID. | Cloud Admin |

### Workflows — POC Lifecycle

| Tool | What it does | Admin Required? |
|---|---|---|
| `create_poc` | Guided 10-step POC setup: device group → device selection → tagging → project → users → app assignment. Supports relative end dates, idempotent re-runs, and ExperiBank version fallback. | Cloud Admin |
| `close_poc` | Wind down a POC: removes POC tag from devices, returns devices to Default group, processes users — **deletes accounts with no other project memberships; revokes POC access only for multi-project users**. Non-destructive — project and group are preserved. | Cloud Admin |
| `delete_poc` | Full POC teardown: all close_poc steps plus permanent deletion of the device group and project. Same multi-project user protection applies. Requires `confirmDeletion: true`. | Cloud Admin |

### Workflows — General Project Lifecycle

| Tool | What it does | Admin Required? |
|---|---|---|
| `setup_project` | Guided project setup. Starts by asking simple (project record only) vs. full (device group, device allocation, user provisioning, app assignment). Optional memo replaces Salesforce URL. `isolateDevices: true` removes devices from **all** other groups; default preserves existing group links. | Cloud Admin |
| `close_project_resources` | Wind down a project environment: untags devices, returns to Default group, processes users (delete if project-only; revoke access if multi-project). Project and device group are preserved. | Cloud Admin |
| `teardown_project` | Full project teardown: close_project_resources steps plus permanent deletion of device group and project. Requires `confirmDeletion: true`. Presents pre-deletion inventory. | Cloud Admin |

### Environment Management

| Tool | What it does | Admin Required? |
|---|---|---|
| `list_environments` | List all named connection profiles from `.env` — name, URL, auth type. Keys are never exposed. Marks the currently active profile. | Any |
| `switch_environment` | Switch the active API connection to a different named profile instantly. Verifies the new connection and reports the connected user. All subsequent tool calls use the new credentials. | Any |

> **Multi-environment setup:** Add `DAI_PROFILE_{NAME}_URL` and `DAI_PROFILE_{NAME}_KEY` pairs to your `.env` to configure additional environments or project-scoped keys. The most common use case is a Cloud Admin JWT profile alongside one or more project API key profiles. See `.env.example` for examples.

> **403 auth guidance:** When a tool returns 403 Forbidden, the error message automatically includes the current connection's auth type and — if a Cloud Admin profile is configured — a ready-to-use `switch_environment(...)` call. No need to read documentation to understand what went wrong.

---

## MCP Resources and Prompts

In addition to tools, this server exposes **2 resources** and **4 prompts** that AI assistants can use proactively.

### Resources (ambient context, pulled on demand)

| Resource URI | What it provides |
|---|---|
| `digital-ai://farm/status` | Live device farm status: counts by availability, OS, and agent health |
| `digital-ai://reporting/recent-failures` | The 20 most recent failed test executions across all projects |

### Prompts (structured workflows)

Prompts are invoked differently depending on the client:
- **Prompt-aware clients** (Claude Desktop, some MCP UIs): invoke by prompt name
- **Tool-first clients** (Claude Code, GitHub Copilot): use the equivalent tool where available

| Prompt | Equivalent Tool | What it does |
|---|---|---|
| `create_poc` | `create_poc` ✅ | Guided POC environment setup — collects parameters upfront, confirms with operator, then executes 10 sequential steps using individual MCP tools |
| `investigate_test_failures` | — | Step-by-step failure triage: summary → recent failures → OS/device breakdown |
| `device_farm_health_check` | — | Full farm health review: device statuses → agent health → orphaned sessions |
| `prepare_test_run` | — | Pre-run readiness check: available devices → app version → profile validity |

---

## POC Lifecycle Workflows

Three workflows cover the full POC lifecycle. All derive the POC name (`"<Customer> POC"`) and device tag (`"acmecorppoc"`) from `customerName` — always pass it exactly as used at creation time.

### `create_poc` — Onboard a new POC

Collects all parameters upfront, confirms with the operator, then executes 10 sequential steps:

1. Create (or reuse) a device group named `<Customer> POC`
2. Locate the Default device group
3. Select available phones from the Default group (region-matched, conflict-tag-free, phones only — tablets excluded). Proposes selection to operator for confirmation.
4. Add selected devices to the POC group
5. Tag each device with the derived POC tag (e.g. `acmecorppoc`)
6. Remove devices from the Default group
7. Create (or reuse) a project; record Salesforce URL + end date in project notes
8. Locate the Default project
9. Create users, assign to POC project, remove from Default, tag each user account with the POC tag (no Cloud Admin access ever granted)
10. Assign ExperiBank (or specified app) to the POC project — falls back to latest available version if exact version is not found

**Required parameters:**

| Parameter | Description |
|---|---|
| `customerName` | Customer name, e.g. `"Acme Corp"` → derives `"Acme Corp POC"` and tag `"acmecorppoc"` |
| `region` | Testing region, e.g. `"US2"`, `"EU"`, `"SG"` |
| `salesforceUrl` | Salesforce Opportunity URL — recorded in project notes |
| `endDate` | POC end date — accepts ISO (`"2026-08-31"`), relative offsets (`"+14d"`, `"+2w"`), or natural language (`"in 2 weeks"`) |
| `users` | Array of `{email, firstName, lastName, role}` — role must be `"User"` or `"ProjectAdmin"` |

**Optional parameters:**

| Parameter | Default |
|---|---|
| `deviceCount` | 6 |
| `iosCount` | ceil(deviceCount / 2) |
| `androidCount` | floor(deviceCount / 2) |
| `automationType` | `"appium-server"` (alternative: `"appium-grid"`) |
| `appName` | `"ExperiBank"` |
| `appVersion` | `"1.0"` |

**Device selection rules enforced automatically:**
- `deviceCategory === "PHONE"` only — tablets, watches, and unknowns excluded
- `displayStatus === "Available"` only — offline, error, and cleanup states excluded
- Region partial-match against the provided region code
- Conflict tag exclusion: devices tagged `DONOTUSE`, `POC`, `IN USE`, or similar are skipped

**Idempotency:** Steps 1 and 7 check for an existing group/project by name before creating — safe to re-run after a partial failure.

---

### `close_poc` — Wind down without deleting

Reverses the device and user changes from `create_poc` while leaving the project and device group intact:

1. Locate POC project and device group by name
2. List devices in the POC group
3. Remove the POC tag from each device (other tags are left untouched)
4. Remove devices from the POC group and add them back to the Default group
5. Identify POC-created users by their POC tag, then **confirm each user individually** before permanently deleting their account

Only one parameter required: `customerName`.

**Per-user confirmation in Step 5:** The workflow displays each tagged user (name, email, role) and asks "Permanently delete this user account? (yes / skip)" before acting. This guards against accidentally deleting an admin who temporarily added themselves to the POC project — such a user would have the POC tag if they were originally provisioned via `create_poc`, but an admin who simply joined the project later would not appear in the list at all. Skipped users are recorded in the completion summary but not touched.

> **Note:** The Digital.ai REST API does not expose a user lock or disable endpoint. Permanent account deletion via `delete_user` is the only API-available way to fully remove access for these accounts.

---

### `delete_poc` — Full teardown

Performs all `close_poc` steps, then permanently deletes the device group and project. Requires `confirmDeletion: true`.

Before any destructive action, the workflow gathers a full inventory (project ID, group ID, device list, user breakdown) and presents it to the operator for explicit confirmation.

**User deletion in `delete_poc`:** Unlike `close_poc`, there is no per-user confirmation gate. The operator's `confirmDeletion: true` and the pre-deletion inventory confirmation in Step 0 together constitute authorization to permanently delete all POC-tagged user accounts. The POC tag filter is the safeguard that limits scope to `create_poc`-provisioned users only.

**Best practice:** Run `close_poc` first. It safely winds down the POC and is fully reversible. Use `delete_poc` only once you are confident the project data is no longer needed. When called without `confirmDeletion: true`, the response explains how to confirm and recommends `close_poc` as the safer alternative.

---

## Boilerplate Tool

### `get_test_boilerplate` — Start writing tests immediately

Returns a complete, pre-configured test script for the chosen mobile platform and language. The Digital.ai access key and server URL are pre-filled from the MCP environment.

| Parameter | Values | Default |
|---|---|---|
| `platform` | `android` \| `ios` | _(required)_ |
| `language` | `java-junit5` \| `java-testng` \| `nodejs` \| `python` | _(required)_ |
| `appId` | Numeric app ID from `list_applications` | _(optional, recommended)_ |
| `deviceCategory` | `PHONE` \| `TABLET` | `PHONE` |
| `testName` | any string | `"My First Mobile Test"` |
| `packageName` | Android package name (e.g. `com.mycompany.app`) | _(optional)_ |
| `mainActivity` | Android main activity (e.g. `.MainActivity`) | _(optional)_ |
| `bundleIdentifier` | iOS bundle ID (e.g. `com.mycompany.app`) | _(optional)_ |
| `projectType` | `standalone-gradle` \| `standalone-maven` \| `android-gradle-submodule` | `standalone-gradle` |
| `outputFormat` | `json` \| `human` | `json` |

**Recommended flow:** call `list_applications` to get the `appId`, then pass it to `get_test_boilerplate`. The server looks up the app record and pre-fills `appPackage`/`appActivity` (Android) or `bundleId` (iOS) automatically, then replaces the ExperiBank demo steps with guided TODO placeholders specific to your app. Providing `packageName`/`bundleIdentifier` directly also works and has the same effect.

`projectType` controls the Java output layout only (ignored for NodeJS/Python): `standalone-gradle` outputs `src/test/java/` with both `build.gradle` and `pom.xml`; `standalone-maven` outputs `pom.xml` only; `android-gradle-submodule` outputs files scoped to `e2e-tests/` for embedding in an existing Android Studio project.

**Files returned per language:**

| Language | Files |
|---|---|
| `java-junit5` / `java-testng` | `AndroidNative.java` / `iOSNative.java` + `build.gradle` + `pom.xml` |
| `nodejs` | `wdio.conf.js` + test file + setup shell steps |
| `python` | test file + `requirements.txt` |

All boilerplate defaults to the ExperiBank demo app as the starting point. The demo app is available on most Digital.ai farm devices and can be used to verify connectivity before switching to your own app.

---

## Response Format (`outputFormat`)

All data-returning tools accept an `outputFormat` parameter that controls the response shape:

| Value | Default? | Use when |
|---|---|---|
| `"json"` | ✅ Yes | Chaining tool calls in an automated workflow — IDs and values pass directly to the next tool with no parsing |
| `"human"` | No | Displaying results directly to an operator — formatted prose with emoji status indicators |

The default is `"json"` because the primary consumers of this server are orchestration agents (Claude, GitHub Copilot, Gemini, etc.) that need to extract IDs for follow-up calls. Agents can always render JSON for human display; they cannot reliably parse prose for IDs.

**Example — device ID chain without string parsing:**

```
# Step 1: get group IDs
list_device_groups { outputFormat: "json" }
→ {"deviceGroups":[{"id":"7","name":"Default"},{"id":"12","name":"Acme Corp POC"}]}

# Step 2: get devices from that group — id field is explicit
get_devices_in_group { groupId: "7", outputFormat: "json" }
→ {"devices":[{"id":"abc123","name":"iPhone 14 Pro","osType":"iOS",...},...]}

# Step 3: pass IDs directly — no parsing needed
add_devices_to_group { groupId: "12", deviceIds: ["abc123"] }
```

Tools that only perform mutations (create, delete, add, remove, set, upload, install, etc.) return simple success strings and do not have an `outputFormat` parameter.

---

## Understanding maxResults

The Digital.ai API returns **complete datasets** — there is no server-side pagination. The MCP server limits responses to `maxResults` (default: 50, max: 500) to keep responses manageable for AI assistants.

For large environments, **use filters** to narrow results rather than increasing maxResults to the maximum. When results are truncated, you will see a notice like:

> ⚠️ Showing 50 of 312 results. Use filters to narrow results, or increase maxResults (max 500) to see more.

---

## List Tool Filters and Sorting

Most `list_*` tools support client-side filtering and sorting. All sorting is applied after fetching the full result set.

| Tool | Available Filters | Available `sortBy` Values |
|---|---|---|
| `list_users` | firstName, lastName, email, authenticationType, isCloudAdmin, tag | firstName, lastName, email, userName, authenticationType |
| `list_devices` | query (@-syntax), region, model | deviceName, deviceOs, osVersion, manufacturer, displayStatus, agentName, region |
| `get_devices_in_group` | osType (ios/android), status (Available/Offline/etc.), category (PHONE/TABLET/WATCH), excludeTags (exclude devices with any listed tag), requireTags (require all listed tags) | *(none — use maxResults to limit)* |
| `list_reservations` | username, project, deviceUid | reservationStart, reservationEnd, username, project, deviceUid |
| `list_projects` | name (partial match) | name, id |
| `list_project_users` | username (partial), role (exact) | firstName, lastName, email, userName, role |
| `list_applications` | nameContains (partial name match), osType, packageName, bundleIdentifier, fileType, isForSimulator | applicationName, version, createdAt (default), osType |
| `list_test_reports` | status, name, has_attachment, success; startDate/endDate (date range) | start_time |

All list tools also accept `sortOrder: "asc" | "desc"` (default `"asc"`).

---

## Test Reporting

The `list_test_reports` tool supports rich filtering and sorting against the reporter API. Report fields use **snake_case** (matching the API response):

| Field | Type | Description |
|---|---|---|
| `uuid` | string | Unique test execution identifier |
| `test_id` | number | Numeric reporter ID |
| `name` | string | Test name |
| `status` | string | `Passed`, `Failed`, `Incomplete`, `Skipped`, `Error`, `Healed` |
| `success` | boolean | True when status is Passed |
| `start_time` | string | ISO 8601 execution start timestamp |
| `duration` | number \| null | Duration in milliseconds (`null` for in-progress sessions) |
| `project_id` | number | Owning project |
| `has_attachment` | string | `"Y"` or `"N"` |

**Supported filter properties:** `status`, `name` (with `contains`), `has_attachment`, `success` (boolean), `test_id`, `project_id`, `device.os` (case-sensitive: `"Android"`/`"iOS"`), `duration`, `attachment_count`, `attachments_size`, `status_code`. Operators: `=`, `>`, `<`, `>=`, `<=`, `contains`. The properties `start_time`, `create_time`, and `uuid` are CSRF-blocked — use `startDate`/`endDate` parameters instead, which apply date filtering client-side.

**Reporter API ID taxonomy:**

| Identifier | Type | Source | How to retrieve |
|---|---|---|---|
| `test_id` | number | List results | `get_test_report(testId: N)` |
| `uuid` | string | List results | No direct endpoint — look up by `test_id` |
| `report_api_id` | string | Returned by session-start tools | `get_test_by_report_id(reportApiId: "...")` — only works after the session ends |

**Example — list recent failures:**
```
list_test_reports
  filter: [{"property":"status","operator":"=","value":"Failed"}]
  sort:   [{"property":"start_time","descending":true}]
  limit:  20
```

**Example — filter by date range:**
```
list_test_reports
  startDate: "2026-05-01T00:00:00Z"
  endDate:   "2026-05-15T23:59:59Z"
  limit: 50
```

**Example — pass/fail breakdown across all projects:**
```
get_grouped_test_reports with pivotBy: ["status"]
```

**Example — project summary:**
```
get_project_test_summary
  startDate: "2026-05-01T00:00:00Z"
  projectName: "My Project"
```
Output includes all-time totals (Total/Passed/Failed/Incomplete) and top failing tests within the time window — these are intentionally separate to avoid misreading all-time counts as time-scoped.

---

## Diagnosing Workflow Execution Failures

If a workflow tool returns an error or a step fails because a required tool is unavailable, follow this sequence:

```
1. get_server_info        — verify tool count matches expected (140 tools)
2. check_workflow_readiness — structured JSON: which dependency tools are present/missing
3. check_connectivity     — confirm the backend API is reachable
```

`check_workflow_readiness` returns a report like:

```json
{
  "allWorkflowsReady": true,
  "registeredToolCount": 140,
  "workflows": {
    "create_poc": { "ready": true, "workflowToolPresent": true, "missingRead": [], "missingWrite": [] },
    "close_poc":  { "ready": true, "workflowToolPresent": true, "missingRead": [], "missingWrite": [] },
    "delete_poc": { "ready": true, "workflowToolPresent": true, "missingRead": [], "missingWrite": [] }
  }
}
```

If `ready` is `false` for any workflow, the `missingRead` and `missingWrite` arrays list exactly which tools are absent. The most common cause is a stale Docker image — rebuild it:

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

## Safety Guards (confirmDeletion)

All destructive operations — deletions, permanent changes, account removals — require `confirmDeletion: true` in the request. Without it, you will see:

> ⚠️ Safety guard triggered. "Delete user 42" is a destructive operation that cannot be undone. To confirm you want to proceed, include confirmDeletion: true in your request. No changes were made.

This prevents accidental data loss when AI assistants misinterpret intent.

---

## Known Limitations

See [docs/limitations.md](docs/limitations.md) for the full list.

---

## Publishing to Your Team

See [docs/publishing.md](docs/publishing.md) for GitHub setup instructions.
