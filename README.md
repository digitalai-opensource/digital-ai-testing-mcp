<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/images/dai-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/images/dai-logo-light.svg">
  <img alt="Digital.ai Testing MCP Server" src=".github/images/dai-logo-light.svg" width="600">
</picture>

# Digital.ai Testing — MCP Server

Talk to your Digital.ai Testing device farm from your AI assistant. This MCP (Model Context Protocol) server connects AI clients such as Claude, GitHub Copilot and Cursor to Digital.ai Testing, so you can ask in plain language to find devices, install apps, explore an app on a real device, generate tests, run test suites, investigate failures and compare performance.

It provides **210 tools**, **2 resources** and **7 prompts** across 27 capability areas: device management, test execution (including Espresso, XCUITest and Maestro test runs), app lifecycle, reporting and root-cause analysis, analytics, performance, project administration, interactive mobile inspection, interactive browser inspection, and more.

---

## Quick Start

**1. Check that Node.js 22 or later is installed** (npm comes with it). If it isn't, install the LTS version from https://nodejs.org first.

```bash
node --version
npm --version
```

**2. Install the MCP server.**

```bash
npm install -g digital-ai-testing-mcp
```

**3. Add it to your AI client** with your tenant URL and [access key](#access-keys). Claude Desktop is shown here; see [Connecting AI Clients](#connecting-ai-clients) for VS Code, JetBrains, Copilot and Cursor.

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "digital-ai-testing-mcp",
      "args": [],
      "env": {
        "DIGITAL_AI_BASE_URL": "https://your-tenant.experitest.com",
        "DIGITAL_AI_ACCESS_KEY": "your-access-key",
        "MCP_DEPLOYMENT_MODE": "local"
      }
    }
  }
}
```

**4. Restart the client and ask:** *"Show me the overall health of the device farm."*

> Prefer a container? See [Option B — Pull from GitHub Container Registry](#option-b--pull-from-github-container-registry).

---

## Table of Contents

**Get started**
- [Quick Start](#quick-start)
- [Installation](#installation) — [npm](#option-a--install-via-npm-recommended) · [Docker image](#option-b--pull-from-github-container-registry) · [from source](#option-c--build-from-source) · [Upgrading](#upgrading)
- [Connecting AI Clients](#connecting-ai-clients) — [Claude Desktop](#claude-desktop) · [Claude Code (VS Code)](#claude-code-vs-code) · [Claude Code (JetBrains)](#claude-code-jetbrains--android-studio) · [GitHub Copilot](#github-copilot-vs-code) · [Cursor](#cursor) · [Docker configs](#docker-client-configuration)
- [Access Keys](#access-keys) — access levels, finding your key, multiple profiles
- [Configuration](#configuration) — [Toolsets](#toolsets-reducing-context-size) · [Debug mode](#debug-mode-remediation-notes)

**Use it**
- [What You Can Do](#what-you-can-do) — [example prompts](#example-prompts) · [tasks at a glance](#tasks-at-a-glance) · [all capability areas](#all-capability-areas)
- [Creating Tests](#creating-tests) — [mobile](#mobile-app-tests-get_test_boilerplate) · [Test Orchestrator](#test-orchestrator-default-for-java-on-appium-server) · [web](#web-tests-get_web_test_boilerplate) · [validating a test](#check-a-test-before-you-deliver-it-validate_test_script)
- [Test Results and Root Cause Analysis](#test-results-and-root-cause-analysis)
- [Performance Comparison Reports](#performance-comparison-reports)
- [Workflow Reference](#workflow-reference) — [POC lifecycle](#poc-lifecycle) · [Project lifecycle](#project-lifecycle)
- [Safety Guards](#safety-guards)

**Help and reference**
- [Troubleshooting](#troubleshooting)
- [Reference](#reference) — [response format](#response-format) · [maxResults](#understanding-maxresults) · [list filters](#list-filters--sorting) · [local file transfer (Docker)](#local-file-transfer-docker--remote-deployments-only)
- [Known Limitations](#known-limitations)
- [Development](#development)
- [License](#license)

---

## Installation

**What you need:**

- A **Digital.ai Testing account** with a valid [access key](#access-keys).
- **Node.js 22+** for [Option A](#option-a--install-via-npm-recommended) (recommended — no Docker needed), **or**
- **Docker** for [Option B](#option-b--pull-from-github-container-registry) or [Option C](#option-c--build-from-source) (container-based install).

### Option A — Install via npm (Recommended)

No Docker required — the server runs directly under Node.js.

```bash
npm install -g digital-ai-testing-mcp
```

This puts a `digital-ai-testing-mcp` command on your `PATH`. Use it as the `"command"` in your [AI client configuration](#connecting-ai-clients). You don't need an image name or a `.env` file: settings go in the client's `env` block (see [Configuration](#configuration)).

To run without a global install, use `"command": "npx"` with `"args": ["-y", "digital-ai-testing-mcp"]` instead — npx downloads and runs the latest published version.

Set `MCP_DEPLOYMENT_MODE=local` alongside your credentials (the client examples below already include it). It tells the server that its filesystem is your own machine, so tool descriptions and a few upload/download behaviors drop the Docker-specific caveats and path warnings.

### Option B — Pull from GitHub Container Registry

No cloning or building required. Use this if you'd rather run the server in a container than install it with npm.

**Step 1 — Pull the image**

```bash
docker pull ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest
```

**Step 2 — Set up your `.env`**

```bash
curl -O https://raw.githubusercontent.com/digitalai-opensource/digital-ai-testing-mcp/main/.env.example
cp .env.example .env
# Edit .env — set DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY
```

**Step 3 — Connect your client** using `ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest` as the image name — see [Docker client configuration](#docker-client-configuration).

> Images are published when a GitHub Release is created — not on every commit. Each release is also tagged with its version (e.g. `2.0.3` and `2.0`) if you want to pin one. If `latest` is not available yet, use [Option C](#option-c--build-from-source) to build from source.

With Docker, tools that read or write local files work inside the container, not on your machine — see [Local File Transfer](#local-file-transfer-docker--remote-deployments-only).

### Option C — Build from source

Needed only for local development or to modify the server.

```bash
git clone https://github.com/digitalai-opensource/digital-ai-testing-mcp
cd digital-ai-testing-mcp
cp .env.example .env
# Edit .env — set DIGITAL_AI_BASE_URL and DIGITAL_AI_ACCESS_KEY
docker build -t digital-ai-testing-mcp:latest .
```

Use `digital-ai-testing-mcp:latest` as the image name in your [Docker client configuration](#docker-client-configuration).

### Upgrading

| Install | Upgrade command | Then |
|---|---|---|
| npm (Option A) | `npm install -g digital-ai-testing-mcp@latest` | Restart your AI client, or reconnect the MCP server from its settings panel. Installing a new version doesn't affect a server that is already running. |
| GHCR image (Option B) | `docker pull ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest` | Nothing to stop or remove: the client configs start the server with `docker run --rm`, so the next start uses the new image. |
| From source (Option C) | `git pull` then `docker build -t digital-ai-testing-mcp:latest .` | Same as Option B. |

To confirm the upgrade, ask your AI to call `get_server_info`, which reports the running version.

[↑ Back to top](#table-of-contents)

---

## Connecting AI Clients

The examples below use the npm install ([Option A](#option-a--install-via-npm-recommended)): credentials go directly in the client's `env` block. If you run the server in Docker (Options B/C), use the [Docker client configuration](#docker-client-configuration) instead.

### Claude Desktop

Find your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** Open Claude Desktop → Settings → Developer → **Edit Config** (the path varies by install method — Windows Store vs. direct installer)

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "digital-ai-testing-mcp",
      "args": [],
      "env": {
        "DIGITAL_AI_BASE_URL": "https://your-tenant.experitest.com",
        "DIGITAL_AI_ACCESS_KEY": "your-access-key",
        "MCP_DEPLOYMENT_MODE": "local"
      }
    }
  }
}
```

Restart Claude Desktop after editing — the tools appear automatically.

### Claude Code (VS Code)

1. Open the Claude Code extension panel
2. Go to **Settings → MCP Servers**
3. Add a new server with command `digital-ai-testing-mcp`, no args, and `DIGITAL_AI_BASE_URL`/`DIGITAL_AI_ACCESS_KEY`/`MCP_DEPLOYMENT_MODE=local` set in the server's environment variables

