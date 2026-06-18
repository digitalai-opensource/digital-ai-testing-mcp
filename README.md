<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/images/dai-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/images/dai-logo-light.svg">
  <img alt="Digital.ai Continuous Testing MCP Server" src=".github/images/dai-logo-light.svg" width="600">
</picture>

# Digital.ai Continuous Testing — MCP Server

An MCP (Model Context Protocol) server that connects AI assistants like Claude to a Digital.ai Continuous Testing device farm. The server exposes **170 tools**, **2 resources**, and **5 prompts** covering 24 capability areas: device management, test execution, app lifecycle, reporting, analytics, performance, project administration, interactive inspection, and more.

---

## Quick Start

```bash
# 1. Pull the image (see Installation for GHCR authentication)
docker pull ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest

# 2. Create your .env
curl -O https://raw.githubusercontent.com/dai-continuous-testing/digital-ai-testing-mcp/main/.env.example
cp .env.example .env   # set DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY
```

Add to your AI client (Claude Desktop shown — see [Connecting AI Clients](#connecting-ai-clients) for VS Code, JetBrains, Copilot, and Cursor):

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "--env-file", "/ABSOLUTE/PATH/TO/.env",
               "ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest"]
    }
  }
}
```

Then ask: *"Show me the overall health of the device farm."*

---

## Table of Contents

- [Quick Start](#quick-start)
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
- [Example Prompts](#example-prompts)
- [Capabilities](#capabilities) — full per-tool reference in [docs/tools.md](docs/tools.md)
- [Workflow Reference](#workflow-reference)
  - [POC Lifecycle](#poc-lifecycle)
  - [Project Lifecycle](#project-lifecycle)
- [Boilerplate Generation](#boilerplate-generation)
  - [Recommended agent guardrails](docs/recommended-agent-guardrails.md)
- [Reference](#reference)
  - [Response Format](#response-format)
  - [Understanding maxResults](#understanding-maxresults)
  - [List Filters & Sorting](#list-filters--sorting)
  - [Test Reporting Schema](#test-reporting-schema)
- [Safety Guards](#safety-guards)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

---

## Prerequisites

- **Docker** — required to run the server
- **Node.js 22+** — required only if building from source (see Installation, Option B)
- **GitHub org membership** — required to pull the pre-built image from GHCR (see Installation, Option A)
- **Digital.ai Continuous Testing account** with a valid access key

---

## Access Keys

Your Digital.ai access key determines what the MCP server can do on your behalf. There are three access levels.

| Access level | Key format | Access |
|---|---|---|
| **Cloud Admin** | `eyJ…` (long base-64 string) | All tools: device management, user provisioning, project administration, infrastructure, performance data |
| **Project Admin** | `aut_1_…` | Scoped to one project. Can manage device tags, view project admin settings, list users. v2 API tools (agents, regions, license data) return 403. |
| **Project User** | `aut_1_…` | Scoped to one project. Read/test operations only. Cannot manage tags, access admin settings, or delete reports. |

When a Cloud Admin tool is called with a project-level key, the MCP returns a plain-language error explaining what happened — and, if a Cloud Admin profile is configured, a ready-to-use `switch_environment(...)` command.

### Finding your key

1. Log in to the Digital.ai Continuous Testing portal
2. Click your **name or avatar** in the top-right corner
3. Select **Access Key**

The key shown is tied to the **project currently selected in the portal**. If you belong to multiple projects, each has a separate key.

### Using multiple keys

Configure named profiles in `.env` to switch contexts at runtime without editing files:

```
# Default connection (typically Cloud Admin credentials)
DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com
DIGITAL_AI_ACCESS_KEY=eyJ...your-cloud-admin-key...

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
| `DIGITAL_AI_ACCESS_KEY` | ✅ | — | Access key — see [Access Keys](#access-keys) for the three access levels and key formats |
| `MCP_SERVER_NAME` | Optional | `digital-ai-testing-mcp` | Server identity shown in the AI client |
| `MCP_SERVER_VERSION` | Optional | version from `package.json` | Override the reported server version (rarely needed) |
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
# macOS / Linux
claude mcp add digital-ai-testing -- docker run --rm -i --env-file /absolute/path/to/.env ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest

# Windows (use forward slashes — backslashes are stripped by Claude Code)
claude mcp add digital-ai-testing -- docker run --rm -i --env-file C:/projects/digital-ai-testing-mcp/.env ghcr.io/dai-continuous-testing/digital-ai-testing-mcp:latest
```

> **Windows users:** Always use forward slashes (`C:/path/to/.env`), never backslashes — regardless of whether you register via the CLI command above or through the Claude Code panel (**Settings → MCP Servers**). Backslashes are silently stripped when Claude Code writes the configuration to `~/.claude.json`, resulting in a broken path and a cryptic `-32000` reconnection error.

This stores the server configuration in `~/.claude.json` scoped to the current project. Alternatively, use the Claude Code panel: **Settings → MCP Servers** and add the same Docker command used for Claude Desktop (using forward slashes for the path on Windows).

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

## Example Prompts

Once connected, talk to the server in plain language — no tool names needed:

- *"Show me the overall health of the device farm — how many devices are available, reserved, and offline?"*
- *"Find an available Android phone running at least version 13 in the US2 region"*
- *"Did all tests in the QA project pass today? I need a go/no-go for the release."*
- *"Install the latest build of com.mycompany.app on all available Android devices"*
- *"Find an available Android phone, then generate a Java JUnit5 test boilerplate"*
- *"Show the pass/fail breakdown by OS — are Android and iOS failing at different rates?"*
- *"Did the latest release introduce a CPU regression? Compare version 10553 vs 10554 on Android."*
- *"Set up a new POC for Acme Corp — 6 devices in US2, 3 iOS and 3 Android, through August 31st"*

**[→ docs/examples.md](docs/examples.md)** has 200+ prompts organized by scenario: farm health, device groups, regression sign-off, test analytics, performance, interactive inspection, POC lifecycle, and more.

---

## Capabilities

170 tools across 24 capability domains. The complete per-tool reference — descriptions, filters, auth requirements, and usage notes — lives in **[docs/tools.md](docs/tools.md)**.

| Domain | Tools | Highlights |
|---|---|---|
| [Devices](docs/tools.md#devices) | 18 | List/query devices, find available, release, reboot, tags, Mobile Studio |
| [Device Groups](docs/tools.md#device-groups) | 9 | Create groups, move devices, control project access |
| [Reservations](docs/tools.md#reservations) | 5 | Reserve devices, check availability windows |
| [Applications](docs/tools.md#applications) | 14 | Upload, generate local upload command, install/uninstall, find the latest build |
| [Repository](docs/tools.md#repository) | 6 | Test-data file storage |
| [Browsers](docs/tools.md#browsers) | 3 | Selenium browser sessions |
| [Users](docs/tools.md#users) | 8 | Account provisioning, project assignment, tags |
| [Projects](docs/tools.md#projects) | 17 | Create/configure projects, settings, app assignment |
| [Provisioning Profiles](docs/tools.md#provisioning-profiles) | 5 | iOS signing profile lifecycle |
| [Backup](docs/tools.md#backup) | 1 | Trigger a system backup |
| [Health & Diagnostics](docs/tools.md#health--diagnostics) | 11 | Farm health, readiness checks, license utilization |
| [Coverage Analytics](docs/tools.md#coverage-analytics) | 2 | Tested-vs-available device gap analysis |
| [Reporting](docs/tools.md#reporting) | 17 | Search/filter test reports, stability, trends, cleanup |
| [Test Views](docs/tools.md#test-views) | 7 | Dashboard view groups |
| [Transactions & Performance](docs/tools.md#transactions--performance) | 4 | CPU/memory/battery/Speed Index analytics *(Cloud Admin)* |
| [Agents](docs/tools.md#agents) | 2 | Host machine status *(Cloud Admin)* |
| [Regions](docs/tools.md#regions) | 2 | Region status and infrastructure topology *(Cloud Admin)* |
| [NV Servers](docs/tools.md#nv-servers) | 2 | Network Virtualization servers *(Cloud Admin)* |
| [Environment Management](docs/tools.md#environment-management) | 2 | Named connection profiles, runtime switching |
| [Workflows](docs/tools.md#workflows) | 6 | POC and project lifecycle orchestration |
| [Boilerplate Generation](docs/tools.md#boilerplate-generation) | 2 | Ready-to-run Appium test scripts in 4 languages; validate scripts before delivery |
| [Remote Debug](docs/tools.md#remote-debug) | 1 | Connect a cloud device as a local ADB device |
| [Inspection Sessions](docs/tools.md#inspection-sessions) | 22 | AI-driven live device interaction — screenshots, element discovery, full gesture set, keys, app/device control |
| [Performance Comparison](docs/tools.md#performance-comparison) | 4 | Two-set Speed Index comparison with confound detection, MAD outlier exclusion, and fresh-sample generation *(Cloud Admin)* |
| [Resources & Prompts](docs/tools.md#resources--prompts) | — | 2 ambient resources, 5 guided prompts |

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
6. Create (or reuse) a project; record the Salesforce URL and end date in project notes
7. Remove devices from the Default group — done only after the project exists, so a project-creation failure never strands devices
8. Locate the Default project
9. Create users, assign to the POC project, remove from Default, and tag each account with the POC tag. Cloud Admin access is never granted through this workflow.
10. Assign ExperiBank (or a specified app) to the POC project — falls back to the latest available version if the exact version is not found

If any step fails, the workflow stops, reports which steps completed with all created resource IDs, and offers resume (re-invoke — existing resources are detected and reused) or unwind (`delete_poc`) paths.

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

Steps 1 and 6 check for an existing group/project by name before creating — safe to re-run after a partial failure.

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

Performs the same wind-down as `close_poc`, then permanently deletes the device group and the project. Requires `confirmDeletion: true`.

Before any destructive action, the workflow gathers a full inventory (project ID, group ID, device list, user breakdown) and presents it for explicit confirmation. Unlike `close_poc`, user processing is batch-confirmed via this upfront inventory rather than per-user prompts.

**Best practice:** Run `close_poc` first — it winds down the POC while preserving the project and device group. Note that `close_poc` is not fully reversible: device moves and tag removal can be undone, but it permanently deletes POC-only user accounts (each deletion requires per-user operator confirmation). Use `delete_poc` only once the project data is confirmed no longer needed. Calling `delete_poc` without `confirmDeletion: true` returns a safe explanation and suggests `close_poc` as the alternative.

---

### Project Lifecycle

Three tools mirror the POC lifecycle for general project management. They apply the same multi-project user protection rules: users who belong to other projects are revoked from this project only, never deleted from the platform.

#### `setup_project` — Provision a new project environment

At the start, the workflow asks whether to create a **simple** project record only, or a **full** environment (device group, device allocation, user provisioning, app assignment).

Full setup steps:

1. Create (or reuse) the project with the specified name and automation type; record the memo in project notes
2. Create (or reuse) a device group and link it to the project
3. Pre-flight check that the target app exists in the repository
4. Select available devices matching the target OS and region — presented to the operator for confirmation
5. Add the selected devices to the project group
6. Tag each device with a project-derived tag
7. Remove devices from other groups — only when `isolateDevices: true`; by default existing group links (including Default) are kept intact
8. Create users, assign them to the project with the specified roles, remove them from Default, and tag each account
9. Assign the specified application to the project

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
2. List the devices in the project group
3. Remove the project-derived tag from each device
4. Return devices to the Default group
5. Process users: **delete accounts with no other project memberships; revoke project access only for multi-project users** (each action individually confirmed by the operator)

Only `projectName` is required. Active sessions and installed apps on the devices are not touched — release sessions with `release_orphaned_sessions` and remove apps with `uninstall_application` separately if needed.

---

#### `teardown_project` — Full project deletion

Performs all `close_project_resources` steps, then permanently deletes the device group and the project. Requires `confirmDeletion: true`.

The workflow presents a full inventory summary before any irreversible action. The same multi-project user protection applies.

**Best practice:** Run `close_project_resources` first, then confirm the project is no longer needed before calling `teardown_project`.

---

## Boilerplate Generation

### Two ways to create a test

The server supports two test-creation modes, and the agent is instructed to route between them based on context:

| | **Autonomous** (`get_test_boilerplate`) | **Interactive** (`start_inspection_session` / `collaborative_test_creation` prompt) |
|---|---|---|
| **When** | Intent is specific — a standardized flow ("create a login test") or step-level detail — AND selectors are derivable (app source in the workspace, or a prior inspection session) | Request is vague ("I want a test for app X"), no source access (chat-only, or IDE without this app's code), or the user wants to watch/drive on a live device |
| **User involvement** | None required — the agent writes the test from boilerplate + source knowledge + best practices | Collaborative — the agent shares a live device view URL and builds the test step by step with the user |
| **Output** | In an IDE: a local test automation project. Chat-only: portable project files presented inline | Same, plus selectors verified against the real app along the way |

**Hybrid is often best:** even in autonomous mode, the agent can open a short inspection session — no user involvement — to capture or verify element IDs against the real build. This matters because source code is only authoritative for classic static IDs (Android View XML, explicit iOS `accessibilityIdentifier`); Jetpack Compose, SwiftUI, Flutter, and React Native apps often expose no source-derivable IDs, and the build on the farm can lag the workspace source. The agent is explicitly instructed to **never fabricate selectors** — when in doubt it verifies live, and when the mode itself is ambiguous it asks: *"Want me to create this test for you based on best practices, or start an interactive session where we build it together?"*

> **Stronger guarantees:** the server ships this routing policy automatically in its MCP `instructions`, and `get_test_boilerplate` structurally refuses to emit code for a real app without verified selectors. Because not every client surfaces server `instructions` — and no MCP server can intercept a file an agent writes by hand — you can install a client-side reinforcement for a stronger, client-independent guarantee. See **[Recommended agent guardrails](docs/recommended-agent-guardrails.md)**.

### `get_test_boilerplate`

Generates a complete, pre-configured Appium test script. The Digital.ai server URL and access key are pre-filled from the active connection profile — switch profiles with `switch_environment` first to generate scripts carrying a project-scoped key instead of your admin key.

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
| `region` | Region code from `find_available_device` response (e.g. `US2`, `SG1`) | _(optional, strongly recommended)_ |
| `projectType` | `standalone-gradle` \| `standalone-maven` \| `android-gradle-submodule` | `standalone-gradle` |
| `includePerformanceTransactions` | `true` \| `false` | `false` |
| `includeAxeScan` | `true` \| `false` | `false` |
| `confirmSelectorsVerified` | `true` \| `false` | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

> **Inspection gate (v42):** when you target a real app (`appId`/`packageName`/`bundleIdentifier`), this tool returns **no code** and a structured `{ status: "blocked", reason: "no_verified_selectors" }` error UNLESS a live inspection session exists in the MCP process, or you set `confirmSelectorsVerified: true` (escape hatch for selectors already captured via rdb/UIAutomator, `open_mobile_studio`, or authoritative source). The built-in ExperiBank demo (no app identifiers) is never gated. This makes it structurally impossible to receive a placeholder scaffold and pass it off as a finished test.

**Recommended workflow** for building a new test:

1. `get_application_info` — confirm package name, launch activity, and app ID
2. `get_test_boilerplate` — generate starter test with capabilities pre-filled (this step)
3. `open_mobile_studio` or `get_automation_properties` — inspect live element IDs (no ADB required)
4. `release_orphaned_sessions(maxAgeHours=4, dryRun=true)` — pre-flight device check
5. `find_available_device` — select a healthy device and read its `region`
6. Write/run the test
7. `release_device` — explicit cleanup

**Performance transactions:** Pass `includePerformanceTransactions: true` to bracket the test body with `startPerformanceTransaction` / `endPerformanceTransaction` calls. The start arg is the NV network profile (defaults to `"Monitor"` — observe without throttling); the end arg is the transaction name. The platform records CPU, memory, battery, and Speed Index metrics; results appear in the reporter Transactions tab (~1 min after `endPerformanceTransaction`) and are queryable via `list_transactions`. Pre-requisite: an NV server must be ONLINE and tunnel-connected in the device region (`list_nv_servers`). Note: a throttling profile activates NV shaping immediately; `"Monitor"` is pass-through and carries no ANR risk.

**Accessibility scanning:** Pass `includeAxeScan: true` to inject a Deque Axe DevTools Mobile accessibility scan (`mobile: axeScan` executeScript call). Sets the required `appium:automationName` capability automatically (`AxeUiAutomator2` for Android, `AxeXCUITest` for iOS). Requires `AXE_DEVTOOLS_API_KEY` in the MCP environment.

Both flags can be combined — the Axe scan runs inside the performance transaction boundary.

**Element locators:** Use `open_mobile_studio` first — it is the platform's native UI Inspector and requires no local tooling. For scenarios requiring direct ADB access (file push, shell commands), use `get_remote_debug_command` to connect the device locally.

> ⚠️ The generated script is an **end-product artifact** — do not execute it as a discovery step. Running it without known element selectors creates Incomplete sessions visible to the whole team. Discover selectors with `open_mobile_studio` first.

### `validate_test_script`

Delivery backstop (v43) for the case the `get_test_boilerplate` gate cannot catch — a test written by hand with guessed selectors. Pass the full `scriptContent` before presenting or saving any test; it scans for unreplaced `<…>` placeholder selectors, the deliberate scaffold fail-guard, placeholder/fabricated credentials, and resource IDs from a known prior fabrication incident. Returns `isError` with a `fail` verdict when any high-severity pattern is found, so a non-functional test cannot be delivered as finished. A `pass` is necessary but not sufficient — it confirms obvious placeholders are gone, not that selectors are real; a live inspection remains the authoritative source.

| Parameter | Values | Default |
|---|---|---|
| `scriptContent` | The full test script text | _(required)_ |
| `fileName` | Label for the result | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

`projectType` controls the Java output layout only (ignored for Node.js and Python): `standalone-gradle` produces `src/test/java/` with both `build.gradle` and `pom.xml`; `standalone-maven` produces `pom.xml` only; `android-gradle-submodule` scopes files under `e2e-tests/` for embedding in an existing Android Studio project.

**Files generated per language:**

| Language | Files |
|---|---|
| `java-junit5` / `java-testng` | `AndroidNative.java` or `iOSNative.java` + `build.gradle` + `pom.xml` |
| `nodejs` | `wdio.conf.js` + test file + setup shell steps |
| `python` | Test file + `requirements.txt` |

All boilerplate defaults to the ExperiBank demo app as the starting point. ExperiBank is available on most farm devices and can verify connectivity before switching to your own app.

---

## Performance Comparison Reports

Compare performance (Speed Index, CPU, memory, battery, duration) between two sets of conditions — app v1 vs v2, device A vs device B, OS version X vs Y, region to region, two network profiles, or two automation scripts. Works with all access levels — Cloud Admin sees all projects; project-level keys (Project Admin and Project User) see only their own project's transactions.

The headline metric is reported three ways every time — **trimmed mean, median, and raw mean** — so a small or noisy sample can't hide behind a single number.

| Tool | Purpose |
|---|---|
| `compare_performance_transactions` | Two-set comparison; trimmed-mean/median/mean per side + delta and % change. MAD outliers excluded by default (≥4 samples/side). Pass `comparisonAxis` to embed a confound check. |
| `assess_comparison_confounds` | Verdict — **clean / caveated / confounded** — by flagging any dimension other than the declared axis (device model, OS, OS version, network profile, project, transaction name) that varies across or within the sides, plus missing telemetry and sample imbalance. |
| `detect_performance_outliers` | Robust median/MAD outlier flagging on a single set; returns the kept set and recommended exclusions/re-runs. |
| `performance_transaction_control` | Phase 2: generate fresh samples inside an inspection session — `start` (with an NV profile) → run the verified flow → `end` (names the record). Records appear in the reporter ~1 min later. |

> **Why the confound check matters:** comparing transactions 1894 (Speed Index 1015) and 1895 (1000) looks like a 1.5% version delta — but they ran on *different device models, different OS versions, and different projects*, and 1894 has no CPU/memory telemetry. `assess_comparison_confounds` returns **confounded** and names all three, so the delta is never misread as a version regression.

The **`performance_comparison_report` prompt** orchestrates the full workflow end to end: define the axis → scrub confounds → negotiate sample size → **require explicit plan confirmation with a time estimate** → run the series with outlier-driven re-runs → report the delta with root-cause reasoning. True host/background interference is not directly observable; the report approximates device quietness (idle, healthy status, no concurrent reservation) and states that limit explicitly.

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

## Safety Guards

All destructive operations require `confirmDeletion: true`. Without it:

> ⚠️ Safety guard triggered. "Delete user 42" is a destructive operation that cannot be undone. Include `confirmDeletion: true` to proceed. No changes were made.

The first call describes exactly what will be deleted. The second call — with `confirmDeletion: true` — executes. This prevents accidental data loss when an AI assistant misinterprets intent.

Two further guards run before any request leaves the server:

- **Auth pre-flight:** report-deletion tools (`delete_test_reports*`, `cleanup_inspection_sessions`) check the active key type first and return a clear "switch to a Cloud Admin profile" message instead of an opaque CSRF 401 when called with a project-level key.
- **Upload path validation:** tools that read local files for upload refuse relative paths, path traversal, and credential-file names (`.env*`, SSH private keys) — a misdirected request cannot publish secrets to the cloud repository.

---

## Development

```bash
npm install
npm run build    # compile TypeScript to dist/
npm run dev      # nodemon + ts-node for live reload
```

**Running tests** — most suites require a live `.env` with valid credentials and call the real Digital.ai API. The exception is `test:tools`, which exercises registered tool handlers (guards, auth gates, path validation) through an in-memory MCP transport with no live API access:

```bash
npm run test                  # all tests
npm run test:tools            # tool-layer guard/gate regression tests (offline)
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

## Troubleshooting

### Common symptoms

| Symptom | Cause | Fix |
|---|---|---|
| `403 Forbidden` on admin tools (agents, regions, license) | Active profile is a project-level key — v2 endpoints require Cloud Admin access | Ask Claude: *"switch to my Cloud Admin profile"* — it will call `list_environments` and pick the right one |
| Report delete tools return "Cloud Admin access required" | Reporter mutation endpoints are CSRF-blocked for project-level keys (Project Admin and Project User) | Switch to a Cloud Admin profile, re-run, switch back |
| `install_application` returns 400 on a device you can see | Device is reserved via an rdb (remote debug) session | Install **first**, then run `get_remote_debug_command` — not the other way around |
| `install_application` returns 400 (no rdb involved) | App not assigned to a project containing the target device | Call `assign_app_to_project` first |
| Repeatable `NoSuchElementException` while sibling tests pass | Device health, not test code — device stuck in a wrong state or offline-but-pooled | Run `get_device_health_summary`; scope the deviceQuery with `@region='<healthy-region>'` |
| Tests missing from `list_test_reports` results | Project has its own reporter instance — unscoped queries search the default scope | Pass `projectName` (exact name from `list_projects`) |
| rdb fails: `validation error / Failed to reserve device` | Project-level key resolved an internal device ID instead of the real serial | Ask Claude: *"switch to Cloud Admin"* → regenerate the rdb script → switch back |
| Device query returns nothing for `@manufacturer` / `@tag` | These fields are silently ignored server-side | Use the `manufacturer`/`tags` parameters on `find_available_device` — they filter client-side |

### `Failed to reconnect to digital-ai-testing: -32000`

On Windows this usually means the `--env-file` path was stored with backslashes stripped. Open `~/.claude.json`, find the `mcpServers` entry for this project, and check that the env file path looks correct (e.g. `C:/projects/digital-ai-testing-mcp/.env`). If it shows something like `C:projectsdigital-ai-testing-mcp.env`, the backslashes were eaten. Fix the path in the file directly (use forward slashes), then run `/mcp` in Claude Code to reconnect.

### Workflow tools failing?

Run this sequence:

```
1. get_server_info           — confirm tool count (expect 169) and active profile
2. check_workflow_readiness  — which dependency tools are present or missing
3. check_connectivity        — confirm the backend API is reachable
```

`check_workflow_readiness` returns a structured report:

```json
{
  "allWorkflowsReady": true,
  "registeredToolCount": 169,
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

The server also logs a readiness check at startup (visible in Docker logs): `Workflow readiness: all workflows ready ✓`, or `⚠️ DEGRADED: create_poc — missing: ...` when tools are absent.

---

## Known Limitations

The four most commonly encountered:

1. **No API to trigger Appium test execution.** Tests launch from Appium clients (IDE, CI scripts). The server manages devices, apps, reservations, and results — it cannot start an Appium session itself. (Interactive [inspection sessions](docs/tools.md#inspection-sessions) are the exception: live WebDriver sessions for element discovery on both Android and iOS.)
2. **Inspection sessions support Android and iOS** on both the legacy Appium Grid (JWP) and Appium Server (W3C/OSS) projects. iOS caveats: no clear-app-data, no clipboard on Grid devices, and back navigation uses the nav-bar button (iOS has no Back button).
3. **No user disable/lock endpoint.** Removing access for a user provisioned solely for a POC means deleting the account — which is why `close_poc` requires per-user confirmation.
4. **Reporter API restrictions for project-level keys** — server-side sort and report deletion require Cloud Admin access. Tools compensate automatically (client-side sorting, clear pre-flight errors), at the cost of slower full-scan queries under project-level keys.

See [docs/limitations.md](docs/limitations.md) for the full list of 14.