Using Docker? Add the Docker command from [Docker client configuration](#docker-client-configuration) instead.

### Claude Code (JetBrains / Android Studio)

Install the [Claude Code](https://plugins.jetbrains.com/plugin/22828-claude-code) plugin from the JetBrains Marketplace, then open your project and run this command from the project root:

```bash
claude mcp add digital-ai-testing --env DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com --env DIGITAL_AI_ACCESS_KEY=your-access-key --env MCP_DEPLOYMENT_MODE=local -- digital-ai-testing-mcp
```

This stores the server configuration in `~/.claude.json`, scoped to the current project. Alternatively, use the Claude Code panel: **Settings → MCP Servers** and add the same command used for [Claude Desktop](#claude-desktop).

Restart the Claude Code panel after adding the server — the tools appear automatically.

Using Docker? See [Docker client configuration](#docker-client-configuration) — and on Windows, use forward slashes in the `.env` path.

### GitHub Copilot (VS Code)

GitHub Copilot supports MCP tools in **Agent mode** only. Register the server in one of two scopes:

- **User settings** — available in all workspaces. Open the user MCP configuration (`Ctrl+Shift+P` → "MCP: Open User Configuration") and add the same `servers` entry shown for the workspace file below. (Older VS Code versions used an `"mcp": { "servers": { … } }` block in the user `settings.json` instead.)
- **Workspace settings** — scoped to one project. Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "digital-ai-testing": {
      "command": "digital-ai-testing-mcp",
      "args": [],
      "env": {
        "DIGITAL_AI_BASE_URL": "https://your-tenant.experitest.com",
        "DIGITAL_AI_ACCESS_KEY": "your-access-key",
        "MCP_DEPLOYMENT_MODE": "local"
      }
    }
  }
}
```

Committing `.vscode/mcp.json` to source control shares the server configuration with the entire team automatically.

To use the tools: open Copilot Chat (`Ctrl+Alt+I`), switch the mode dropdown to **Agent**, and type your request.

> GitHub Copilot on the web (`github.com/copilot`) does not support external MCP servers. VS Code is required.

Using Docker? See [Docker client configuration](#docker-client-configuration).

### Cursor

Cursor supports MCP in **Agent mode**. Add the server in **Cursor Settings → MCP** (or `Cursor Settings → Features → MCP`):

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "digital-ai-testing-mcp",
      "args": [],
      "env": {
        "DIGITAL_AI_BASE_URL": "https://your-tenant.experitest.com",
        "DIGITAL_AI_ACCESS_KEY": "your-access-key",
        "MCP_DEPLOYMENT_MODE": "local"
      }
    }
  }
}
```

Alternatively, create a `.cursor/mcp.json` file in your project root with the same `mcpServers` object — this scopes the server to that workspace and can be committed to share it with your team.

Cursor is available on macOS, Windows, and Linux. It is the recommended option for iOS developers on macOS, where Xcode is the primary IDE but does not natively support MCP.

Using Docker? See [Docker client configuration](#docker-client-configuration).

### Docker client configuration

For [Option B](#option-b--pull-from-github-container-registry) or [Option C](#option-c--build-from-source), the client starts the container instead of the `digital-ai-testing-mcp` command, and credentials come from your `.env` file. In every example:

- Replace `/ABSOLUTE/PATH/TO/.env` with the full path to your `.env` file.
- **Built from source (Option C)?** Replace `ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest` with `digital-ai-testing-mcp:latest`.

**Claude Desktop and Cursor** (`mcpServers` format):

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/ABSOLUTE/PATH/TO/.env",
        "ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest"
      ]
    }
  }
}
```

**GitHub Copilot** — in either configuration file, replace the `"digital-ai-testing"` entry's `command`/`args`/`env` with:

```json
{
  "command": "docker",
  "args": [
    "run", "--rm", "-i",
    "--env-file", "/ABSOLUTE/PATH/TO/.env",
    "ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest"
  ]
}
```

**Claude Code** (JetBrains / Android Studio, or VS Code) — from the project root, or add the same command under **Settings → MCP Servers**:

```bash
# macOS / Linux
claude mcp add digital-ai-testing -- docker run --rm -i --env-file /absolute/path/to/.env ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest

# Windows (use forward slashes — backslashes are stripped by Claude Code)
claude mcp add digital-ai-testing -- docker run --rm -i --env-file C:/projects/digital-ai-testing-mcp/.env ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest
```

> **Windows users on Docker:** always use forward slashes (`C:/path/to/.env`), never backslashes — whether you register via the CLI command above or through the Claude Code panel. Claude Code silently strips backslashes when it writes the configuration to `~/.claude.json`, which breaks the path and causes a cryptic `-32000` reconnection error ([how to fix it](#failed-to-reconnect-to-digital-ai-testing--32000)).

[↑ Back to top](#table-of-contents)

---

## Access Keys

Your Digital.ai access key decides what the MCP server can do on your behalf. There are three access levels:

| Access level | What it can do |
|---|---|
| **Cloud Admin** | All tools: device management, user provisioning, project administration, infrastructure, performance data |
| **Project Admin** | Scoped to one project. Everything a Project User can do, plus: manage device tags, create reservations, set project notes, view project admin settings, list its own project's users. v2 API tools (agents, regions, license data, usage reports) return 403. |
| **Project User** | Scoped to one project. Day-to-day testing: devices, app upload/install, reserving devices for itself, test runs, reports, test views, performance data, and inspection sessions. Cannot manage tags or access admin settings; deleting reports requires the project's `allowUsersDeleteTests` setting. |

> **You can't tell the access level from the key's format.** Older keys are long `eyJ…` tokens; since Digital.ai 24.11, newly generated keys use a shorter `aut_1_…` token — for Cloud Admins too. So the server asks the API for your role (`GET /api/v1/users/my-account-info` → `Admin` / `ProjectAdmin` / `User`) and never guesses from the key's prefix. `get_server_info` shows the level detected for the active profile, and `list_environments` shows it for every profile. Per-tool role requirements are in [docs/tools.md](docs/tools.md).

If you call a Cloud Admin tool with a project-level role, the server returns a plain-language explanation — and, if a Cloud Admin profile is configured, a ready-to-use `switch_environment(...)` command.

### Finding your key

1. Log in to the Digital.ai Testing portal
2. Click your **name or avatar** in the top-right corner
3. Select **Access Key**

The key shown is tied to the **project currently selected in the portal**. If you belong to multiple projects, each has a separate key.

### Using multiple keys

Set up named profiles to switch between keys (for example, Cloud Admin and a project) without editing files. With the npm install, add the variables to the `env` block of your AI client's configuration; with Docker, add them to your `.env` file:

```
# Default connection (typically Cloud Admin credentials — either key format works)
DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com
DIGITAL_AI_ACCESS_KEY=...your-cloud-admin-key...

# Project-scoped profiles
DAI_PROFILE_QA_URL=https://your-tenant.experitest.com
DAI_PROFILE_QA_KEY=...your-qa-key...

DAI_PROFILE_STAGING_URL=https://your-tenant.experitest.com
DAI_PROFILE_STAGING_KEY=...your-staging-key...
```

Then ask your AI:
- *"What environments are configured?"* → `list_environments`
- *"Switch to QA"* → `switch_environment("qa")`
- *"Switch back to Cloud Admin"* → `switch_environment("cloud admin")` (a role alias — resolves to whichever profile the API reports as Cloud Admin, even if it is not the one named `default`)

The switch takes effect immediately — no restart needed.

> **Security:** Never commit `.env` to source control. Each team member should use their own key, obtained from the portal under their own account.

[↑ Back to top](#table-of-contents)

---

## Configuration

Set these as environment variables: in the client's `env` block (npm install) or in your `.env` file (Docker).

| Variable | Required | Default | Description |
|---|---|---|---|
| `DIGITAL_AI_BASE_URL` | ✅ | — | Your Digital.ai tenant URL |
| `DIGITAL_AI_ACCESS_KEY` | ✅ | — | Access key — see [Access Keys](#access-keys) for the three access levels and key formats |
| `MCP_DEPLOYMENT_MODE` | Optional | `docker` | `docker` (default) or `local`. Set `local` when running via the npm package ([Option A](#option-a--install-via-npm-recommended)) so tool descriptions and upload/download behavior reflect that the server's filesystem is your own machine, not a container's |
| `MCP_TOOLSETS` | Optional | all | Comma-separated toolsets to load in full: `devices`, `apps`, `reporting`, `performance`, `inspection`, `authoring`, `browsers`, `admin` (or `all`, or `core` for only the always-loaded core). See [Toolsets](#toolsets-reducing-context-size) |
| `MCP_DEBUG_MODE` | Optional | `false` | `true` records remediation notes and a tool-call event log to help improve this MCP. See [Debug mode](#debug-mode-remediation-notes) |
| `MCP_REMEDIATION_DIR` | Optional | — | Debug mode only: folder to write remediation files to (overrides project detection) |
| `REQUEST_TIMEOUT_MS` | Optional | `30000` | API request timeout in milliseconds |
| `UPLOAD_TIMEOUT_MS` | Optional | `120000` | File upload timeout in milliseconds |
| `INSPECTION_SESSION_TIMEOUT_MS` | Optional | `120000` (`240000` for `@emulator='true'` queries and automotive projection) | How long `start_inspection_session` waits for the platform to allocate a device. Emulators and simulators boot inside that request (an iOS simulator took 154 s live) |
| `USAGE_REPORT_TIMEOUT_MS` | Optional | `240000` | Wall-clock cap on one usage-report CSV fetch (`download_usage_report` / `summarize_usage_report`). An unfiltered month can be ~12 MB and take minutes to transfer; a fetch that outlives the cap returns an error that says how to narrow it |
| `ACCESS_PROBE_TIMEOUT_MS` | Optional | `8000` | Timeout for the access-level detection call |
| `AXE_DEVTOOLS_API_KEY` | Optional | — | Deque Axe DevTools Mobile key used by `includeAxeScan` boilerplate |
| `TEST_ORCHESTRATOR_JAR_URL` / `TEST_ORCHESTRATOR_JAR_SHA256` | Optional | pinned | Override the Test Orchestrator agent download location; both are required |
| `MCP_SERVER_NAME` | Optional | `digital-ai-testing-mcp` | Server identity shown in the AI client |
| `MCP_SERVER_VERSION` | Optional | version from `package.json` | Override the reported server version (rarely needed) |

Additional `DAI_PROFILE_{NAME}_URL` / `DAI_PROFILE_{NAME}_KEY` pairs configure named profiles for multi-project or multi-environment use. See [Using multiple keys](#using-multiple-keys) and `.env.example` for examples.

### Toolsets (reducing context size)

All 210 tool definitions together take up roughly 70K tokens of your AI's context. If your AI client is short on context — or runs several MCP servers — set `MCP_TOOLSETS` to the areas you use, e.g. `MCP_TOOLSETS=reporting` (about 26K tokens), `MCP_TOOLSETS=inspection,authoring` (about 34K), or `MCP_TOOLSETS=core` (about 17K — only the always-loaded core in full).

Nothing becomes unavailable. Tools outside the chosen toolsets are still listed, with a one-line description. When the AI calls one, the server loads that whole toolset and replies with the tool's full description and parameter guidance, then the AI calls it again — so it always sees the detailed usage guidance before the tool runs. That first call executes nothing (it is marked read-only for clients that honour tool annotations). The AI can also load toolsets up front with `enable_toolset`, whose reply lists a typed signature for every tool it loaded — so even a client that never refreshes its tool list has the exact parameter names and types. Leave `MCP_TOOLSETS` unset (the default) to load everything in full.

| Toolset | Covers |
|---|---|
| `devices` | Devices, device groups, reservations, health, agents, regions |
| `apps` | Application repository, file repository, provisioning profiles |
| `reporting` | Test reports, analytics, root-cause analysis, test views, coverage |
| `performance` | Performance transactions and comparisons, NV servers |
| `inspection` | Live device and browser inspection, Android Auto / CarPlay, remote debug |
| `authoring` | Test boilerplate, Espresso / XCUITest / Maestro test runs |
| `browsers` | Browser listing and Selenium sessions |
| `admin` | Users, projects, backups, usage reports, POC and project workflows |

Always loaded in full: environment and connection tools (`get_server_info`, `switch_environment`, …), `enable_toolset`, and `validate_test_script`.

### Debug mode (remediation notes)

Set `MCP_DEBUG_MODE=true` while evaluating or developing the MCP to collect feedback for improving it. With the default `false`, nothing changes.

When it is on:

- **The AI records notes.** The server asks the AI client to call `record_remediation_note` (a tool that exists only in debug mode) whenever it:
  - hits an unexpected error;
  - wastes calls because guidance was unclear;
  - is corrected or stopped by you;
  - gives up;
  - finds a better path than the one recommended;
  - spots a way to make things cleaner or cheaper.

  It records each note once the situation is resolved or abandoned, not in the middle of your task. Expected outcomes, such as deliberate negative tests or a safety check that worked as intended, are not recorded: they show nothing to improve.
- **The server logs what it sees.** Every tool call is logged with its duration, response size and outcome (ok, error or guard), with flags for retries and repeated calls. This is objective data the AI can't under-report.
- **The AI is told up front.** The debug-mode instructions come first in what the server sends at connect time, and `get_server_info` and `check_connectivity` show "Debug mode: ON".
- **Errors get a reminder.** The first time a tool returns a given error or guard, the response starts with a one-line reminder to record a note if it was unexpected (in JSON responses, as a `_debugMode` field).

Debug mode costs extra tokens (the instructions and the notes). Leave it off for normal use, and don't use debug sessions as token baselines.

**Where the files go:** a `remediation/` folder in the root of **the project the AI is working in**, so each note sits next to the app and tests it's about.

| Install | Notes | Event log |
|---|---|---|
| npm (`MCP_DEPLOYMENT_MODE=local`) | The server writes `<project>/remediation/<yyyymmddhhmmss>-<id>.md` | The server writes `<project>/remediation/<yyyymmddhhmmss>-<id>.events.jsonl` |
| Docker | Returned to the AI, which saves them to `remediation/` in its project if it can write files (Claude Code can; Claude Desktop needs a filesystem tool) | Kept in server memory; a summary is included in every note |

With the npm install, the server finds the project in this order, and records the step it used as `location:` in each file:
1. `MCP_REMEDIATION_DIR`, if set (files go directly into that folder);
2. the workspace folder the AI client reports;
3. `./remediation` in the folder the server was started in, if that folder is a project (has a `.git`, `package.json`, `pom.xml`, …).

Otherwise nothing is written: events stay in memory and each note is returned to the AI client to save, as in Docker mode. Notes are never written to your home folder, a drive root or a system folder.

The `remediation/` folder contains its own `.gitignore` (`*`), so it is never committed to the project it lives in. There is one file per session; the `<id>` suffix keeps parallel sessions apart, and each file records the machine and user, so files collected from several machines can be merged. Keys, tokens, emails and signed-URL parameters are redacted before anything is written or returned.

To share notes, send the `remediation/` folder (or several, from different machines) to the MCP maintainers — they are analysed in batches with internal tooling that is not part of this repository.

[↑ Back to top](#table-of-contents)

---

## What You Can Do

### Example prompts

Once connected, talk to the server in plain language — no tool names needed:

- *"Show me the overall health of the device farm — how many devices are available, reserved, and offline?"*
- *"Find an available Android phone running at least version 13 in the US2 region"*
- *"Did all tests in the QA project pass today? I need a go/no-go for the release."*
- *"Install the latest build of com.mycompany.app on all available Android devices"*
- *"Find an available Android phone, then generate a Java JUnit5 test boilerplate"*
- *"Show the pass/fail breakdown by OS — are Android and iOS failing at different rates?"*
- *"Did the latest release introduce a CPU regression? Compare version 10553 vs 10554 on Android."*
- *"Set up a new POC for Acme Corp — 6 devices in US2, 3 iOS and 3 Android, for the next 4 weeks"*

**[→ docs/examples.md](docs/examples.md)** has 200+ prompts organized by scenario: farm health, device groups, regression sign-off, test analytics, performance, usage reports, interactive inspection, POC lifecycle, and more.

### Tasks at a glance

| I want to… | Where to look |
|---|---|
| Check farm health, find a device, reserve it, manage groups and tags | [Devices](docs/tools.md#devices), [Device Groups](docs/tools.md#device-groups), [Health & Diagnostics](docs/tools.md#health--diagnostics), [Reservations](docs/tools.md#reservations) |
| Upload, install or find the latest build of an app; manage test files and iOS profiles | [Applications](docs/tools.md#applications), [Repository](docs/tools.md#repository), [Provisioning Profiles](docs/tools.md#provisioning-profiles) |
| Explore an app or web page live with the AI | [Interactive inspection](#interactive-inspection) below |
| Create an automated test | [Creating Tests](#creating-tests) |
| Run Espresso, XCUITest or Maestro suites on the platform | [Test runs](#test-runs-espresso-xcuitest-maestro) below |
| Find out why tests failed, and track pass rates and trends | [Test Results and Root Cause Analysis](#test-results-and-root-cause-analysis) |
| Compare performance between versions, devices or networks | [Performance Comparison Reports](#performance-comparison-reports) |
| Export or summarize platform usage *(Cloud Admin)* | [Usage reports](#usage-reports) below |
| Set up or wind down a POC or project; manage users | [Workflow Reference](#workflow-reference), [Users](docs/tools.md#users), [Projects](docs/tools.md#projects) |

#### Interactive inspection

An inspection session opens a live connection to a real device or browser so the AI can see the screen and interact with it — useful for exploring an app and capturing real element IDs before writing a test.

- **Mobile** ([tools](docs/tools.md#mobile-inspection-sessions)) — Android and iOS, on both Appium Grid and Appium Server projects: screenshots, element discovery, the full gesture set, keys, app/device control (including background/resume, mid-session install from the repository and a webview-cache reset), hybrid-app webview contexts (`webview_context`), the live device log, HAR and device-log capture into the file repository, network toggles and NV network conditions, camera image injection, device diagnostics (battery, screen, dark mode, iOS accessibility audit), Android Auto / CarPlay projection, audio play/record on devices with an audio line, and mock biometric authentication. The session shares a watch-only live view URL so you can follow along. iOS behaves differently in a few places ([limitation 29](docs/limitations.md#29-ios-inspection-sessions-differ-from-android)), and Appium Grid projects support fewer commands ([limitation 18](docs/limitations.md#18-appium-grid-projects-support-fewer-commands-than-appium-server)).
- **Browser** ([tools](docs/tools.md#web-inspection-sessions)) — navigate, discover elements (including inside Shadow DOM), verify CSS selectors and generate browser-neutral Selenium scripts.
- **Remote debug** ([tools](docs/tools.md#remote-debug)) — `get_remote_debug_command` makes a cloud device appear as if it were plugged into your machine (over ADB for Android, usbmuxd for iOS), so Android Studio, Xcode and command-line ADB can use it — for example for shell commands or file push. Install the app **before** connecting (see [Troubleshooting](#common-symptoms)).

Example prompts: [Interactive Inspection](docs/examples.md#interactive-inspection-ai-driven-test-building), [Android Auto / CarPlay](docs/examples.md#android-auto--carplay), [Web Browser Inspection](docs/examples.md#web-browser-inspection-ai-driven-browser-test-building).

#### Test runs (Espresso, XCUITest, Maestro)

The platform runs these suites itself: `execute_test_run` starts a run, `get_test_run_status` follows it, `cancel_test_run` stops it, and `get_test_run_command` gives a command to start it from your own machine. `generate_maestro_flow` builds a Maestro flow from structured steps. Maestro is Android-only. Espresso and Maestro runs are verified; XCUITest uses the same API but is not yet verified end to end. See [Test Runs](docs/tools.md#test-runs-espresso--xcuitest--maestro) and [example prompts](docs/examples.md#test-runs-espresso-xcuitest-maestro).

Appium and Selenium tests are different: you run them from your own Appium or Selenium client (IDE, CI scripts), and the server manages the devices, apps, reservations and results they use.

#### Usage reports

Cloud Admins can export the platform's usage-report CSVs — device reservations, users/devices/browser usage, user statistics, license usage — or have `summarize_usage_report` aggregate one in memory and return just the summary, with no file written. Usage data is kept for 2 years (platform 25.9+); earlier periods come back empty or partial. A large unfiltered export runs only after you explicitly agree (`confirmLargeExport`, see [Safety Guards](#safety-guards)). See [Usage Reports](docs/tools.md#usage-reports), [limitation 21](docs/limitations.md#21-usage-reports-2-year-retention-large-exports) and [example prompts](docs/examples.md#usage-reports-platform-administration--finops).

### All capability areas

210 tools across 27 capability areas. The complete per-tool reference — descriptions, filters, access requirements and usage notes — is in **[docs/tools.md](docs/tools.md)**.

| Area | Tools | Highlights |
|---|---|---|
| [Devices](docs/tools.md#devices) | 21 | List/query devices, find available (incl. devices with an audio line), release, reboot, tags, Mobile Studio, emulator/simulator templates, devices that make tests fail |
| [Device Groups](docs/tools.md#device-groups) | 9 | Create groups, move devices, control project access |
| [Reservations](docs/tools.md#reservations) | 5 | Reserve devices, check availability windows |
| [Applications](docs/tools.md#applications) | 15 | Upload, generate local upload/download commands, install/uninstall, find the latest build |
| [Repository](docs/tools.md#repository) | 8 | Test-data file storage |
| [Browsers](docs/tools.md#browsers) | 3 | Selenium browser session management |
| [Users](docs/tools.md#users) | 8 | Account provisioning, project assignment, tags |
| [Projects](docs/tools.md#projects) | 17 | Create/configure projects, settings, app assignment |
| [Provisioning Profiles](docs/tools.md#provisioning-profiles) | 7 | iOS signing profile lifecycle |
| [Backup](docs/tools.md#backup) | 1 | Trigger a system backup |
| [Health & Diagnostics](docs/tools.md#health--diagnostics) | 7 | Farm snapshot, iOS readiness, agent status, active sessions, reporter storage, license limits and utilization |
| [Coverage Analytics](docs/tools.md#coverage-analytics) | 2 | Tested-vs-available device gap analysis |
| [Reporting](docs/tools.md#reporting) | 23 | Search/filter test reports, root-cause analysis, failure summarization, stability, trends, logs, video download (byte ranges), share links, attachment download command, cleanup |
| [Test Runs](docs/tools.md#test-runs-espresso--xcuitest--maestro) | 5 | Run Espresso, XCUITest and Maestro suites on the platform; status, cancel, local command; generate Maestro flows |
| [Test Views](docs/tools.md#test-views) | 7 | Dashboard view groups |
| [Transactions & Performance](docs/tools.md#transactions--performance) | 4 | CPU/memory/battery/Speed Index analytics |
| [Agents](docs/tools.md#agents) | 2 | Host machine status *(Cloud Admin)* |
| [Regions](docs/tools.md#regions) | 2 | Region status and infrastructure topology *(Cloud Admin)* |
| [NV Servers](docs/tools.md#nv-servers) | 2 | Network Virtualization servers *(Cloud Admin)* |
| [Server, Environments & Toolsets](docs/tools.md#server-environments--toolsets) | 6 | Server info, connectivity and workflow readiness checks, named connection profiles and runtime switching, toolset loading (plus `record_remediation_note` in debug mode) |
| [Workflows](docs/tools.md#workflows) | 6 | POC and project lifecycle orchestration |
| [Boilerplate Generation](docs/tools.md#boilerplate-generation) | 4 | Ready-to-run Appium and Selenium test projects (Java JUnit 5, Java TestNG, Node.js, Python, Robot Framework) that report the real outcome, Test Orchestrator agent install; validate scripts before delivery |
| [Remote Debug](docs/tools.md#remote-debug) | 1 | Connect a cloud Android or iOS device as if it were attached locally (ADB / usbmuxd) |
| [Mobile Inspection Sessions](docs/tools.md#mobile-inspection-sessions) | 30 | AI-driven live device interaction — screenshots, element discovery, full gesture set, keys, app/device control, webview contexts, device log, HAR/log capture, network, camera injection, Android Auto / CarPlay projection, audio play/record, mock biometric authentication |
| [Web Inspection Sessions](docs/tools.md#web-inspection-sessions) | 8 | AI-driven live browser interaction — navigate, Shadow DOM element discovery, CSS selector verification, browser-neutral Selenium script generation |
| [Performance Comparison](docs/tools.md#performance-comparison) | 4 | Two-set Speed Index comparison with confound detection, MAD outlier exclusion, and fresh-sample generation |
| [Usage Reports](docs/tools.md#usage-reports) | 3 | Platform usage-report CSV export and in-memory aggregation — device reservations, users/devices/browser usage, user statistics, license usage; multi-section CSVs with a User Tag column, 2-year retention (platform 25.9+); large unfiltered exports run only after you explicitly agree (`confirmLargeExport`) *(Cloud Admin)* |
| [Resources & Prompts](docs/tools.md#resources--prompts) | — | 2 ambient resources, 7 guided prompts |

[↑ Back to top](#table-of-contents)

---

## Creating Tests

### Two ways to create a test

The server supports two ways of creating a test, for both mobile and web, and the AI is instructed to pick between them based on context:

**Autonomous** — `get_test_boilerplate` (mobile) / `get_web_test_boilerplate` (web)
- **When:** your intent is specific — a standard flow ("create a login test") or step-level detail — AND the selectors are known (app source in the workspace, or a prior inspection session).
- **Your involvement:** none required — the AI writes the test from the boilerplate, the source and best practices.
- **Output:** in an IDE, a local test automation project; in a chat-only client, portable project files shown inline.

**Interactive** — `start_inspection_session` / `start_browser_inspection_session`, or the `collaborative_test_creation` / `collaborative_web_test_creation` prompts
- **When:** the request is vague ("I want a test for app X"), the AI has no access to the app's source (chat-only, or an IDE without this app's code), or you want to watch or drive on a live device or browser.
- **Your involvement:** collaborative — the AI builds the test step by step with you (browser sessions relay screenshots; mobile sessions share a live device view URL).
- **Output:** the same, plus selectors verified against the real app or page along the way.

**A mix is often best:** even in autonomous mode, the AI can open a short inspection session — with no involvement from you — to capture or check element IDs or CSS selectors against the real build. The AI is explicitly instructed to **never make up selectors**: when in doubt it checks live, and when the mode itself is unclear it asks.

> **Stronger guarantees:** the server sends this policy to the AI automatically (in its MCP `instructions`), and both boilerplate tools refuse to produce code for a real app or URL without verified selectors. But not every client passes server `instructions` on to the AI, and no MCP server can stop an AI from writing a test file by hand — so you can add a client-side reinforcement for a guarantee that doesn't depend on the client. See **[Recommended agent guardrails](docs/recommended-agent-guardrails.md)**.

### Mobile app tests (`get_test_boilerplate`)

Generates a complete, pre-configured Appium test project. The Digital.ai server URL and access key are filled in from the active connection profile — switch profiles with `switch_environment` first if you want the script to carry a project-scoped key instead of your admin key.

**Recommended workflow** for building a new test:

1. `get_application_info` — confirm package name, launch activity, and app ID
2. `find_available_device` — select a healthy device and read its `region`
3. `install_application` — install the app on that device before starting a session
4. `start_inspection_session` — capture real element IDs with `get_element_tree` / `find_elements`
5. `get_test_boilerplate(appId, region, …)` — generates code while the inspection session is live, or with `confirmSelectorsVerified: true`
6. [`validate_test_script`](#check-a-test-before-you-deliver-it-validate_test_script) — before saving or presenting the test
7. Run the test, then `stop_inspection_session` and `release_device` — explicit cleanup

> **Inspection gate:** when you target a real app (`appId`/`packageName`/`bundleIdentifier`), this tool returns **no code** — just a structured `{ status: "blocked", reason: "no_verified_selectors" }` error — UNLESS a live inspection session exists in the MCP server, or you set `confirmSelectorsVerified: true` (for selectors already captured another way: rdb/UIAutomator, `open_mobile_studio`, or authoritative source). The built-in ExperiBank demo (no app identifiers) is never gated. This way you can never receive a placeholder scaffold that could be passed off as a finished test.

**Finding element locators:** use an inspection session first — `start_inspection_session` → `get_element_tree` / `find_elements` gives the AI the element tree, screenshots and gestures, and is the only way to capture verified selectors inside the MCP. `open_mobile_studio` (the platform's browser-based UI Inspector) is a visual alternative that needs no local tooling. For direct device access (ADB shell commands and file push on Android, Xcode on iOS), use `get_remote_debug_command` to connect the device locally.

> ⚠️ The generated script is a **finished product**, not a discovery tool — don't run it to find out what's on screen. Running it without known element selectors creates Incomplete sessions visible to the whole team. Discover selectors with an inspection session (or `open_mobile_studio`) first.

<details>
<summary><strong>Parameters</strong></summary>

| Parameter | Values | Default |
|---|---|---|
| `platform` | `android` \| `ios` | _(required)_ |
| `language` | `java-junit5` \| `java-testng` \| `nodejs` \| `python` \| `robot` (Appium Server projects only) | _(required)_ |
| `appId` | Numeric app ID from `list_applications` | Recommended |
| `deviceCategory` | `PHONE` \| `TABLET` | `PHONE` |
| `testName` | Any string | `"My First Mobile Test"` |
| `packageName` | Android package name (e.g. `com.mycompany.app`) | _(optional)_ |
| `mainActivity` | Android main activity (e.g. `.MainActivity`) | _(optional)_ |
| `bundleIdentifier` | iOS bundle ID (e.g. `com.mycompany.app`) | _(optional)_ |
| `region` | Region code from `find_available_device` response (e.g. `US2`, `SG1`) | _(optional, strongly recommended)_ |
| `structure` | `flat` \| `page-objects` — one class per screen (a base screen with the explicit-wait helpers and a per-platform locator chooser, so one screen class serves Android and iOS) plus a test that reads as the flow. Java on Appium Server projects and Node.js (both modes); other combinations are generated flat with a note | `flat` |
| `projectType` | `standalone-gradle` \| `standalone-maven` \| `android-gradle-submodule` | `standalone-gradle` |
| `includePerformanceTransactions` | `true` \| `false` | `false` |
| `includeAxeScan` | `true` \| `false` | `false` |
| `confirmSelectorsVerified` | `true` \| `false` | _(optional)_ |
| `orchestration` | `auto` \| `on` \| `off` | `auto` |
| `orchestrationMaxRetries` | `0`–`5` | `2` (`0` for placeholder or performance tests) |
| `automotiveProjection` | Android Auto / CarPlay resolution | _(optional)_ |
| `reportStatus` | `true` \| `false` — the platform report shows the real outcome (a failed assertion is reported Failed with its message); the steps run inside a named steps group on both server modes | `true` |
| `appiumVersion` | Appium Server version, e.g. `"2.18.0"` (Appium Server projects; not with `includeAxeScan`) | platform default |
| `newSessionWaitTimeout` | Seconds (10–3600) to wait for a free matching device before failing with the platform's reason | _(optional)_ |
| `reportKeys` | Custom report columns, e.g. `{"build": "1.4.0"}` — find the runs later with a `list_test_reports` filter | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

</details>

**Generated files.** `projectType` controls the Java output layout only (it is ignored for Node.js, Python and Robot Framework): `standalone-gradle` produces `src/test/java/` with both `build.gradle` and `pom.xml`; `standalone-maven` produces `pom.xml` only; `android-gradle-submodule` puts the files under `e2e-tests/` (with `e2e-tests/build.gradle`) for embedding in an existing Android Studio project.

| Language | Files |
|---|---|
| `java-junit5` / `java-testng` | `src/test/java/LocalAndroidTest.java` or `LocaliOSTest.java` + build file(s) per `projectType`; with `structure: "page-objects"` also `BaseScreen.java`, `LoginScreen.java`, `DashboardScreen.java`, `PaymentScreen.java` (a real app gets `AppScreen.java`, a placeholder); orchestrated projects add `orchestrator/config.template.yml`, `orchestrator/.gitignore` and `lib/.gitignore`. Appium Server projects pin java-client 11 + Selenium 4.51; Grid projects stay on java-client 7 |
| `nodejs` | `package.json` + `wdio.conf.js` + `test/specs/AndroidNative.js` / `test/specs/iOSNative.js` + `setup-steps.sh` (WebdriverIO 7.40 for Appium Grid projects, WebdriverIO 9 for Appium Server); with `structure: "page-objects"` also `test/screenobjects/AppScreen.js`, `LoginScreen.js`, `DashboardScreen.js`, `PaymentScreen.js` (a real app gets `PlaceholderScreen.js`) |
| `python` | `AndroidNative.py` / `iOSNative.py` + `requirements.txt` |
| `robot` | `tests/AndroidNative.robot` / `tests/iOSNative.robot` + `tests/DigitalAiReport.py` (report keywords) + `requirements.txt` (Robot Framework 7.5, AppiumLibrary 3.2.1). Appium Server projects only; not combinable with `includePerformanceTransactions`, `includeAxeScan` or `automotiveProjection` |

All boilerplate uses the ExperiBank demo app as its starting point. ExperiBank is available on most farm devices, so you can verify connectivity before switching to your own app.

**Locators and waits.** Every generated step goes through an explicit-wait helper (`find()` in Java/Python/Node, `Wait And Click` / `Wait And Input` in Robot) that polls up to 20 seconds for the element; no template sets an implicit wait, and adding one would make every miss wait both timeouts. Locators follow a fixed ladder — Android: resource-id, then accessibility id (`content-desc`), then an attribute XPath; iOS: accessibility id (the element's `name`: identifier, else label — the same match as a name XPath without walking the tree), then `-ios predicate string` (Appium Server only), then an attribute XPath. Never positional XPath (`[1]`, `[2]`) and never fixed sleeps; `validate_test_script` warns on both. The full table is in [docs/tools.md](docs/tools.md#locators-and-waits-in-generated-tests).

**Parallel runs.** Every template already creates one session per test method, which is the shape that survives parallel execution. The response's `parallelNote` says how to turn it on per framework (pytest-xdist, JUnit 5 `junit-platform.properties`, a TestNG `parallel="methods"` suite, WebdriverIO `maxInstances`, pabot) and reminds you to check the project's `maxDevelopmentLicense` and the number of free matching devices first — a worker that finds no device waits for `newSessionWaitTimeout` and then fails.

**Performance transactions:** pass `includePerformanceTransactions: true` to wrap the test body in `startPerformanceTransaction` / `endPerformanceTransaction` calls. The start argument is the NV network profile (defaults to `"Monitor"` — observe without throttling); the end argument is the transaction name. The platform records CPU, memory, battery and Speed Index metrics; results appear in the reporter Transactions tab about 1 minute after `endPerformanceTransaction` and can be queried with `list_transactions`. Prerequisite: an NV server must be ONLINE and tunnel-connected in the device's region (`list_nv_servers`). A throttling profile turns on network shaping immediately; `"Monitor"` is pass-through and carries no ANR (app-not-responding) risk.

**Accessibility scanning:** pass `includeAxeScan: true` to add a Deque Axe DevTools Mobile accessibility scan (a `mobile: axeScan` executeScript call). It sets the required `appium:automationName` capability automatically (`AxeUiAutomator2` for Android, `AxeXCUITest` for iOS) and pins `appiumVersion` to 2.16.2 (the Axe driver is unavailable on Appium Server 3.3.0+; don't raise it). The key comes from `AXE_DEVTOOLS_API_KEY`; if that's unset, a placeholder is written.

Both flags can be combined — the Axe scan runs inside the performance transaction.

#### Test Orchestrator (default for Java on Appium Server)

For **Java (JUnit 5 / TestNG) on an Appium Server project**, the generated project is set up for the **Digital.ai Test Orchestrator** (the Smart Agent): failed tests are retried automatically, each attempt is reported separately, the real pass/fail is synced to Reporter, and runs are grouped by Build ID — with no change to the test code. Everything else (Appium Grid projects, Python, Node.js and Robot Framework) gets the classic boilerplate. Pass `orchestration: "off"` to get the classic boilerplate for Java too.

1. **`get_test_boilerplate`** adds conditional agent wiring to `build.gradle` / `pom.xml`, an `orchestrator/config.template.yml` (retries default to 2; 0 for placeholder or performance tests), plus `orchestrator/.gitignore` and `lib/.gitignore` so the rendered key and the agent JAR can never be committed. No root `.gitignore` is written (it would overwrite yours).
2. **`install_test_orchestrator_agent(projectDir)`** downloads the agent on demand, verifies its SHA-256 and places it at `lib/smart-agent.jar`. Under Docker it returns a download command (bash and PowerShell) that does the same and deletes the file on a checksum mismatch. If the download fails, the response gives the URL, the checksum and the target path for a manual install.
3. **Set `DIGITAL_AI_ACCESS_KEY` and run `gradle test` / `mvn test`.** The agent attaches only when the JAR is present **and** the key is set; the key is rendered into the git-ignored `orchestrator/rendered/` at build time, never into a tracked file, and Java 17 is required only in that case. Otherwise the project builds and runs exactly like the classic boilerplate (Gradle prints why the agent was not attached). Set `BUILD_ID` to group a CI build's results.

Requirements: a **Java 17 or 21** JDK with a current truststore, JUnit 5 or TestNG 7+, Appium java-client 8–11 (the generated projects pin 11.0.0). See [Limitations](docs/limitations.md#17-test-orchestrator-known-issues) for known issues.

The agent JAR is **not** shipped with this server. By default it is downloaded from the [Digital.ai Test Orchestrator sample repository](https://github.com/raheekhandigitalai/Digital.ai-Testing-Test-Orchestrator), pinned to a fixed commit and verified by SHA-256 (see `resources/test-orchestrator/agent.json`). To use a different location — for example an internal mirror — set `TEST_ORCHESTRATOR_JAR_URL` **and** `TEST_ORCHESTRATOR_JAR_SHA256` (both required; a URL without a checksum is refused).

### Web tests (`get_web_test_boilerplate`)

Generates a complete, pre-configured Selenium test project for browser testing. The Digital.ai server URL and access key are filled in from the active connection profile.

**Recommended workflow** for building a new web test:

1. `list_available_browsers` — confirm which browsers and OS combinations are available in your region
2. `start_browser_inspection_session` — open a live browser session on the target URL
3. `get_page_dom` — extract the rendered DOM, including shadow trees; note element IDs and `data-testid` values
4. `find_web_elements` / `tap_element` / `type_into_element` — interact with elements to verify selectors work
5. `take_inspection_screenshot` — relay screenshots at each key step for verification
6. `stop_browser_inspection_session`
7. `get_web_test_boilerplate(confirmSelectorsVerified: true)` — generate the verified script (once the session is stopped, pass `shadowDomSupport: "always"` if `get_page_dom` reported shadow DOM)

> **Inspection gate:** when you target a real URL (`url` provided), this tool returns **no code** — just a structured `{ status: "blocked", reason: "no_verified_selectors" }` error — UNLESS a live browser inspection session exists in the MCP server, or you set `confirmSelectorsVerified: true` (for selectors captured in a prior `start_browser_inspection_session` session). This mirrors the mobile gate.

**Browser-neutral by default:** when `targetBrowser` is omitted, the generated script reads the browser name at runtime from the `BROWSER` environment variable, so the same script runs on Chrome, Firefox, Microsoft Edge, Safari and Opera without changes (Robot Framework: every browser except Opera, which SeleniumLibrary cannot drive) — just change the variable or your CI matrix. Specify `targetBrowser` only when you need browser-specific options (e.g. Safari-only session setup).

**Shadow DOM support:** with `always`, the generated script includes a `shadowQuery(host, cssSelector)` helper; with `auto` (the default), it is included only while a browser inspection session is open in the MCP server; `never` omits it. The helper reaches into shadow roots using `executeScript`. Use it for apps built with Web Components, Lit, Polymer or other shadow-DOM frameworks. `get_page_dom` detects shadow DOM automatically during inspection and reports `hasShadowDom: true` when present.

<details>
<summary><strong>Parameters</strong></summary>

| Parameter | Values | Default |
|---|---|---|
| `language` | `java-junit5` \| `java-testng` \| `nodejs` \| `python` \| `robot` (Robot Framework + SeleniumLibrary) | _(required)_ |
| `url` | URL of the page being tested | _(optional)_ |
| `testName` | Any string | `"WebTest"` |
| `targetBrowser` | `chrome` \| `firefox` \| `MicrosoftEdge` \| `safari` \| `opera` (names as `list_available_browsers` returns them; `edge` is accepted for `MicrosoftEdge`) | _(optional)_ |
| `shadowDomSupport` | `auto` \| `always` \| `never` | `auto` |
| `confirmSelectorsVerified` | `true` \| `false` | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

</details>

### Check a test before you deliver it (`validate_test_script`)

A final check for the case the boilerplate gate can't catch: a test written by hand with guessed selectors. Pass the full `scriptContent` before presenting or saving any test. It looks for unreplaced `<…>` placeholder selectors, the deliberate scaffold fail-guard, placeholder or made-up credentials, and known fabricated resource IDs. If it finds a serious problem it returns `isError` with a `fail` verdict, so a test that can't work isn't delivered as finished. A `pass` is necessary but not sufficient: it confirms the obvious placeholders are gone, not that the selectors are real — a live inspection is still the authoritative source.

| Parameter | Values | Default |
|---|---|---|
| `scriptContent` | The full test script text | _(required)_ |
| `fileName` | Label for the result | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

[↑ Back to top](#table-of-contents)

---

## Test Results and Root Cause Analysis

The reporting tools search test reports, summarize pass/fail results and explain failures. Field names, filter properties and ID types are in the [Test reporting schema](docs/tools.md#test-reporting-schema); more prompts are in [Root Cause Analysis](docs/examples.md#root-cause-analysis-why-tests-are-failing) and [Functional Test Analytics](docs/examples.md#functional-test-analytics).

Two things to know:
- **The list doesn't include failure details.** `list_test_reports` returns summary records; call `get_test_report` on a test to get its cause, error category and stack trace.
- **Filter by date with `startDate`/`endDate`**, not with a `start_time` filter (the platform rejects that).

**Common queries:**

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

**Root cause analysis of a failure:**

```
# 1. Find the failures
list_test_reports
  filter: [{"property":"status","operator":"=","value":"Failed"}]

# 2. Diagnose — structured cause without any download
get_test_report(testId: 69)
  → cause, errorCategory, errorClassification, errorDetail (stack trace)

# 2b. Platform root-cause analysis (read-only)
get_root_cause_analysis(uuid: "…")      # or reportUrl / testId

# 3. Full Appium log as text, when the structured fields aren't enough
get_test_log(uuid: "…", logType: "appium")

# 4. Pull the binary artifacts (session video .mp4, full ZIP) to YOUR machine.
#    With the npm install, call download_test_video / download_test_attachments
#    directly; under Docker/remote, generate a local command instead:
get_test_attachments_download_command(uuid: "…", localPlatform: "macos")
  → a curl command you run locally; the file never transits the container
```

Tests missing from the results? See [Troubleshooting](#common-symptoms) — a project with its own reporter needs `projectName`.

[↑ Back to top](#table-of-contents)

---

## Performance Comparison Reports

Compare performance (Speed Index, CPU, memory, battery, duration) between two sets of conditions — app v1 vs v2, device A vs device B, OS version X vs Y, region to region, two network profiles, or two automation scripts. Works with all access levels — Cloud Admin sees all projects; project-level keys (Project Admin and Project User) see only their own project's transactions.

The headline metric is reported three ways every time — **trimmed mean, median, and raw mean** — so a small or noisy sample can't hide behind a single number.

| Tool | Purpose |
|---|---|
| `compare_performance_transactions` | Two-set comparison; trimmed-mean/median/mean per side + delta and % change. MAD outliers excluded by default (≥4 samples/side). Pass `comparisonAxis` to embed a confound check. |
| `assess_comparison_confounds` | Verdict — **clean / caveated / confounded** — by flagging any dimension other than the declared axis (device model, OS, OS version, network profile, project, transaction name) that varies across or within the sides, plus missing telemetry and sample imbalance. |
| `detect_performance_outliers` | Robust median/MAD outlier flagging on a single set; returns the kept set and recommended exclusions/re-runs. |
| `performance_transaction_control` | Phase 2: generate fresh samples inside an inspection session — `start` (with an NV profile; add `forApplication` to sample one app's CPU/memory/battery instead of the whole device) → run the verified flow → `end` (names the record). Records appear in the reporter ~1 min later; a transaction is capped at 5 minutes, and a report that holds one cannot be deleted afterwards. |

> **Why the confound check matters:** comparing two transactions with Speed Index 1015 vs 1000 looks like a 1.5% version delta — but if they ran on *different device models, different OS versions, and different projects*, and one has no CPU/memory telemetry, `assess_comparison_confounds` returns **confounded** and names each cause, so the delta is never misread as a version regression.

The **`performance_comparison_report` prompt** runs the full workflow end to end: define the axis → scrub confounds → negotiate sample size → **require explicit plan confirmation with a time estimate** → run the series with outlier-driven re-runs → report the delta with root-cause reasoning. True host/background interference can't be observed directly; the report approximates device quietness (idle, healthy status, no concurrent reservation) and states that limit explicitly.

To record new performance samples from a generated test, see [performance transactions](#mobile-app-tests-get_test_boilerplate) in Creating Tests. More prompts: [Performance Testing Analytics](docs/examples.md#performance-testing-analytics).

[↑ Back to top](#table-of-contents)

---

## Workflow Reference

Six workflow tools set up and wind down POC and project environments. They don't make changes themselves: each returns a guided, numbered plan that the AI then carries out with the individual tools (`create_device_group`, `create_user`, …), pausing for your confirmation at the points the plan specifies. The plans use Cloud Admin tools (user, group and project administration), so run them with a Cloud Admin profile.

| Goal | POC | General project |
|---|---|---|
| Set up | [`create_poc`](#create_poc--onboard-a-new-poc-environment) | [`setup_project`](#setup_project--provision-a-new-project-environment) |
| Release devices and users, keep the project | [`close_poc`](#close_poc--wind-down-without-deleting) | [`close_project_resources`](#close_project_resources--release-resources-without-deleting) |
| Delete everything | [`delete_poc`](#delete_poc--full-teardown) | [`teardown_project`](#teardown_project--full-project-deletion) |

### POC Lifecycle

Three tools cover the full POC lifecycle. All derive the project name (`"<Customer> POC"`) and device tag (`"<customername>poc"`) from `customerName` — pass the same value to all three tools.

#### `create_poc` — Onboard a new POC environment

Collects all parameters up front, checks that the app binaries are in the repository, presents a confirmation summary to the operator (Step 0), then runs 10 steps in order:

1. Create (or reuse) a device group named `<Customer> POC`
2. Locate the Default device group
3. Select available phones from the Default group — region-matched, conflict-tag-free, phones only (tablets excluded). Presents the selection to the operator for confirmation before proceeding.
4. Add selected devices to the POC group
5. Tag each device with the derived POC tag (e.g. `acmecorppoc`)
6. Create (or reuse) a project; record the Salesforce URL and end date in project notes
7. Remove devices from the Default group — done only after the project exists, so a project-creation failure never strands devices
8. Locate the Default project
9. Create users, assign to the POC project, remove from Default, and tag each account with the POC tag. Cloud Admin access is never granted through this workflow.
10. Assign ExperiBank (or the app identified by `androidPackageName` / `iosBundleId`) to the POC project — if a binary isn't in the repository, the summary reports it as a manual upload and the workflow continues

If any step fails, the workflow stops, reports which steps completed with all created resource IDs, and offers to resume (call it again — existing resources are detected and reused) or unwind (`delete_poc`). Steps 1 and 6 check for an existing group/project by name before creating, so it is safe to re-run after a partial failure.

**Required parameters:**

| Parameter | Description |
|---|---|
| `customerName` | e.g. `"Acme Corp"` → derives project `"Acme Corp POC"` and tag `"acmecorppoc"` |
| `region` | Testing region, e.g. `"US2"`, `"EU"`, `"SG"` |
| `salesforceUrl` | Salesforce Opportunity URL — recorded in project notes |
| `endDate` | Accepts ISO (`"YYYY-MM-DD"`), relative offsets (`"+14d"`, `"+2w"`), or natural language (`"in 2 weeks"`) |
| `users` | Array of `{email, firstName, lastName, role}` — role must be `"User"` or `"ProjectAdmin"` |

**Optional parameters:**

| Parameter | Default |
|---|---|
| `deviceCount` | `6` |
| `iosCount` | `ceil(deviceCount / 2)` |
| `androidCount` | `floor(deviceCount / 2)` |
| `automationType` | `"appium-server"` (alternative: `"appium-grid"`) |
| `appName` | `"ExperiBank"` |
| `androidPackageName` | `"com.experitest.ExperiBank"` |
| `iosBundleId` | `"com.experitest.ExperiBank"` |

#### `close_poc` — Wind down without deleting

Reverses the device and user changes from `create_poc` while leaving the project and device group intact:

1. Locate the POC project and device group by derived name
2. List devices in the POC group
3. Remove the POC tag from each device (all other tags are preserved)
4. Move devices out of the POC group and back into the Default group
5. Process users by POC tag: **delete accounts that have no other project memberships; revoke POC access only for users who also belong to other projects**

Only `customerName` is required.

> The Digital.ai REST API has no endpoint to lock or disable a user. Deleting the account via `delete_user` is the only way the API offers to remove access for users created only for the POC.

#### `delete_poc` — Full teardown

Performs the same wind-down as `close_poc`, then permanently deletes the device group and the project. Requires `confirmDeletion: true`.

Before any destructive action, the workflow gathers a full inventory (project ID, group ID, device list, user breakdown) and presents it for explicit confirmation. Unlike `close_poc`, user processing is confirmed once for the whole batch via this inventory rather than user by user.

**Best practice:** Run `close_poc` first — it winds down the POC while preserving the project and device group. Note that `close_poc` is not fully reversible: device moves and tag removal can be undone, but it permanently deletes POC-only user accounts (each deletion requires per-user operator confirmation). Use `delete_poc` only once the project data is confirmed no longer needed. Calling `delete_poc` without `confirmDeletion: true` returns a safe explanation and suggests `close_poc` as the alternative.

### Project Lifecycle

Three tools mirror the POC lifecycle for general project management. They follow the same rule for users who belong to several projects: those users are removed from this project only, never deleted from the platform.

#### `setup_project` — Provision a new project environment

If you call it with only a project name (no `region`, `deviceCount` or `users`), the workflow first asks whether to create a **simple** project record only, or a **full** environment (device group, device allocation, user provisioning, app assignment) — and for a full environment, collects those parameters. If any of them are supplied, it goes straight to the full setup and asks you to confirm the parameters.

Full setup steps:

1. Create (or reuse) the project with the specified name and automation type; record `projectMemo` in project notes
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

**Optional parameters:**

| Parameter | Default | Description |
|---|---|---|
| `region` | _(none)_ | Target region for device selection — needed for a full setup; without it, devices are selected from all regions |
| `deviceCount` | `6` | Total devices to allocate |
| `iosCount` | `ceil(deviceCount / 2)` | iOS device count |
| `androidCount` | `floor(deviceCount / 2)` | Android device count |
| `automationType` | `"appium-server"` | `"appium-server"` or `"appium-grid"` |
| `isolateDevices` | `false` | Remove devices from all other groups before assignment |
| `users` | `[]` | Array of `{email, firstName, lastName, role}` |
| `appName` | `"ExperiBank"` | App to assign to the project |
| `androidPackageName` | `"com.experitest.ExperiBank"` | Android package used to find the app |
| `iosBundleId` | `"com.experitest.ExperiBank"` | iOS bundle ID used to find the app |
| `projectMemo` | _(none)_ | Notes to record on the project |

#### `close_project_resources` — Release resources without deleting

Winds down the project environment while leaving the project record intact:

1. Locate the project and its associated device group
2. List the devices in the project group
3. Remove the project-derived tag from each device
4. Return devices to the Default group
5. Process the users carrying the project tag (applied by `setup_project`): **delete accounts with no other project memberships; revoke project access only for multi-project users** (each action individually confirmed by the operator)

Only `projectName` is required. Active sessions and installed apps on the devices are not touched — release sessions with `release_orphaned_sessions` and remove apps with `uninstall_application` separately if needed.

#### `teardown_project` — Full project deletion

Performs all `close_project_resources` steps, then permanently deletes the device group and the project. Requires `confirmDeletion: true`.

The workflow presents a full inventory summary before any irreversible action; as with `delete_poc`, user processing is confirmed once for the whole batch via this inventory rather than user by user. Users who belong to other projects are protected in the same way.

**Best practice:** Run `close_project_resources` first, then confirm the project is no longer needed before calling `teardown_project`.

[↑ Back to top](#table-of-contents)

---

## Safety Guards

All destructive operations require `confirmDeletion: true`. Without it:

> ⚠️ Safety guard triggered. "Delete user 42" is a destructive operation that cannot be undone. To confirm you want to proceed, include `confirmDeletion: true` in your request. No changes were made.

The first call describes what will be deleted. The second call — with `confirmDeletion: true` — carries it out. This prevents accidental data loss when an AI assistant misreads your intent. `release_orphaned_sessions` works the same way: without `confirmDeletion: true` (or with `dryRun: true`) it only previews the devices it would release.

Two other actions have their own confirmation flags:

- **`confirmPublicShare`** — `share_test_report` creates a public link anyone can open without logging in, and it cannot be revoked early (see [limitation 22](docs/limitations.md#22-public-report-links-cannot-be-revoked)). Without the flag it returns a preview only.
- **`confirmLargeExport`** — usage-report tools stop before an unfiltered export spanning more than 31 days (it can reach hundreds of MB) and ask. Only you should approve such an export, not the AI on its own (see [limitation 21](docs/limitations.md#21-usage-reports-2-year-retention-large-exports)).

More checks run before any request leaves the server:

- **Permission check first:** report-deletion tools (`delete_test_reports*`, `cleanup_inspection_sessions`, `cleanup_browser_inspection_sessions`) check your detected access level first. A project-level role is refused up front when its project's `allowUsersDeleteTests` setting is readable and false, with a message telling you to have a Cloud Admin enable it (or switch to a Cloud Admin profile) — instead of an unexplained 403.
- **Path validation:** tools that read or write local files require an absolute path and refuse path traversal (`..`). Upload tools also refuse credential-file names (`.env*`, SSH private keys), so a misdirected request cannot publish secrets to the cloud repository.

[↑ Back to top](#table-of-contents)

---

## Troubleshooting

### Common symptoms

| Symptom | Cause | Fix |
|---|---|---|
| `403 Forbidden` on admin tools (agents, regions, license) | Active profile has a project-level role (Project Admin or Project User) — v2 endpoints require Cloud Admin access | Ask the AI: *"switch to my Cloud Admin profile"* — it will call `list_environments` and pick the right one. See [Using multiple keys](#using-multiple-keys) |
| Report delete tools refuse with "Reporter deletes are disabled for project …" | The project's `allowUsersDeleteTests` setting is false, so project-level roles can't delete reports | Ask a Cloud Admin to enable it for the project, or switch to a Cloud Admin profile |
| `install_application` returns 400 on a device you can see | Device is reserved via an rdb (remote debug) session | Install **first**, then run `get_remote_debug_command` — not the other way around |
| `install_application` returns 400 (no rdb involved) | App not assigned to a project containing the target device | Call `assign_app_to_project` first |
| Repeatable `NoSuchElementException` while sibling tests pass | Device health, not test code — device stuck in a wrong state or offline-but-pooled | Run `get_device_health_summary`; scope the deviceQuery with `@region='<healthy-region>'` |
| Tests missing from `list_test_reports` results | Project has its own reporter instance — unscoped queries search the default scope | Pass `projectName` (exact name from `list_projects`) |
| rdb fails: `validation error / Failed to reserve device` | With a project-level role, the serial lookup returned an internal device ID instead of the real serial (the `get_remote_debug_command` response warns about this) | Ask the AI: *"switch to Cloud Admin"* → regenerate the rdb script → switch back. See [limitation 13](docs/limitations.md#13-get_remote_debug_command-requires-cloud-admin-for-reliable-serial-resolution) |
| Device query returns nothing for `@manufacturer` / `@tag` | These fields are silently ignored server-side | Use the `manufacturer`/`tags` parameters on `find_available_device` — they filter client-side |
| A downloaded file isn't on your machine, or an upload can't find your file (Docker) | Under Docker, file tools use the container's filesystem | See [Local File Transfer](#local-file-transfer-docker--remote-deployments-only) |

### `Failed to reconnect to digital-ai-testing: -32000`

On Windows with Docker, this usually means the `--env-file` path was stored with its backslashes stripped. Open `~/.claude.json`, find the `mcpServers` entry for this project, and check that the env file path looks right (e.g. `C:/projects/digital-ai-testing-mcp/.env`). If it shows something like `C:projectsdigital-ai-testing-mcp.env`, the backslashes were removed. Fix the path in the file directly (use forward slashes), then run `/mcp` in Claude Code to reconnect.

### Workflow tools failing?

Run this sequence:

```
1. get_server_info           — confirm tool count (expect 210; 211 with MCP_DEBUG_MODE=true) and active profile
2. check_workflow_readiness  — which dependency tools are present or missing
3. check_connectivity        — confirm the backend API is reachable
```

`check_workflow_readiness` returns a structured report:

```json
{
  "allWorkflowsReady": true,
  "registeredToolCount": 210,
  "workflows": {
    "create_poc":            { "ready": true, "missingRead": [], "missingWrite": [] },
    "setup_project":         { "ready": true, "missingRead": [], "missingWrite": [] }
  }
}
```

If `ready` is `false`, `missingRead` and `missingWrite` list exactly which tools are absent. The most common cause is an outdated install — see [Upgrading](#upgrading).

The server also logs a readiness check at startup (visible in your terminal, or `docker logs`/your AI client's MCP server logs if running in a container): `Workflow readiness: all workflows ready ✓`, or `⚠️ DEGRADED: create_poc — missing: ...` when tools are absent.

[↑ Back to top](#table-of-contents)

---

## Reference

### Response Format

All data-returning tools accept an `outputFormat` parameter:

| Value | Default? | Use when |
|---|---|---|
| `"json"` | ✅ Yes | Chaining tool calls — IDs and values pass directly to the next tool without parsing |
| `"human"` | No | Displaying results to an operator — formatted prose with status indicators |

The default is `"json"` because the main consumers are AI agents that need to pick out IDs for follow-up calls. An agent can turn JSON into readable output for you; it can't reliably pull IDs out of prose.

```
# Example: pass device group IDs without string manipulation
list_device_groups { outputFormat: "json" }
→ {"deviceGroups":[{"id":"7","name":"Default"},{"id":"12","name":"Acme Corp POC"}]}

get_devices_in_group { groupId: "7" }
→ {"devices":[{"id":"abc123","name":"iPhone 14 Pro",...}]}

add_devices_to_group { groupId: "12", deviceIds: ["abc123"] }
```

Tools that only make changes (create, delete, install, etc.) return simple success messages and have no `outputFormat` parameter. One exception to the `json` default: `get_page_dom` defaults to `human` (a readable element list); pass `outputFormat: "json"` to chain its results.

### Understanding maxResults

The Digital.ai API returns complete datasets — most endpoints have no server-side paging. The MCP caps list responses at `maxResults` (default: 50, max: 500) to keep responses a manageable size for AI assistants. `list_test_reports` uses `limit` (same default and maximum) plus `page`, and `find_elements` details at most 20 matches by default (see [limitation 19](docs/limitations.md#19-find_elements-details-only-the-first-20-matches)).

Use filters to narrow results rather than raising `maxResults`. When results are cut off, you will see:

> ⚠️ Showing 50 of 312 results. Use filters to narrow results, or increase maxResults (max 500) to see more.

### List Filters & Sorting

| Tool | Available Filters | Available `sortBy` values |
|---|---|---|
| `list_users` | firstName, lastName, email, authenticationType, isCloudAdmin, tag | firstName, lastName, email, userName, authenticationType |
| `list_devices` | query (@-syntax), os, region, model | deviceName, deviceOs, osVersion, manufacturer, displayStatus, agentName, region |
| `get_devices_in_group` | osType, status, category, excludeTags, requireTags | _(none)_ |
| `list_reservations` | username, project, deviceUid | reservationStart, reservationEnd, username, project, deviceUid |
| `list_projects` | name (partial match) | name, id |
| `list_project_users` | username (partial), role (exact) | username, role |
| `list_applications` | nameContains, osType, packageName, bundleIdentifier, uniqueName, fileType, isForSimulator | applicationName, releaseVersion, buildVersion, createdAt (default), osType, fileType |
| `list_test_reports` | `filter` array (see [Test reporting schema](docs/tools.md#test-reporting-schema)), `searchValue` (name substring), startDate/endDate (date range), projectId/projectName | `sort` array, e.g. `start_time` descending |

The list tools with `sortBy` also accept `sortOrder: "asc" | "desc"` (default `"asc"`, except `list_applications`, which defaults to `"desc"`, newest first).

`list_test_reports` sorting is done by the platform for every access level. If the platform ever refuses it for a credential, the server automatically falls back to scanning up to 5,000 records itself, so "newest first" results stay correct, just slower on large report sets.

### Local File Transfer (Docker / remote deployments only)

**If you installed the [npm package](#option-a--install-via-npm-recommended) (Option A) and run the server on your own machine, skip this section** — the `download_*`/`upload_*` tools already read and write your local files directly.

The rest of this section applies only to Docker or remote deployments (Option B or C). There, any tool that reads or writes a local file path works on the **MCP server's own filesystem** — which, in the published Docker image or a remote deployment, is **not** your machine. A `download_*` tool writes into the container; an `upload_*` tool reads from it. Neither is reachable from your local shell unless you mount a shared folder into the container.

For those deployments, every file-transfer tool has a **command-generator** counterpart that produces a `curl` / PowerShell command you run locally, so the file moves directly between your machine and the platform — never through the container:

| Direction | Server-side tool (shared filesystem only) | Local-command counterpart (Docker/remote) |
|---|---|---|
| Upload app | `upload_application_file` | `get_application_upload_command` |
| Upload repo file | `upload_repository_file` | `get_repository_upload_command` |
| Upload profile | `upload_provisioning_profile` | `get_provisioning_profile_upload_command` |
| Download test attachments (.mp4, logs) | `download_test_attachments` | `get_test_attachments_download_command` |
| Download test video (.mp4, byte ranges) | `download_test_video` | `get_test_attachments_download_command` (`artifact: "video"`) |
| Download repo file | `download_repository_file` | `get_repository_file_download_command` |
| Download profile | `download_provisioning_profile` | `get_provisioning_profile_download_command` |
| Download app language files | `extract_app_language_files` | `get_app_language_files_download_command` |
| Download iOS app container | `download_ios_app_container` | `get_ios_app_container_download_command` |
| Download usage report CSV | `download_usage_report` | `get_usage_report_download_command` (or `summarize_usage_report`, which returns an aggregated summary with no file at all) |
| Install Test Orchestrator agent | `install_test_orchestrator_agent` | the same tool — under Docker it returns bash and PowerShell download commands instead of writing the file |

For test **logs**, `get_test_log` is simpler still — it returns the Appium/device log text directly in the response, with no command or download needed. The generated commands contain the active access key in plain text, so run them right away and don't save the output. Background: [limitation 15](docs/limitations.md#15-local-file-io-runs-on-the-mcp-servers-filesystem-not-yours).

[↑ Back to top](#table-of-contents)

---

## Known Limitations

The ones you're most likely to run into:

1. **Appium and Selenium tests aren't started by the server.** You launch them from your own Appium or Selenium client (IDE, CI scripts); the server manages the devices, apps, reservations and results. Espresso, XCUITest and Maestro suites are different — the platform runs them itself (see [Test runs](#test-runs-espresso-xcuitest-maestro)).
2. **iOS inspection sessions differ from Android:** no clearing app data, no clipboard on Appium Grid devices, and back navigation uses the navigation-bar button (iOS has no Back button). See [limitation 29](docs/limitations.md#29-ios-inspection-sessions-differ-from-android).
3. **Appium Grid projects support fewer commands than Appium Server** — for example no `-ios predicate string` locator, no Android Auto / CarPlay projection, no pinch/zoom, no webview contexts. See [limitation 18](docs/limitations.md#18-appium-grid-projects-support-fewer-commands-than-appium-server).
4. **Under Docker, file tools work on the container's filesystem, not yours.** Use the command-generator tools instead — see [Local File Transfer](#local-file-transfer-docker--remote-deployments-only) and [limitation 15](docs/limitations.md#15-local-file-io-runs-on-the-mcp-servers-filesystem-not-yours).
5. **Usage reports go back 2 years** (platform 25.9+), and large unfiltered exports need your explicit approval. See [limitation 21](docs/limitations.md#21-usage-reports-2-year-retention-large-exports).
6. **There's no way to disable or lock a user.** Removing access for a user created only for a POC means deleting the account — which is why `close_poc` asks for confirmation per user.
7. **Deleting test reports with a project-level key depends on a per-project setting** (`allowUsersDeleteTests`). Cloud Admin can always delete. When the setting is off, the tools refuse up front for a Project Admin and explain how to get it enabled; a Project User cannot read the setting, so the platform returns its own 403.

See [docs/limitations.md](docs/limitations.md) for the full list.

---

## Development

To build and run the server from a clone (see [Option C](#option-c--build-from-source)), and for how to contribute, see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

```bash
npm install
npm run build    # compile TypeScript to dist/
npm run dev      # tsx watch for live reload
npm run typecheck
npm run lint
```

**Running tests** — the per-domain suites (devices, users, reporting, …) need a `.env` with valid credentials and call the real Digital.ai API. `test:tools`, `test:utils` and the other unit suites run offline; `test:tools` exercises registered tool handlers (guards, access checks, path validation) through an in-memory MCP transport with no live API access.

<details>
<summary><strong>All test scripts</strong></summary>

```bash
npm run test                  # all tests (includes the live suites)
npm run test:offline          # offline suites only — what CI runs; needs no .env
npm run test:api              # live API suites (requires .env)
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
npm run test:utils            # utility functions (offline)
npm run test:transactions     # performance transactions
npm run test:analytics        # analytics tools
npm run test:infrastructure   # agents / regions / NV servers / sessions
npm run test:live             # live API-behavior probes (requires .env; not part of npm test)
npm run test:fidelity         # agent tool-choice evaluation (builds first; spends model tokens)
```

See `package.json` for the full list of scripts.

</details>

---

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for the full license text.

Use of this software is also subject to the [Supplemental Terms of Use](./SUPPLEMENTAL_TERMS.md), which address AI client responsibilities, agentic action risks, liability limitations, and other obligations specific to the Digital.ai MCP Server for Testing. By using this software, you agree to both the Apache 2.0 License and the Supplemental Terms.
