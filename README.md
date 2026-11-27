<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/images/dai-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/images/dai-logo-light.svg">
  <img alt="Digital.ai Testing MCP Server" src=".github/images/dai-logo-light.svg" width="600">
</picture>

# Digital.ai Testing — MCP Server

Talk to your Digital.ai Testing device farm from your AI assistant. This MCP (Model Context Protocol) server connects AI clients such as Claude, GitHub Copilot and Cursor to Digital.ai Testing, so you can ask in plain language to find devices, install apps, explore an app on a real device, generate tests, run test suites, investigate failures and compare performance.

It provides **229 tools**, **2 resources** and **6 prompts** across 28 capability areas: device management, test execution (including Espresso, XCUITest, Maestro and Playwright test runs), app lifecycle, reporting and root-cause analysis, analytics, performance, project administration, interactive mobile inspection, interactive browser inspection, and more.

---

## Quick Start

**1. Check that Node.js 22 or later is installed** (npm comes with it): `node --version`. Don't go by `npm --version`: that is npm's own version number (11 with current Node.js releases), not Node's. Setup needs only Node.js (npx comes with it). If it isn't, install the LTS version that https://nodejs.org offers for your system (Windows, macOS or Linux). 22 is the minimum, not a required version: any newer release works.

```bash
node --version
```

**2. Run setup in a terminal:**

```bash
# macOS / Linux
npx -y digital-ai-testing-mcp@latest setup

# Windows (PowerShell or Command Prompt)
npx.cmd -y digital-ai-testing-mcp@latest setup
```

On Windows, type `npx.cmd`: in Windows PowerShell, plain `npx` runs a PowerShell script that the default settings block ("running scripts is disabled on this system").

It asks for your Digital.ai Testing URL and your [access key](#access-keys) (the key is typed hidden; in a Windows PowerShell or Command Prompt window, paste it with a right-click, since Ctrl+V doesn't paste there), checks them with Digital.ai Testing, and saves the key in your operating system's keychain. Then it offers to add the server to the AI clients it finds on your computer: Claude Desktop, VS Code (GitHub Copilot), Cursor, Windsurf, OpenAI Codex, OpenCode and Gemini CLI. None of their configuration files gets a copy of your key. Claude Code is added through its own `claude` command. See [The setup command](#the-setup-command).

**3. Restart your AI client and ask:** *"Show me the overall health of the device farm."*

There is nothing else to install. The first start downloads the server (about 20 seconds), and every start after a new release runs it. To stay on one version instead, see [Automatic updates](#automatic-updates).

> Prefer to edit your AI client's configuration yourself? See [Connecting AI Clients](#connecting-ai-clients).
> Prefer a container? See [Option B — Pull from GitHub Container Registry](#option-b--pull-from-github-container-registry).

---

## Table of Contents

**Get started**
- [Quick Start](#quick-start)
- [Installation](#installation) — [npm](#option-a--install-via-npm-recommended) · [Docker image](#option-b--pull-from-github-container-registry) · [from source](#option-c--build-from-source) · [Upgrading](#upgrading) · [update notices](#update-notices) · [automatic updates](#automatic-updates)
- [Connecting AI Clients](#connecting-ai-clients) — [Claude Desktop](#claude-desktop) · [Claude Code (VS Code)](#claude-code-vs-code) · [Claude Code (JetBrains)](#claude-code-jetbrains--android-studio) · [GitHub Copilot](#github-copilot-vs-code) · [Cursor](#cursor) · [Docker configs](#docker-client-configuration)
- [The setup command](#the-setup-command) — profiles in the OS keychain · [AI clients](#adding-the-server-to-ai-clients) · [diagnosing problems](#if-something-goes-wrong)
- [Access Keys](#access-keys) — access levels, finding your key, multiple profiles
- [Configuration](#configuration) — [Debug mode](#debug-mode-remediation-notes)
- [Optimizing Token Consumption](#optimizing-token-consumption) — [toolsets](#toolsets-reducing-context-size) · [finished work, not raw data](#ask-for-finished-work-not-raw-data) · [short lists](#keep-lists-and-inspection-results-short) · [switching things off](#switch-off-what-you-dont-need)

**Use it**
- [What You Can Do](#what-you-can-do) — [example prompts](#example-prompts) · [tasks at a glance](#tasks-at-a-glance) · [all capability areas](#all-capability-areas)
- [Explore Apps and Browsers Live](#explore-apps-and-browsers-live) — mobile and browser inspection, remote debug
- [Creating Tests](#creating-tests) — [choosing the framework](#choosing-the-test-framework) · [mobile](#mobile-app-tests-get_test_boilerplate) · [Test Orchestrator](#test-orchestrator-default-for-java-on-appium-server) · [web](#web-tests-get_web_test_boilerplate) · [validating a test](#check-a-test-before-you-deliver-it-validate_test_script)
- [Running Tests](#running-tests) — Espresso, XCUITest, Maestro, Playwright
- [Results, Reports and Analysis](#results-reports-and-analysis) — [ready-made reports](#ready-made-reports) · [investigating failures](#investigating-failures) · [performance comparison](#performance-comparison) · [usage reports](#usage-reports)
- [Managing Projects](#managing-projects) — [project lifecycle](#project-lifecycle)
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
- **Node.js 22 or later** (any current LTS release, on Windows, macOS or Linux) for [Option A](#option-a--install-via-npm-recommended) (recommended — no Docker needed), **or**
- **Docker** for [Option B](#option-b--pull-from-github-container-registry) or [Option C](#option-c--build-from-source) (container-based install).

### Option A — Install via npm (Recommended)

No Docker required — the server runs directly under Node.js, and there is no install command. Run [setup](#the-setup-command) once:

```bash
# macOS / Linux
npx -y digital-ai-testing-mcp@latest setup

# Windows (PowerShell or Command Prompt)
npx.cmd -y digital-ai-testing-mcp@latest setup
```

On Windows, type `npx.cmd`: in Windows PowerShell, plain `npx` runs a PowerShell script that the default settings block ("running scripts is disabled on this system").

It saves your access key in the OS keychain and adds the server to your AI clients. Your AI client then starts the server through npx, which downloads the package the first time and a new release the first time it starts after one is published, so you always run the newest version.

To set a client up by hand instead, [Connecting AI Clients](#connecting-ai-clients) has the entry for each one. Settings go in the client's `env` block (see [Configuration](#configuration)); you don't need an image name or a `.env` file.

**Prefer a fixed install?** Run `npm install -g digital-ai-testing-mcp` (`npm.cmd` on Windows), then use `"command": "digital-ai-testing-mcp"` with `"args": []` in the client configuration, and `digital-ai-testing-mcp setup` instead of `npx … setup` (on Windows, `digital-ai-testing-mcp.cmd setup` in Windows PowerShell, for the same reason as `npx.cmd`). That version stays until you [upgrade](#upgrading) it yourself, and the server starts without reaching the npm registry.

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

With the client configurations in this README there is no upgrade command: the client starts the newest release each time it starts the server (see [Automatic updates](#automatic-updates)). Restart your AI client, or reconnect the MCP server from its settings panel, to pick up a release — a server that is already running keeps its version.

If you chose a fixed install, upgrade it yourself:

| Install | Upgrade command | Then |
|---|---|---|
| Global npm install (`npm install -g`) | `npm install -g digital-ai-testing-mcp@latest` | Restart your AI client, or reconnect the MCP server from its settings panel. |
| GHCR image started without `--pull=always` | `docker pull ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest` | Nothing to stop or remove: the client configs start the server with `docker run --rm`, so the next start uses the new image. |
| From source (Option C) | `git pull` then `docker build -t digital-ai-testing-mcp:latest .` | Same as the GHCR image. |

To confirm the upgrade, ask your AI to call `get_server_info`, which reports the running version.

#### Update notices

When the server starts, it asks GitHub whether a newer release exists — at most once every 24 hours. If there is one, your AI assistant tells you, with the upgrade command for your install (npm, npx, a source checkout or Docker). You are told at most once a day, and `get_server_info` shows the pending update until you upgrade.

- The request carries no access key and nothing about you, your tenant or your machine.
- Startup never waits for it, and nothing happens if GitHub cannot be reached.
- Set `MCP_UPDATE_CHECK=false` to turn it off.
- With Docker, a `docker run --rm` container keeps nothing between starts, so the check and the notice happen once per start instead of once per day.

#### Automatic updates

The client configurations in this README start the newest release every time, so you get each release without running a command:

| Install | How |
|---|---|
| npm (Option A) | `npx -y digital-ai-testing-mcp@latest` — npx downloads a new release the first time the server starts after it is published. |
| GHCR image (Option B) | `docker run --pull=always …` — Docker checks the registry at every start and pulls `latest` when it has changed. |

The server does not replace itself: a release takes effect the next time your AI client starts the server.

What this means for you:

- The server starts only when the npm registry or GHCR can be reached, and the first start after a release takes longer.
- You run each release as soon as it is published.

**To stay on a version you choose** — for example when your organization reviews versions before use:

| Install | Change in the client configuration |
|---|---|
| npm | Name the version: `"args": ["-y", "digital-ai-testing-mcp@2.4.7"]`. Or install it once with `npm install -g digital-ai-testing-mcp@2.4.7` and use `"command": "digital-ai-testing-mcp"`, `"args": []` — use this form on a machine that can't reach the npm registry when the server starts. |
| GHCR image | Remove `"--pull=always"` and name the version tag: `ghcr.io/digitalai-opensource/digital-ai-testing-mcp:2.4.7`. |

The [update notice](#update-notices) then tells you when a newer release exists.

[↑ Back to top](#table-of-contents)

---

## Connecting AI Clients

**The quickest way is [`setup clients add`](#adding-the-server-to-ai-clients)**, which adds the entry to every AI client it finds. The sections below show how to add it by hand.

The examples use the npm package ([Option A](#option-a--install-via-npm-recommended)): the client starts the server through npx. Put your URL and key in the client's `env` block as shown, or leave the `env` block out if you saved them with [setup](#the-setup-command). If you run the server in Docker (Options B/C), use the [Docker client configuration](#docker-client-configuration) instead.

### Claude Desktop

Find your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** Open Claude Desktop → Settings → Developer → **Edit Config**. The location depends on how and when Claude Desktop was installed: `%APPDATA%\Claude\`, a folder under `%LOCALAPPDATA%\Packages\Claude_…\`, or `%LOCALAPPDATA%\Claude-Data\claude_…\`. On some installs **Edit Config** opens a different file than the one Claude Desktop reads. If the server doesn't appear after a restart, look for another `claude_desktop_config.json` in those folders. `setup clients` lists the candidates and asks which one to use when there is more than one.

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "npx",
      "args": ["-y", "digital-ai-testing-mcp@latest"],
      "env": {
        "DIGITAL_AI_BASE_URL": "https://your-tenant.experitest.com",
        "DIGITAL_AI_ACCESS_KEY": "your-access-key"
      }
    }
  }
}
```

Quit Claude Desktop completely (also from the system tray or menu bar) and start it again. The tools appear automatically, and the server shows as running under Settings → Developer.

### Claude Code (VS Code)

The easiest way: run `npx -y digital-ai-testing-mcp@latest setup clients add claude-code` (`npx.cmd` on Windows). It adds the server for all your projects with Claude Code's own `claude` command, using the profiles you saved with [setup](#the-setup-command). If the `claude` command isn't available in your terminal, it prints the command to run instead.

To add it by hand, run this once (it works in the terminal and from the VS Code, JetBrains and Android Studio extensions):

```bash
# macOS / Linux
claude mcp add --scope user "--env=npm_config_yes=true" "--env=DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com" "--env=DIGITAL_AI_ACCESS_KEY=your-access-key" digital-ai-testing -- npx digital-ai-testing-mcp@latest

# Windows (Claude Code needs the cmd /c wrapper to start npx)
claude mcp add --scope user "--env=npm_config_yes=true" "--env=DIGITAL_AI_BASE_URL=https://your-tenant.experitest.com" "--env=DIGITAL_AI_ACCESS_KEY=your-access-key" digital-ai-testing -- cmd /c npx digital-ai-testing-mcp@latest
```

If you saved your key with setup, leave out the two `DIGITAL_AI_*` options. Write the command exactly like this. Claude Code reads every argument after `--env NAME=value` as another variable (it would take the server name and the command too), and it refuses an option such as `-y` even after `--`, so each variable is one `--env=NAME=value` argument and `npm_config_yes=true` replaces npx's `-y`.

`--scope user` makes the server available in every project. Leave it out to add it to the current project only. A project whose `.mcp.json` defines `digital-ai-testing` uses that entry instead. `setup clients` and `setup doctor` list such projects and say how to remove each entry.

Using Docker? Use the Docker command from [Docker client configuration](#docker-client-configuration) instead.

Restart Claude Code (or run `/mcp` and reconnect) after adding the server. The tools appear automatically.

### Claude Code (JetBrains / Android Studio)

Install the [Claude Code](https://plugins.jetbrains.com/plugin/22828-claude-code) plugin from the JetBrains Marketplace, then add the server the same way as for [Claude Code (VS Code)](#claude-code-vs-code): `npx -y digital-ai-testing-mcp@latest setup clients add claude-code` (`npx.cmd` on Windows), or the `claude mcp add` command shown there.

Using Docker? See [Docker client configuration](#docker-client-configuration) — and on Windows, use forward slashes in the `.env` path.

### GitHub Copilot (VS Code)

GitHub Copilot supports MCP tools in **Agent mode** only. Register the server in one of two scopes:

- **User settings** — available in all workspaces. Open the user MCP configuration (`Ctrl+Shift+P` → "MCP: Open User Configuration") and add the same `servers` entry shown for the workspace file below. (Older VS Code versions used an `"mcp": { "servers": { … } }` block in the user `settings.json` instead.)
- **Workspace settings** — scoped to one project. Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "digital-ai-testing": {
      "command": "npx",
      "args": ["-y", "digital-ai-testing-mcp@latest"],
      "env": {
        "DIGITAL_AI_BASE_URL": "https://your-tenant.experitest.com",
        "DIGITAL_AI_ACCESS_KEY": "your-access-key"
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
      "command": "npx",
      "args": ["-y", "digital-ai-testing-mcp@latest"],
      "env": {
        "DIGITAL_AI_BASE_URL": "https://your-tenant.experitest.com",
        "DIGITAL_AI_ACCESS_KEY": "your-access-key"
      }
    }
  }
}
```

Alternatively, create a `.cursor/mcp.json` file in your project root with the same `mcpServers` object — this scopes the server to that workspace and can be committed to share it with your team.

Cursor is available on macOS, Windows, and Linux.

Using Docker? See [Docker client configuration](#docker-client-configuration).

### Other AI clients

[`setup clients add`](#adding-the-server-to-ai-clients) also configures these. To add the server by hand, use the same command and arguments as for [Claude Desktop](#claude-desktop), in each client's own format:

| Client | Configuration file | Format |
|---|---|---|
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` entry, as for Claude Desktop |
| OpenAI Codex (CLI, IDE extension, ChatGPT desktop app) | `~/.codex/config.toml` | a `[mcp_servers.digital-ai-testing]` table with `command`, `args` and an `[mcp_servers.digital-ai-testing.env]` table, or `codex mcp add` |
| OpenCode | `~/.config/opencode/opencode.json` | an `mcp` entry with `"type": "local"` and `command` as one array |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` entry, as for Claude Desktop |
| Xcode 26.3 and later (Claude Agent, Codex) | Xcode's agent MCP settings | the same command and arguments. Xcode starts its agents without your shell's PATH, so use the absolute-path entry that `setup clients` prints |

Gemini in Android Studio accepts only remote (HTTP) MCP servers, so it cannot start this server. In Android Studio, use the [Claude Code plugin](#claude-code-jetbrains--android-studio) instead.

### Docker client configuration

For [Option B](#option-b--pull-from-github-container-registry) or [Option C](#option-c--build-from-source), the client starts the container instead of npx, and credentials come from your `.env` file. In every example:

- Replace `/ABSOLUTE/PATH/TO/.env` with the full path to your `.env` file.
- `--pull=always` makes Docker fetch the newest image at each start — see [Automatic updates](#automatic-updates) to stay on one version instead.
- **Built from source (Option C)?** Replace `ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest` with `digital-ai-testing-mcp:latest` and remove `--pull=always`: an image you built yourself is not in a registry, so the pull would fail.

**Claude Desktop and Cursor** (`mcpServers` format):

```json
{
  "mcpServers": {
    "digital-ai-testing": {
      "command": "docker",
      "args": [
        "run", "--pull=always", "--rm", "-i",
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
    "run", "--pull=always", "--rm", "-i",
    "--env-file", "/ABSOLUTE/PATH/TO/.env",
    "ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest"
  ]
}
```

**Claude Code** (JetBrains / Android Studio, or VS Code) — from the project root, or add the same command under **Settings → MCP Servers**:

```bash
# macOS / Linux (bash, zsh)
claude mcp add-json digital-ai-testing '{"type":"stdio","command":"docker","args":["run","--pull=always","--rm","-i","--env-file","/absolute/path/to/.env","ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest"]}'

# Windows, PowerShell 7 (use forward slashes — backslashes are stripped by Claude Code)
claude mcp add-json digital-ai-testing '{"type":"stdio","command":"docker","args":["run","--pull=always","--rm","-i","--env-file","C:/projects/digital-ai-testing-mcp/.env","ghcr.io/digitalai-opensource/digital-ai-testing-mcp:latest"]}'
```

`claude mcp add … -- docker run --pull=always …` does not work: Claude Code refuses the `docker run` options even after `--`, so the entry is given as JSON. In Windows PowerShell 5.1 or Command Prompt, the quotes inside the JSON are lost; use PowerShell 7 or add the entry in the Claude Code panel.

> **Windows users on Docker:** always use forward slashes (`C:/path/to/.env`), never backslashes — whether you register via the CLI command above or through the Claude Code panel. Claude Code silently strips backslashes when it writes the configuration to `~/.claude.json`, which breaks the path and causes a cryptic `-32000` reconnection error ([how to fix it](#failed-to-reconnect-to-digital-ai-testing--32000)).

[↑ Back to top](#table-of-contents)

---

## The setup command

`setup` saves your connection details where the server finds them, so no AI client configuration has to contain your access key.

**Common commands, ready to copy.** The first one, on its own, walks you through adding a connection and then offers to add the server to your AI clients.

```bash
# macOS / Linux
npx -y digital-ai-testing-mcp@latest setup                # guided: add a connection, then your AI clients
npx -y digital-ai-testing-mcp@latest setup list           # your profiles and where each key is kept
npx -y digital-ai-testing-mcp@latest setup test           # check every profile with Digital.ai Testing
npx -y digital-ai-testing-mcp@latest setup clients        # which AI clients are installed and set up
npx -y digital-ai-testing-mcp@latest setup clients add    # add the server to every AI client found
npx -y digital-ai-testing-mcp@latest setup doctor         # a report for support (never contains a key)
npx -y digital-ai-testing-mcp@latest setup reports <folder>  # where finished reports are saved
npx -y digital-ai-testing-mcp@latest setup options          # server options: a smaller tool list, the report pointer, debug mode

# Windows (PowerShell or Command Prompt)
npx.cmd -y digital-ai-testing-mcp@latest setup
npx.cmd -y digital-ai-testing-mcp@latest setup list
npx.cmd -y digital-ai-testing-mcp@latest setup test
npx.cmd -y digital-ai-testing-mcp@latest setup clients
npx.cmd -y digital-ai-testing-mcp@latest setup clients add
npx.cmd -y digital-ai-testing-mcp@latest setup doctor
npx.cmd -y digital-ai-testing-mcp@latest setup reports <folder>
npx.cmd -y digital-ai-testing-mcp@latest setup options
```

**All commands.** The table and the rest of this section write only the part after `setup`. Always type the whole command: `setup list` means `npx -y digital-ai-testing-mcp@latest setup list` (`npx.cmd` on Windows). With a global npm install, the command starts with `digital-ai-testing-mcp setup`; from a source checkout, `node dist/index.js setup`.

| Command | What it does |
|---|---|
| `setup` | Guided: asks for the URL and the access key, checks them, saves them, and offers to set up your AI clients |
| `setup add [name]` | Adds a connection profile, or replaces one with the same name |
| `setup reports [folder\|off]` | Shows, sets or removes the folder finished reports are saved to. The guided `setup` offers it too, and `setup clients add` keeps an `MCP_REPORT_DIR` from an entry it replaces. See [Where reports are saved](docs/reports.md#where-reports-appear-and-are-saved) |
| `setup options [name [value\|default]]` | Shows, sets or removes a server option without editing an AI client's configuration file: `toolsets` (`MCP_TOOLSETS`), `report-pointer` (`MCP_REPORT_POINTER`), `update-check` (`MCP_UPDATE_CHECK`), `debug` (`MCP_DEBUG_MODE`), `idle-timeout` (`MCP_SESSION_IDLE_TIMEOUT_SECONDS`). For example `setup options toolsets core`, `setup options report-pointer off`, `setup options toolsets default`. Every value is checked. The options are kept in the profiles file and apply to every AI client that starts the server from your profiles; the same variable in a client's configuration wins. Restart the client afterwards. `get_server_info` and `setup doctor` show which are in effect |
| `setup list` | Lists your profiles, where each key is kept, and which one the server starts on |
| `setup default <name>` | Makes `<name>` the profile the server starts on |
| `setup remove <name>` | Deletes a profile and its key |
| `setup test [name]` | Checks one profile, or all of them, with Digital.ai Testing |
| `setup clients` | Shows which AI clients are installed and whether they are set up |
| `setup clients add [client…]` / `setup clients remove [client…]` | Adds the server to your AI clients, or removes it |
| `setup doctor` | A report to send to support: install, profiles, keychain and AI clients. It never contains a key |
| `setup path` · `setup repair` · `setup reset` | Where the profiles file is · restore it from its backup · delete every profile and its keys |

Options: `--url <url>` and `--key-stdin` (pipe the key in, for scripts) · `--plain-file` · `--default` · `--skip-check` · `--yes` (answer yes to confirmations) · `--config <file>` (with `clients add`) · `--offline` (with `doctor`). `setup help` lists them all.

### Where your key is kept

- **In your operating system's keychain** by default: Windows Credential Manager (Windows Credentials → Generic Credentials, named `<profile>.digital-ai-testing-mcp`), the macOS Keychain, or the Linux Secret Service. The service name is `digital-ai-testing-mcp` and the account is the profile name. If you move the profiles file with `MCP_CREDENTIAL_STORE_DIR`, the account is `<profile>@<that folder>` instead, so a second set of profiles (for testing, say) can never overwrite or delete the keys of your usual ones.
- **The list of profiles** — names, URLs and the default, no keys — is in `profiles.json`: `%APPDATA%\digital-ai-testing\` on Windows, `~/.config/digital-ai-testing/` on macOS and Linux. `npx -y digital-ai-testing-mcp@latest setup path` prints the location (`npx.cmd` on Windows).
- With `--plain-file`, the key is kept in `profiles.json` instead, readable only by your user account. `setup` offers this when the keychain can't be used, for example on a Linux machine without a keyring service.
- On Windows, the keychain (Credential Manager) needs the Microsoft Visual C++ runtime. Most PCs already have it. If setup says it is missing, install it from [Microsoft](https://aka.ms/vs/17/release/vc_redist.x64.exe), then run `npx.cmd -y digital-ai-testing-mcp@latest setup add <name>` again to move the key into Credential Manager.
- The key is typed at a hidden prompt (or piped in with `--key-stdin`), never as a command-line argument, and it is never shown. `setup` checks it with Digital.ai Testing before saving it.

### How the server picks a connection

- `DIGITAL_AI_BASE_URL` / `DIGITAL_AI_ACCESS_KEY` and `DAI_PROFILE_*` variables — in the AI client's configuration or a `.env` file — **always take precedence**. The profiles you saved with `setup` are added alongside them; for a name both define, the variable wins.
- The server starts on your default saved profile only when neither `DIGITAL_AI_BASE_URL` nor `DIGITAL_AI_ACCESS_KEY` is set.
- `list_environments` shows every profile and where it comes from, and `switch_environment` switches between all of them.
- A Docker container cannot reach your computer's keychain, so with Docker keep using the `.env` file.
- Set `MCP_CREDENTIAL_STORE=off` to make the server ignore the saved profiles.

### Adding the server to AI clients

`setup clients add` adds the server to every AI client it finds — Claude Desktop, VS Code and VS Code Insiders (GitHub Copilot), Cursor, Windsurf, OpenAI Codex, OpenCode and Gemini CLI — or only the ones you name, e.g. `npx -y digital-ai-testing-mcp@latest setup clients add vscode cursor` (`npx.cmd` on Windows).

- The entry contains no key.
- Each file is copied to `<file>.digital-ai-testing.bak` before it is changed, and every other server and setting in it stays as it was.
- A file that contains comments is not rewritten. `setup` prints the entry for you to paste instead.
- If the client already has a `digital-ai-testing` entry, `setup` asks before replacing it and tells you when that entry holds its own key.
- If that entry defines profiles of its own (`DIGITAL_AI_BASE_URL` / `DIGITAL_AI_ACCESS_KEY`, `DAI_PROFILE_*`) that your saved profiles don't include, `setup` offers to import them first. It checks each key, keeps it in the OS keychain and never shows it. A profile it cannot import is listed with the command to add it yourself.
- Replacing an entry keeps that client's own options (for example `disabled`, `timeout`, VS Code's `envFile`) and any variable that isn't a credential (for example `MCP_DEBUG_MODE`, `MCP_TOOLSETS`). Only the launch command, `PATH` and the URL/key variables change.
- The entry starts Node.js and npx by their full paths and sets its own PATH, so it also works in clients that don't pass your terminal's PATH to the server, such as macOS apps and Xcode. If you switch Node.js versions with nvm or volta, run this again:

  ```bash
  # macOS / Linux
  npx -y digital-ai-testing-mcp@latest setup clients add

  # Windows
  npx.cmd -y digital-ai-testing-mcp@latest setup clients add
  ```
- **Claude Code**: setup adds the server for all your projects through Claude Code's own `claude` command (`claude mcp add-json --scope user`), when that command is installed. Otherwise it prints the command to run.
- **Claude Desktop on Windows** keeps its configuration in different places depending on how it was installed. `setup` edits it only when it finds exactly one configuration file, shows you the path and asks first. If it finds several, or none, it lists them and you choose one with `--config "<file>"`.
- Restart each AI client you changed. `setup clients remove` takes the entry out again.

### If something goes wrong

| Problem | What to do |
|---|---|
| `npx : File …\npx.ps1 cannot be loaded because running scripts is disabled on this system` (or `npm.ps1`) | Windows PowerShell blocks the PowerShell scripts npm installs. Type `npx.cmd` / `npm.cmd` instead of `npx` / `npm`, or allow local scripts for your account once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (your organization's policy may override it). The AI client entries setup writes start Node.js directly and are not affected |
| Every tool answers "SETUP REQUIRED" | The server found no connection. Run `npx -y digital-ai-testing-mcp@latest setup` (`npx.cmd` on Windows), or put `DIGITAL_AI_BASE_URL` and `DIGITAL_AI_ACCESS_KEY` in the client's `env` block |
| A profile shows as not usable | `npx -y digital-ai-testing-mcp@latest setup list` says why. `npx -y digital-ai-testing-mcp@latest setup add <name>` replaces it (`npx.cmd` on Windows) |
| You rotated your access key | `npx -y digital-ai-testing-mcp@latest setup add <name>` (`npx.cmd` on Windows) with the new key replaces the old one; restart your AI client |
| `profiles.json` was damaged or edited by mistake | `npx -y digital-ai-testing-mcp@latest setup repair` (`npx.cmd` on Windows) restores the previous version (the damaged file is kept as `profiles.json.before-repair`) |
| You want to start over | `npx -y digital-ai-testing-mcp@latest setup reset` (`npx.cmd` on Windows) deletes every profile and the keys it saved in the keychain |
| Setup says the OS keychain needs the Microsoft Visual C++ runtime | Install it from [Microsoft](https://aka.ms/vs/17/release/vc_redist.x64.exe), then run `npx.cmd -y digital-ai-testing-mcp@latest setup add <name>` again. Until then, setup can keep the key in the profiles file |
| The key prompt says "No access key was entered" after you pasted | Ctrl+V doesn't paste at the hidden prompt in a Windows PowerShell or Command Prompt window. Right-click to paste, then press Enter |
| You are asking support for help | Send the output of `npx -y digital-ai-testing-mcp@latest setup doctor` (`npx.cmd` on Windows). It never contains a key |

You can always go back to putting your URL and key in the AI client's `env` block: those variables take precedence over saved profiles.

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

Set up named profiles to switch between keys (for example, Cloud Admin and a project) without editing files.

**With setup:** add each key once under its own name, for example `admin` for your Cloud Admin key and `mobile-qa` for a project key, then choose the one the server starts on. See [The setup command](#the-setup-command).

```bash
# macOS / Linux
npx -y digital-ai-testing-mcp@latest setup add admin
npx -y digital-ai-testing-mcp@latest setup add mobile-qa
npx -y digital-ai-testing-mcp@latest setup default admin

# Windows
npx.cmd -y digital-ai-testing-mcp@latest setup add admin
npx.cmd -y digital-ai-testing-mcp@latest setup add mobile-qa
npx.cmd -y digital-ai-testing-mcp@latest setup default admin
```

**With variables:** with the npm install, add them to the `env` block of your AI client's configuration; with Docker, add them to your `.env` file:

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

Set these as environment variables: in the client's `env` block (npm install) or in your `.env` file (Docker). The URL and key can instead be saved once with [setup](#the-setup-command).

| Variable | Required | Default | Description |
|---|---|---|---|
| `DIGITAL_AI_BASE_URL` | ✅ unless saved with [setup](#the-setup-command) | — | Your Digital.ai tenant URL |
| `DIGITAL_AI_ACCESS_KEY` | ✅ unless saved with [setup](#the-setup-command) | — | Access key — see [Access Keys](#access-keys) for the three access levels and key formats. Variables take precedence over profiles saved with setup |
| `MCP_DEPLOYMENT_MODE` | Optional | `local`, or `docker` inside a container | Where the server runs: `local` (your own machine — file tools read and write your files) or `docker` (a container, whose filesystem is not yours). You rarely need to set it: the server detects a container, and the published Docker image sets `docker` |
| `MCP_CREDENTIAL_STORE` | Optional | on | `off` makes the server ignore the profiles saved with [setup](#the-setup-command) |
| `MCP_CREDENTIAL_STORE_DIR` | Optional | `%APPDATA%\digital-ai-testing` (Windows), `~/.config/digital-ai-testing` (macOS, Linux) | Folder of the saved profiles file (`profiles.json`). Keys that profiles in a moved folder keep in the OS keychain are named `<profile>@<folder>`, apart from your usual ones |
| `MCP_TOOLSETS` | Optional | all | Comma-separated toolsets to load in full: `devices`, `apps`, `reporting`, `performance`, `inspection`, `authoring`, `browsers`, `admin` (or `all`, or `core` for only the always-loaded core). See [Toolsets](#toolsets-reducing-context-size) |
| `MCP_UPDATE_CHECK` | Optional | `true` | `false` turns off the daily check for a newer release and its notice. See [Update notices](#update-notices) |
| `MCP_REPORT_POINTER` | Optional | `true` | `false` removes the one-line note that data tools add to a large result, telling the AI it can present the data as a report |
| `MCP_DEBUG_MODE` | Optional | `false` | `true` records remediation notes and a tool-call event log to help improve this MCP. You can also turn it on or off by asking the AI, until the server restarts. See [Debug mode](#debug-mode-remediation-notes) |
| `MCP_REMEDIATION_DIR` | Optional | — | Debug mode only: folder to write remediation files to (overrides project detection) |
| `REQUEST_TIMEOUT_MS` | Optional | `30000` | API request timeout in milliseconds |
| `UPLOAD_TIMEOUT_MS` | Optional | `120000` | File upload timeout in milliseconds |
| `INSPECTION_SESSION_TIMEOUT_MS` | Optional | `120000` (`240000` for `@emulator='true'` queries and automotive projection) | How long `start_inspection_session` waits for the platform to allocate a device. Emulators and simulators boot inside that request (an iOS simulator took 154 s live). Raising it only helps a slow boot: an emulator can also fail to boot after several minutes, so after a timeout try another model or OS version before waiting longer |
| `USAGE_REPORT_TIMEOUT_MS` | Optional | `240000` | Wall-clock cap on one usage-report CSV fetch (`download_usage_report` / `summarize_usage_report`). An unfiltered month can be ~12 MB and take minutes to transfer; a fetch that outlives the cap returns an error that says how to narrow it |
| `ACCESS_PROBE_TIMEOUT_MS` | Optional | `8000` | Timeout for the access-level detection call |
| `MCP_REPORT_DIR` | Optional | — | A folder on the server's machine where finished reports are saved (wins over the folder set with `setup reports`). See [Where reports are saved](docs/reports.md#where-reports-appear-and-are-saved) |
| `MCP_REPORT_SYNC_LIMIT_MS` | Optional | `45000` | A `create_report` request estimated to take longer than this is not run during the tool call: the answer gives the estimate, a smaller window that fits, and the option to run it as a background job. Raise it if your AI client waits longer for a tool call |
| `MCP_SESSION_IDLE_TIMEOUT_SECONDS` | Optional | `300` | How long an inspection session may sit without a command before the platform ends it and frees the device (60–1800). Without a limit the platform ended idle sessions after roughly 1–2 minutes, which is shorter than a pause between prompts. `start_inspection_session` also takes `idleTimeoutSeconds` per session. Browser sessions on a phone use it too (they ended before 90 s idle without it); desktop browser sessions always end after 5 minutes idle — a platform limit this setting cannot raise |
| `MCP_SHUTDOWN_TIMEOUT_MS` | Optional | `8000` | When the AI client closes the server, open inspection and browser sessions are closed (device released, session report deleted) by a short-lived background process. Only if that process can't start does the server close them itself, waiting at most this long |
| `AXE_DEVTOOLS_API_KEY` | Optional | — | Deque Axe DevTools Mobile key used by `includeAxeScan` boilerplate |
| `TEST_ORCHESTRATOR_JAR_URL` / `TEST_ORCHESTRATOR_JAR_SHA256` | Optional | pinned | Override the Test Orchestrator agent download location; both are required |
| `MCP_SERVER_NAME` | Optional | `digital-ai-testing-mcp` | Server identity shown in the AI client |
| `MCP_SERVER_VERSION` | Optional | version from `package.json` | Override the reported server version (rarely needed) |

Additional `DAI_PROFILE_{NAME}_URL` / `DAI_PROFILE_{NAME}_KEY` pairs configure named profiles for multi-project or multi-environment use. See [Using multiple keys](#using-multiple-keys) and `.env.example` for examples.

### Debug mode (remediation notes)

Set `MCP_DEBUG_MODE=true` while evaluating or developing the MCP to collect feedback for improving it. With the default `false`, nothing changes.

**Turning it on or off for one run.** Ask the AI, for example "turn on debug mode" or "turn off debug mode". It calls `set_debug_mode`, and the change lasts until the MCP server restarts (restarting the AI client restarts it). After that, `MCP_DEBUG_MODE` in your client configuration applies again.

When it is on:

- **The AI records notes.** The server asks the AI client to call `record_remediation_note` (always listed, but it records nothing while debug mode is off) whenever it:
  - hits an unexpected error;
  - wastes calls because guidance was unclear;
  - is corrected or stopped by you;
  - gives up;
  - finds a better path than the one recommended;
  - spots a way to make things cleaner or cheaper.

  It records each note once the situation is resolved or abandoned, not in the middle of your task. Expected outcomes, such as deliberate negative tests or a safety check that worked as intended, are not recorded: they show nothing to improve.
- **The server logs what it sees.** Every tool call is logged with its duration, response size and outcome (ok, error or guard), with flags for retries and repeated calls. This is objective data the AI can't under-report. Text typed on a device (`type_into_element`, the clipboard) and any password argument are logged as a length only, never the value.
- **The AI is told up front.** The debug-mode instructions come first in what the server sends at connect time, and `get_server_info` and `check_connectivity` show "Debug mode: ON".
- **Errors get a reminder.** The first time a tool returns a given error or guard, the response starts with a one-line reminder to record a note if it was unexpected (in JSON responses, as a `_debugMode` field).

Debug mode costs extra tokens (the instructions and the notes). Leave it off for normal use, and don't use debug sessions as token baselines.

**Where the files go:** a `remediation/` folder in the root of **the project the AI is working in**, so each note sits next to the app and tests it's about.

| Install | Notes | Event log |
|---|---|---|
| npm (local mode) | The server writes `<project>/remediation/<yyyymmddhhmmss>-<id>.md` | The server writes `<project>/remediation/<yyyymmddhhmmss>-<id>.events.jsonl` |
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

## Optimizing Token Consumption

What the AI reads costs tokens: the tool list in every conversation, and every result it receives. The server keeps both small by default; these settings and habits make them smaller still. None of them hides a capability.

### Toolsets (reducing context size)

Every tool definition the server lists is read by the AI before it does anything, in every conversation. Set `MCP_TOOLSETS` to the areas you use and the others are listed with one line each instead of their full description:

| `MCP_TOOLSETS` | Size of the tool list | Share of the full list |
|---|---|---|
| *(unset: everything in full)* | about 390,000 characters (roughly 100K tokens) | 100% |
| `reporting` or `inspection` | about 180,000 characters (roughly 45K tokens) | 46% |
| `authoring` | about 170,000 characters | 44% |
| `admin`, `devices`, `apps` or `performance` | 155,000 to 166,000 characters | 40–42% |
| `inspection,authoring` | about 220,000 characters (roughly 55K tokens) | 56% |
| `core` | about 130,000 characters (roughly 32K tokens) | 33% |

Measured with all 230 tools. Tokens are estimated at about four characters each; the exact count depends on the AI model. The server's instructions add about 7,500 characters whatever the setting.

Nothing becomes unavailable. Tools outside the chosen toolsets are still listed, with a one-line description. When the AI calls one, the server loads that whole toolset and replies with the tool's full description and parameter guidance, then the AI calls it again — so it always sees the detailed usage guidance before the tool runs. That first call executes nothing (it is marked read-only for clients that honour tool annotations). The report tools named after one report are the exception: their first call builds the report when its arguments are valid, so a report is one call under any setting. The AI can also load toolsets up front with `enable_toolset`, whose reply lists a typed signature for every tool it loaded — so even a client that never refreshes its tool list has the exact parameter names and types. Leave `MCP_TOOLSETS` unset (the default) to load everything in full.

| Toolset | Covers |
|---|---|
| `devices` | Devices, device groups, reservations, health, agents, regions, the device health and device coverage reports |
| `apps` | Application repository, file repository, provisioning profiles |
| `reporting` | Test reports, analytics, root-cause analysis, test views, coverage, the test report tools (summary, trend, breakdown, reliability, release readiness, failure analysis, inventory) |
| `performance` | Performance transactions and comparisons, NV servers, the performance overview and comparison reports |
| `inspection` | Live device and browser inspection, Android Auto / CarPlay, remote debug |
| `authoring` | Test boilerplate, Espresso / XCUITest / Maestro / Playwright test runs |
| `browsers` | Browser listing and Selenium sessions |
| `admin` | Users, projects, backups, usage reports, the usage summary, device utilization and license usage reports, project workflows |

Set it without editing a configuration file: `setup options toolsets reporting` (see [the setup command](#the-setup-command)).

Always loaded in full: environment and connection tools (`get_server_info`, `switch_environment`, …), `enable_toolset`, `validate_test_script`, and the two general report tools, `create_report` and `render_report`. `create_report` builds every report in one call under any setting; the report tools named after one report (`create_test_summary_report` and the others) load with the toolset shown above.

### Ask for finished work, not raw data

- **Ask for a report rather than having the AI build one.** The server fetches the data, draws the charts and writes the file, so a [ready-made report](#ready-made-reports) costs the AI a few hundred tokens; writing the same page itself takes about 7,000 output tokens (measured). For other data, `render_report` takes a short outline and the server builds the page.
- **Set a report folder** with `setup reports <folder>` if your AI client does not show reports inline. Without one, some clients have the AI write the report file out again, which costs about a minute and 6,000 tokens per report. Claude Desktop shows reports in the conversation and needs no folder.
- **Let the platform count.** For "how many", "what share" or "by platform" questions, the grouped test counts and the count-based reports (trend, breakdown, reliability, release readiness, inventory) are counted by the platform and read no individual runs: a year of history comes back in seconds and a few kilobytes. A grouping with very many groups returns the 500 largest (`maxGroups`) and says how many were left out.
- **Prefer summaries to exports.** `summarize_usage_report` returns totals from a usage CSV that can be tens of megabytes; `summarize_test_failures` and `get_device_health_summary` do the same for failures and devices.

### Keep lists and inspection results short

- **Filter before you raise limits.** Lists stop at 50 records by default (`maxResults` or `limit`, up to 500), and the answer says when more exist. A filter (status, platform, user, date range) is cheaper than a longer list.
- **`list_test_reports fields: "compact"`** returns only the main columns, about half the size; call `get_test_report` for the records that matter.
- **Inspection:** `get_element_tree` leaves out the raw page source unless you ask for it (`includeRawXml`), and `find_elements` details the first 20 matches. A screenshot is an image and costs more than the element list, so ask for elements when text is enough.

### Switch off what you don't need

- **Debug mode** (`MCP_DEBUG_MODE`, off by default) has the AI write notes about problems it meets, which costs extra tokens. Turn it on for a pilot or while investigating, then off again (*"turn off debug mode"*).
- **The report suggestion line.** A result that holds a list of data starts with one line (about 250 characters) suggesting a report, at most once per tool every two minutes. `setup options report-pointer false` or `MCP_REPORT_POINTER=false` turns it off.

All of these settings can be kept with `setup options` (see [the setup command](#the-setup-command)) instead of in each AI client's configuration.

[↑ Back to top](#table-of-contents)

---

## What You Can Do

The server follows the work as it happens: find a device, **explore** an app or web page on it, **create** a test from what you saw, **run** suites on the platform, **understand the results** (finished reports, failure analysis, performance comparisons, usage), and **manage the projects** and the lab around it. Each step has its own section below; you never need tool names, only plain requests.

### Example prompts

- *"Show me the overall health of the device farm: how many devices are available, reserved, and offline?"*
- *"Find an available Android phone running at least version 13 in the US2 region"*
- *"Open my app on that phone and show me the login screen's elements"*
- *"Inspect our app's login screen on an Android phone and build a test from the elements you find"*
- *"I'm new: show me a sample test on the ExperiBank demo app"* (the sample app every environment starts with, for trying the platform)
- *"Did all tests in the QA project pass today? I need a go/no-go for the release."*
- *"Why are tests failing this week? Make a failure analysis report"*
- *"Did the latest release introduce a CPU regression? Compare version 4.2.0 vs 4.3.0 of our app on Android."*
- *"Set up a project for the Payments team with 6 devices in US2, 3 iOS and 3 Android"*

**[→ docs/examples.md](docs/examples.md)** has 200+ prompts organized by scenario: farm health, device groups, regression sign-off, test analytics, performance, usage reports, interactive inspection, project setup, and more.

### Tasks at a glance

| I want to… | Where to look |
|---|---|
| Check farm health, find a device, reserve it, manage groups and tags | [Devices](docs/tools.md#devices), [Device Groups](docs/tools.md#device-groups), [Health & Diagnostics](docs/tools.md#health--diagnostics), [Reservations](docs/tools.md#reservations) |
| Upload, install or find the latest build of an app; manage test files and iOS profiles | [Applications](docs/tools.md#applications), [Repository](docs/tools.md#repository), [Provisioning Profiles](docs/tools.md#provisioning-profiles) |
| Explore an app or web page live with the AI | [Explore Apps and Browsers Live](#explore-apps-and-browsers-live) |
| Create an automated test | [Creating Tests](#creating-tests) |
| Run Espresso, XCUITest, Maestro or Playwright suites on the platform | [Running Tests](#running-tests) |
| Get a finished report to read or share (test summary, release readiness, device health, license usage, or any data) | [Ready-made reports](#ready-made-reports) · [docs/reports.md](docs/reports.md) |
| Find out why a test failed | [Investigating failures](#investigating-failures) |
| Compare performance between versions, devices or networks | [Performance comparison](#performance-comparison) |
| Export or summarize platform usage *(Cloud Admin)* | [Usage reports](#usage-reports) |
| Set up, wind down or delete a project; manage users | [Managing Projects](#managing-projects), [Users](docs/tools.md#users), [Projects](docs/tools.md#projects) |

### All capability areas

229 tools across 28 capability areas. The complete per-tool reference — descriptions, filters, access requirements and usage notes — is in **[docs/tools.md](docs/tools.md)**.

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
| [Test Runs](docs/tools.md#test-runs-espresso--xcuitest--maestro) | 6 | Run Espresso, XCUITest, Maestro and Playwright suites on the platform; status, cancel, local command; generate Maestro flows |
| [Test Views](docs/tools.md#test-views) | 7 | Dashboard view groups |
| [Transactions & Performance](docs/tools.md#transactions--performance) | 4 | CPU/memory/battery/Speed Index analytics |
| [Agents](docs/tools.md#agents) | 2 | Host machine status *(Cloud Admin)* |
| [Regions](docs/tools.md#regions) | 2 | Region status and infrastructure topology *(Cloud Admin)* |
| [NV Servers](docs/tools.md#nv-servers) | 2 | Network Virtualization servers *(Cloud Admin)* |
| [Server, Environments & Toolsets](docs/tools.md#server-environments--toolsets) | 8 | Server info, connectivity and workflow readiness checks, named connection profiles and runtime switching, toolset loading, debug mode on/off and remediation notes |
| [Workflows](docs/tools.md#workflows) | 3 | Project lifecycle orchestration (set up, release, tear down) |
| [Boilerplate Generation](docs/tools.md#boilerplate-generation) | 4 | The framework structure of Appium and Selenium test projects (Java JUnit 5, Java TestNG, Node.js, Python, Robot Framework, Playwright) in the framework you choose, reporting the real outcome; your app's steps are written from a live inspection; Test Orchestrator agent install; validate scripts before delivery |
| [Remote Debug](docs/tools.md#remote-debug) | 1 | Connect a cloud Android or iOS device as if it were attached locally (ADB / usbmuxd) |
| [Mobile Inspection Sessions](docs/tools.md#mobile-inspection-sessions) | 32 | AI-driven live device interaction and app exploration (map your app’s screens and verified locators in the background, beta) — screenshots, element discovery, full gesture set, keys, app/device control, webview contexts, device log, HAR/log capture, network, camera injection, Android Auto / CarPlay projection, audio play/record, mock biometric authentication |
| [Web Inspection Sessions](docs/tools.md#web-inspection-sessions) | 9 | AI-driven live browser interaction — navigate, Shadow DOM element discovery, CSS selector verification, browser-neutral Selenium script generation |
| [Performance Comparison](docs/tools.md#performance-comparison) | 4 | Two-set Speed Index comparison with confound detection, MAD outlier exclusion, and fresh-sample generation |
| [Usage Reports](docs/tools.md#usage-reports) | 3 | Platform usage-report CSV export and in-memory aggregation — device reservations, users/devices/browser usage, user statistics, license usage; multi-section CSVs with User Tag, Device Tag and Device Group columns (tag/group lists are split when grouping), 2-year retention (platform 25.9+); large unfiltered exports run only after you explicitly agree (`confirmLargeExport`) *(Cloud Admin)* |
| [Reports](docs/reports.md) | 16 | Finished, branded HTML reports in one call: 14 ready-made reports (test summary, trend, breakdown, reliability, release readiness, failure analysis, inventory, device health, coverage and utilization, license usage, usage summary, performance overview and comparison) and a report of any data |
| [Resources & Prompts](docs/tools.md#resources--prompts) | — | 2 ambient resources, 6 guided prompts |

[↑ Back to top](#table-of-contents)

---

## Explore Apps and Browsers Live

An inspection session opens a live connection to a real device or browser so the AI can see the screen and interact with it — useful for exploring an app and capturing real element IDs before writing a test.

- **Mobile** ([tools](docs/tools.md#mobile-inspection-sessions)) — Android and iOS, on both Appium Grid and Appium Server projects: screenshots, element discovery, the full gesture set, keys, app/device control (including background/resume, mid-session install from the repository and a webview-cache reset), hybrid-app webview contexts (`webview_context`), the live device log, HAR and device-log capture into the file repository, network toggles and NV network conditions, camera image injection, device diagnostics (battery, screen, dark mode, iOS accessibility audit), Android Auto / CarPlay projection, audio play/record on devices with an audio line, and mock biometric authentication. The session shares a watch-only live view URL so you can follow along. iOS behaves differently in a few places ([limitation 29](docs/limitations.md#29-ios-inspection-sessions-differ-from-android)), and Appium Grid projects support fewer commands ([limitation 18](docs/limitations.md#18-appium-grid-projects-support-fewer-commands-than-appium-server)).
- **Browser** ([tools](docs/tools.md#web-inspection-sessions)) — desktop browsers, or Chrome / Safari on a cloud phone (`mobilePlatform`): navigate, discover elements (including inside Shadow DOM), verify CSS selectors, read the console and failed network requests (`get_browser_log`; Chrome, Edge, Firefox and Opera), open staging sites with self-signed certificates (`acceptInsecureCerts`) and generate browser-neutral Selenium scripts. See [limitation 39](docs/limitations.md#39-browser-inspection-sessions-what-differs-by-browser).
- **Remote debug** ([tools](docs/tools.md#remote-debug)) — `get_remote_debug_command` makes a cloud device appear as if it were plugged into your machine (over ADB for Android, usbmuxd for iOS), so Android Studio, Xcode and command-line ADB can use it — for example for shell commands or file push. Install the app **before** connecting (see [Troubleshooting](#common-symptoms)).

Example prompts: [Interactive Inspection](docs/examples.md#interactive-inspection-ai-driven-test-building), [Android Auto / CarPlay](docs/examples.md#android-auto--carplay), [Web Browser Inspection](docs/examples.md#web-browser-inspection-ai-driven-browser-test-building).

[↑ Back to top](#table-of-contents)

---

## Creating Tests

### Two ways to create a test

The server supports two ways of creating a test, for both mobile and web, and the AI is instructed to pick between them based on context:

**Autonomous** — `get_test_boilerplate` (mobile) / `get_web_test_boilerplate` (web)
- **When:** your intent is specific — a standard flow ("create a login test") or step-level detail — AND the selectors are known (app source in the workspace, or a prior inspection session).
- **Your involvement:** you choose the test framework once per project; after that none is required. The AI fills the boilerplate's structure with steps built from your app's source or from verified selectors, following best practices.
- **Output:** in an IDE, a local test automation project; in a chat-only client, portable project files shown inline.

**Interactive** — `start_inspection_session` / `start_browser_inspection_session`, or the `collaborative_test_creation` / `collaborative_web_test_creation` prompts
- **When:** the request is vague ("I want a test for app X"), the AI has no access to the app's source (chat-only, or an IDE without this app's code), or you want to watch or drive on a live device or browser.
- **Your involvement:** collaborative — the AI builds the test step by step with you (browser sessions relay screenshots; mobile sessions share a live device view URL). The mobile prompt starts from your app and its version, then asks you for the framework; it works for Android and iOS (the platform comes from the app record), every mobile framework, and a Maestro flow on Android, and never substitutes another app. The web prompt has no default framework either.
- **Output:** the same, plus selectors verified against the real app or page along the way.

**A mix is often best:** even in autonomous mode, the AI can open a short inspection session — with no involvement from you — to capture or check element IDs or CSS selectors against the real build. The AI is explicitly instructed to **never make up selectors**: when in doubt it checks live, and when the mode itself is unclear it asks.

> **Stronger guarantees:** the server sends this policy to the AI automatically (in its MCP `instructions`), both boilerplate tools return your app's steps as marked placeholders, never guessed ones, and `validate_test_script` fails a test until those placeholders are replaced. But not every client passes server `instructions` on to the AI, and no MCP server can stop an AI from writing a test file by hand — so you can add a client-side reinforcement for a guarantee that doesn't depend on the client. See **[Recommended agent guardrails](docs/recommended-agent-guardrails.md)**.

### Choosing the test framework

You choose the framework and language your tests are written in (Java with JUnit 5 or TestNG, Python, JavaScript with WebdriverIO, Robot Framework, or Playwright for web), and you choose it once per project. The AI does not pick one for you.

- **The first time** you ask for a test in a project, the server looks at what the project already holds and recommends a framework, without generating code. When the AI runs in your IDE (Claude Code, VS Code) and the server runs on your machine, it reads the build files and test frameworks in your workspace folder, so the recommendation matches your stack. Otherwise it recommends from the cloud project.
- **You are asked.** Where the AI client supports it, the server asks you directly with a short choice form; elsewhere the AI asks you in the conversation.
- **Your answer is remembered** for that project (in the server's settings folder on your machine, `test-frameworks.json` next to the credential store; `MCP_FRAMEWORK_CHOICE_DIR` moves it), so later tests in the same project are not asked again.
- **One framework per project by default.** If the project already has the framework you chose, only the new test and screen files are returned; the build files come back for reference, to compare dependencies, not to overwrite yours. A second, different framework next to an existing one is added only when you ask for it (`newFramework: true`).
- **CI and headless runs** with nobody to ask: set `MCP_FRAMEWORK_CHOICE=trust-caller` and the language the caller passes is used without asking.

### Mobile app tests (`get_test_boilerplate`)

Generates the framework structure of an Appium test project for your app: build and dependency files, capabilities and session setup for your project's mode (Appium Server or Appium Grid), explicit-wait helpers, status reporting, parallel-run notes and, if you want them, page objects. Your app's flow is a marked placeholder block with a fail guard, because the steps must come from your real app: the AI writes them from selectors captured in a live inspection. The result says `runnable: false` until then. The Digital.ai server URL is filled in from the active connection profile. The generated files contain **no access key**: they read it from the `DIGITAL_AI_ACCESS_KEY` environment variable and stop with a clear message if it is unset (a key-free `.env.example` lists what to set). Use a project-scoped key there rather than your admin key, and store it as a secret in CI.

**Recommended workflow** for building a new test:

0. Upload your build (`upload_application_file`, or `get_application_upload_command` when the server runs in Docker), or pick it with `list_applications`
1. `get_application_info` — confirm package name, launch activity, and app ID
2. Choose the test framework (you decide; see [Choosing the test framework](#choosing-the-test-framework))
3. `find_available_device` — select a healthy device and read its `region`
4. `install_application` — install the app on that device before starting a session
5. `start_inspection_session` — capture real element IDs with `get_element_tree` / `find_elements`
6. `get_test_boilerplate(appId, language, confirmedByUser, region, …)`: returns the framework structure with placeholder steps
7. Replace the placeholder steps with steps built from the selectors captured in the inspection
8. [`validate_test_script`](#check-a-test-before-you-deliver-it-validate_test_script) — before saving or presenting the test
9. Run the test, then `stop_inspection_session` and `release_device` — explicit cleanup

> **Your app, never a stand-in:** name your app with `appId`, `packageName` (with `mainActivity`) or `bundleIdentifier`. If the app cannot be found, the call fails; it never falls back to another app. With no app at all, the structure comes with `<your app package …>` placeholders and a note for the AI to ask you which app; a missing main activity becomes a `<your main activity …>` placeholder. The structure is always returned (`confirmSelectorsVerified` is still accepted but no longer changes anything); `validate_test_script` keeps a test from being delivered while its steps are still placeholders.
>
> **Demo and training:** `demo: true` (or naming the ExperiBank app itself) returns a complete, runnable test for ExperiBank, the sample app every Digital.ai environment is provisioned with. Use it to try the platform before loading your own app; it is never a starting point for your app's test.

**Finding element locators:** use an inspection session first — `start_inspection_session` → `get_element_tree` / `find_elements` gives the AI the element tree, screenshots and gestures, and is the only way to capture verified selectors inside the MCP. `open_mobile_studio` (the platform's browser-based UI Inspector) is a visual alternative that needs no local tooling. For direct device access (ADB shell commands and file push on Android, Xcode on iOS), use `get_remote_debug_command` to connect the device locally.

> ⚠️ Don't run the generated project to find out what's on screen: its steps are placeholders until they are filled from an inspection, and running it creates Incomplete sessions visible to the whole team. Discover selectors with an inspection session (or `open_mobile_studio`) first, write the steps from them, and run `validate_test_script`, which reports the placeholders until every one is replaced.

<details>
<summary><strong>Parameters</strong></summary>

| Parameter | Values | Default |
|---|---|---|
| `platform` | `android` \| `ios` | _(required)_ |
| `language` | `java-junit5` \| `java-testng` \| `nodejs` \| `python` \| `robot` (Appium Server projects only): the framework YOU chose. Leave it out on the first call for a project to get the recommendation | _(the project's saved choice)_ |
| `confirmedByUser` | `true` when you chose `language`; saves it as the project's framework | _(optional)_ |
| `newFramework` | `true` to add a second, different framework to a project that already has one | _(optional)_ |
| `demo` | `true` for the runnable ExperiBank sample-app test (demos and training only) | `false` |
| `appId` | Numeric app ID from `list_applications` | Recommended |
| `deviceCategory` | `PHONE` \| `TABLET` \| `FOLDABLE` (platform 26.10+; a foldable is never matched by `PHONE`) | `PHONE` |
| `testName` | Any string | `"My First Mobile Test"` |
| `packageName` | Android package name (e.g. `com.mycompany.app`) | _(optional)_ |
| `mainActivity` | Android main activity (e.g. `.MainActivity`) | _(optional)_ |
| `bundleIdentifier` | iOS bundle ID (e.g. `com.mycompany.app`) | _(optional)_ |
| `region` | Region code from `find_available_device` response (e.g. `US2`, `SG1`) | _(optional, strongly recommended)_ |
| `structure` | `flat` \| `page-objects` — one class per screen (a base screen with the explicit-wait helpers and a per-platform locator chooser, so one screen class serves Android and iOS) plus a test that reads as the flow. Java on Appium Server projects and Node.js (both modes); other combinations are generated flat with a note | `flat` |
| `projectType` | `standalone-gradle` \| `standalone-maven` \| `android-gradle-submodule` | `standalone-gradle` |
| `includePerformanceTransactions` | `true` \| `false` | `false` |
| `includeAxeScan` | `true` \| `false` | `false` |
| `confirmSelectorsVerified` | Accepted for older callers; changes nothing | _(optional)_ |
| `orchestration` | `auto` \| `on` \| `off` | `auto` |
| `orchestrationMaxRetries` | `0`–`5` | `2` (`0` for placeholder or performance tests) |
| `automotiveProjection` | Android Auto / CarPlay resolution | _(optional)_ |
| `reportStatus` | `true` \| `false` — the platform report shows the real outcome (a failed assertion is reported Failed with its message); the steps run inside a named steps group on both server modes | `true` |
| `appiumVersion` | Appium Server version, e.g. `"2.18.0"` (Appium Server projects; not with `includeAxeScan`) | platform default |
| `newSessionWaitTimeout` | Seconds (10–3600) to wait for a free matching device before failing with the platform's reason | _(optional)_ |
| `reportKeys` | Custom report columns, e.g. `{"build": "1.4.0"}` — find the runs later with a `list_test_reports` filter | _(optional)_ |
| `appReset` | `reinstall` (the platform reinstalls the app at every session start) \| `keep-data` (launch the installed app, keep its data) — Appium Server projects | `reinstall` |
| `deviceLanguage` | e.g. `en_US` — sets `appium:language` + `appium:locale`. iOS: the app, for this session; **Android: the whole device, and it stays changed** — Appium Server projects | _(optional)_ |
| `autoAcceptAlerts` | `true` — iOS accepts every native alert as it appears (also hides alerts a test should check) — Appium Server projects | _(off)_ |
| `platformOptions` | `releaseDevice`, `reservationDuration`, `devicePool`, `commandScreenshot`, `dontGoHomeOnQuit` → `digitalai:*` capabilities — Appium Server projects | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

</details>

**Generated files.** `projectType` controls the Java output layout only (it is ignored for Node.js, Python and Robot Framework): `standalone-gradle` produces `src/test/java/` with both `build.gradle` and `pom.xml`; `standalone-maven` produces `pom.xml` only; `android-gradle-submodule` puts the files under `e2e-tests/` (with `e2e-tests/build.gradle`) for embedding in an existing Android Studio project.

| Language | Files |
|---|---|
| `java-junit5` / `java-testng` | `src/test/java/LocalAndroidTest.java` or `LocaliOSTest.java` + build file(s) per `projectType`; with `structure: "page-objects"` also `src/test/java/screens/BaseScreen.java` (the explicit-wait helpers) and `screens/AppScreen.java`, a placeholder screen for your app (the ExperiBank demo gets `LoginScreen.java`, `DashboardScreen.java` and `PaymentScreen.java` instead); orchestrated projects add `orchestrator/config.template.yml`, `orchestrator/.gitignore` and `lib/.gitignore`. Appium Server projects pin java-client 11 + Selenium 4.51; Grid projects stay on java-client 7 |
| `nodejs` | `package.json` + `wdio.conf.js` + `test/specs/AndroidNative.js` / `test/specs/iOSNative.js` + `setup-steps.sh` (WebdriverIO 7.40 for Appium Grid projects, WebdriverIO 9 for Appium Server); with `structure: "page-objects"` also `test/screenobjects/AppScreen.js` (the explicit-wait helpers) and `PlaceholderScreen.js`, a placeholder screen for your app (the ExperiBank demo gets `LoginScreen.js`, `DashboardScreen.js` and `PaymentScreen.js` instead) |
| `python` | `AndroidNative.py` / `iOSNative.py` + `requirements.txt` |
| `robot` | `tests/AndroidNative.robot` / `tests/iOSNative.robot` + `tests/DigitalAiReport.py` (report keywords) + `requirements.txt` (Robot Framework 7.5, AppiumLibrary 3.2.1). Appium Server projects only; not combinable with `includePerformanceTransactions`, `includeAxeScan` or `automotiveProjection` |

The boilerplate is the framework structure: for your app, the steps are placeholders that the AI fills from an inspection of your app. When the project already has the chosen framework, only the test and screen files are returned and the build files come back under `referenceFiles`. For a quick start on the platform itself, `demo: true` returns a runnable test for the ExperiBank sample app that every environment is provisioned with (clearly a demo, not your test).

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

Generates the framework structure of a Selenium (or Playwright) test project for browser testing, in the framework you choose for the project (see [Choosing the test framework](#choosing-the-test-framework)). The page's steps are placeholders that the AI fills from selectors verified in a browser inspection session. The Digital.ai server URL is filled in from the active connection profile; the access key is read from the `DIGITAL_AI_ACCESS_KEY` environment variable, never written into the files.

**Recommended workflow** for building a new web test:

1. `list_available_browsers` — confirm which browsers and OS combinations are available in your region
2. `start_browser_inspection_session` — open a live browser session on the target URL
3. `get_page_dom` — extract the rendered DOM, including shadow trees; note element IDs and `data-testid` values
4. `find_web_elements` / `tap_element` / `type_into_element` — interact with elements to verify selectors work
5. `take_inspection_screenshot` — relay screenshots at each key step for verification
6. `stop_browser_inspection_session`
7. `get_web_test_boilerplate(language, confirmedByUser, url, …)`: returns the framework structure (once the session is stopped, pass `shadowDomSupport: "always"` if `get_page_dom` reported shadow DOM)
8. Replace the placeholder steps with steps built from the verified selectors, then run [`validate_test_script`](#check-a-test-before-you-deliver-it-validate_test_script)

> The structure is always returned, with or without `url`; `confirmSelectorsVerified` is still accepted but no longer changes anything. There is no default framework: the first call for a project returns a recommendation and you choose.

**Browser-neutral by default:** when `targetBrowser` is omitted, the generated script reads the browser name at runtime from the `BROWSER` environment variable, so the same script runs on Chrome, Firefox, Microsoft Edge, Safari and Opera without changes (Robot Framework: every browser except Opera, which SeleniumLibrary cannot drive) — just change the variable or your CI matrix. Specify `targetBrowser` only when you need browser-specific options (e.g. Safari-only session setup); the script then names that browser and no longer reads `BROWSER`.

**Playwright (experimental):** `language: "playwright"` generates a Playwright Test project that drives Chrome or Edge on the Digital.ai Selenium agent — `npm install`, then `npx playwright test`, with no local browser. This route is an experimental platform feature, and the Digital.ai report shows Passed even when a test fails, so read the Playwright report (see [limitation 38](docs/limitations.md#38-playwright-known-issues)).

**Shadow DOM support:** with `always`, the generated script includes a `shadowQuery(host, cssSelector)` helper; with `auto` (the default), it is included only while a browser inspection session is open in the MCP server; `never` omits it. The helper reaches into shadow roots using `executeScript`. Use it for apps built with Web Components, Lit, Polymer or other shadow-DOM frameworks. `get_page_dom` detects shadow DOM automatically during inspection and reports `hasShadowDom: true` when present.

<details>
<summary><strong>Parameters</strong></summary>

| Parameter | Values | Default |
|---|---|---|
| `language` | `java-junit5` \| `java-testng` \| `nodejs` \| `python` \| `robot` (Robot Framework + SeleniumLibrary) \| `playwright` (experimental; Chrome / Edge): the framework YOU chose. Leave it out on the first call for a project to get the recommendation | _(the project's saved choice)_ |
| `confirmedByUser` | `true` when you chose `language`; saves it as the project's framework | _(optional)_ |
| `newFramework` | `true` to add a second, different framework to a project that already has one | _(optional)_ |
| `url` | URL of the page being tested | _(optional)_ |
| `testName` | Any string | `"WebTest"` |
| `targetBrowser` | `chrome` \| `firefox` \| `MicrosoftEdge` \| `safari` \| `opera` (names as `list_available_browsers` returns them; `edge` is accepted for `MicrosoftEdge`) | _(optional)_ |
| `shadowDomSupport` | `auto` \| `always` \| `never` | `auto` |
| `confirmSelectorsVerified` | Accepted for older callers; changes nothing | _(optional)_ |
| `acceptInsecureCerts` | `true` for a site with a self-signed, expired or untrusted-CA certificate | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

</details>

### Check a test before you deliver it (`validate_test_script`)

The final check before a test is delivered: the boilerplate's placeholder steps must have been replaced, and a test written by hand must not rely on guessed selectors. Pass the full `scriptContent` before presenting or saving any test. It looks for unreplaced `<…>` placeholder selectors, the deliberate scaffold fail-guard, placeholder or made-up credentials, known fabricated resource IDs, and code copied from the ExperiBank sample app into a test of another app. Ordinary code in your own tests (a `raise NotImplementedError`, HTML markup inside strings) is not failed; patterns that make a test flaky are warnings. If it finds a serious problem it returns `isError` with a `fail` verdict, so a test that can't work isn't delivered as finished. A `pass` is necessary but not sufficient: it confirms the obvious placeholders are gone, not that the selectors are real — a live inspection is still the authoritative source.

| Parameter | Values | Default |
|---|---|---|
| `scriptContent` | The full test script text | _(required)_ |
| `fileName` | Label for the result | _(optional)_ |
| `outputFormat` | `json` \| `human` | `json` |

[↑ Back to top](#table-of-contents)

---

## Running Tests

There are two ways to run tests. **Appium and Selenium tests** run from your own client (IDE, CI scripts) against the cloud, and the server manages the devices, apps, reservations and results they use. **Espresso, XCUITest, Maestro and Playwright suites** are run by the platform itself, and the server starts and follows them.

For Espresso, XCUITest and Maestro, `execute_test_run` starts a run, `get_test_run_status` follows it, `cancel_test_run` stops it, and `get_test_run_command` gives a command to start it from your own machine. `generate_maestro_flow` builds a Maestro flow from structured steps. Maestro is Android-only. Espresso and Maestro runs are verified; XCUITest uses the same API but is not yet verified end to end.

**Playwright** projects run through the platform's Execution Service: `execute_playwright_run` uploads the project (a folder or .zip), and the platform runs it in Microsoft's Playwright image on chromium, firefox or webkit; `get_test_run_status` and `cancel_test_run` take its run id. Each test becomes a Reporter record, and `get_test_run_status` shows passed and failed once the run has finished; a run can show RUNNING for a few minutes while its container starts. It needs a Cross Browser license: a run that stays queued with "Waiting for licenses" has no capacity on your cloud. See [limitation 38](docs/limitations.md#38-playwright-known-issues).

See [Test Runs](docs/tools.md#test-runs-espresso--xcuitest--maestro) and [example prompts](docs/examples.md#test-runs-espresso-xcuitest-maestro).

[↑ Back to top](#table-of-contents)

---

## Results, Reports and Analysis

Everything the platform records about your tests, devices and usage can be read in four ways, from the broadest to the most detailed:

- **[Ready-made reports](#ready-made-reports):** a finished, branded report in one request, for a team, a manager or a release decision.
- **[Investigating failures](#investigating-failures):** one test or one failure at a time, down to its cause, log and video.
- **[Performance comparison](#performance-comparison):** two sets of performance measurements compared fairly.
- **[Usage reports](#usage-reports):** the platform's own usage exports *(Cloud Admin)*.

A report and a direct question read the same platform data, so they give the same numbers.

### Ready-made reports

Ask for a report and the server builds it: it fetches the data, draws the charts and writes a short "What it means" for every section. You get **one HTML file** in Digital.ai branding that works offline and can be mailed or attached, and the AI sums up the highlights. In Claude Desktop the report is shown right in the conversation, with Download and Full screen buttons.

| Ask for… (each opens an example) | You get |
|---|---|
| [*"Give me a test summary report for the last 7 days"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-summary.html) | Runs and pass rate against the previous period, runs per day, results by platform, the most frequent failures |
| [*"Create a test trend report for the last 90 days"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-trend.html) | Runs and pass rate per day, week or month over up to a year, exact for any number of runs |
| [*"Show test results by platform"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-breakdown.html) / [*"Compare pass rates by device model"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-breakdown.html) | Results broken down by one or two things: platform, device, model, OS version, framework, browser, user, test, or any custom report column |
| [*"Which tests are unreliable?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-reliability.html) / [*"Which tests started failing this week?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-reliability.html) | Every test sorted into passes every time, fails every time, mixed results and newly failing, against the period before |
| [*"Are we ready to release build 412?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/release-readiness.html) | A verdict (Ready, Ready with risks, Not ready) from checks the report states in full, and the tests that stand in the way |
| [*"Why are tests failing this week?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/failure-analysis.html) | Failures by classification and device, a device-by-day heatmap, the most common causes |
| [*"How many test reports do we have, by project and user?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/test-inventory.html) | Every test report on the instance, all dates, with storage per project against its quota |
| [*"Show me a device health report"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/device-health.html) | Pool status, offline and degraded devices, devices that fail far more often than the rest, offline devices by region and agent |
| [*"Which devices and OS versions do our tests cover?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/device-coverage.html) | Devices with and without a test run, runs by OS version and model, OS versions no test ran on |
| [*"How much of our device lab is used?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/device-utilization.html) *(Cloud Admin)* | Reserved hours per device against the hours the pool had, devices never reserved, demand by model |
| [*"Are we near our license limit?"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/license-usage.html) *(Cloud Admin)* | The most sessions open at once per license type against the licensed number, with the day and hour of each peak |
| [*"Create a usage summary for project Payments"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/usage-summary.html) / [*"...for all projects"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/usage-overview.html) *(Cloud Admin)* | Reserved hours, users and devices for one project, or an overview of every project |
| [*"Create a performance overview report"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/performance-overview.html) | Median Speed Index, duration, CPU and memory per transaction, by network profile and app version |
| [*"Compare Transfer money performance in 4.2.0 and 4.3.0"*](https://digitalai-opensource.github.io/digital-ai-testing-mcp/examples/reports/performance-comparison.html) | Two sets of runs side by side: Speed Index and the other metrics as three numbers each, the change, a verdict, and whether the comparison is like for like |

Add a project, a number of days or a pass-rate goal to any of them. Several can be limited to one build or platform (*"...for build 412"*).

**A report of any data.** The ready-made reports cover the common questions. For anything else, ask for a report of whatever you are looking at (*"list the applications in the repository"*, then *"show that as a report by platform"*): the AI fetches the data with the ordinary tools and lays it out in the same design. A quick question still gets a quick answer.

**Where the report goes.** In Claude Desktop it appears inside the conversation. In other AI clients it is a file: in the report folder you set once with [`setup reports <folder>`](#the-setup-command), in the project folder the client works in, or a temporary file the AI hands over. No browser or other app is opened, and nothing is written into your personal folders unless you choose a folder for reports.

**Long ranges.** Every request first measures how long the report will take. One that would take longer than a tool call can wait is offered as a smaller range, or as a background report that you can check on or cancel.

**[→ docs/reports.md](docs/reports.md)** describes every report and what it contains, the options, reports of any data and their building blocks, where reports are saved, background reports, and the rules the reports follow so that a number means the same thing in each.

### Investigating failures

*As a report:* the tools below answer about one test or one failure at a time and return its details, not a report. For failures in aggregate, ask for the [failure analysis report](#ready-made-reports) (*"Why are tests failing this week?"*), which groups them by cause, classification and device.

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

Tests missing from the results? See [Troubleshooting](#common-symptoms): a project with its own reporter needs `projectName`.

### Performance comparison

*As a report:* ask for a [performance comparison report](docs/reports.md#performance-comparison) (*"compare Transfer money in 4.2.0 and 4.3.0"*): one call lays out both sides, the change, a verdict and the like-for-like check. The tools below return the same numbers for an agent to work with; for a summary of every transaction, ask for the [performance overview report](#ready-made-reports).

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

To record new performance samples from a generated test, see [performance transactions](#mobile-app-tests-get_test_boilerplate) in Creating Tests; for a summary of every transaction, ask for the performance overview report. More prompts: [Performance Testing Analytics](docs/examples.md#performance-testing-analytics).

### Usage reports

*As a report:* the tools below export or summarize the platform's usage CSVs. For a finished report, ask for the [usage summary](#ready-made-reports) (one project or every project), the device utilization report or the license usage report.

Cloud Admins can export the platform's usage-report CSVs — device reservations, users/devices/browser usage, user statistics, license usage — or have `summarize_usage_report` aggregate one in memory and return just the summary, with no file written. Usage data is kept for 2 years (platform 25.9+); earlier periods come back empty or partial. A large unfiltered export runs only after you explicitly agree (`confirmLargeExport`, see [Safety Guards](#safety-guards)). See [Usage Reports](docs/tools.md#usage-reports), [limitation 21](docs/limitations.md#21-usage-reports-2-year-retention-large-exports) and [example prompts](docs/examples.md#usage-reports-platform-administration--finops).

[↑ Back to top](#table-of-contents)

---

## Managing Projects

Three workflow tools set up and wind down a project and the devices and users that come with it. They don't make changes themselves: each returns a guided, numbered plan that the AI then carries out with the individual tools (`create_device_group`, `create_user`, …), pausing for your confirmation at the points the plan specifies. The plans use Cloud Admin tools (user, group and project administration), so run them with a Cloud Admin profile.

| Goal | Tool |
|---|---|
| Set up a project: devices, users, app | [`setup_project`](#setup_project--provision-a-new-project-environment) |
| Release its devices and users, keep the project | [`close_project_resources`](#close_project_resources--release-resources-without-deleting) |
| Delete everything | [`teardown_project`](#teardown_project--full-project-deletion) |

Users who belong to several projects are removed from this project only, never deleted from the platform.

### Project lifecycle

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
9. Assign your application to the project (the ExperiBank sample app as a placeholder when none was given)

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
| `appName` | ExperiBank sample app (placeholder) | Your team's app to assign to the project. With no app given, the ExperiBank sample app is assigned as a placeholder so the project does not start empty, and the plan says so; assign your own app with `assign_app_to_project` once it is uploaded |
| `androidPackageName` | ExperiBank sample app | Android package of your app, used to find it in the repository |
| `iosBundleId` | ExperiBank sample app | iOS bundle ID of your app, used to find it in the repository |
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

The workflow presents a full inventory summary before any irreversible action; user processing is confirmed once for the whole batch via this inventory rather than user by user. Users who belong to other projects are protected in the same way.

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
| `npx : File …\npx.ps1 cannot be loaded because running scripts is disabled on this system` (or `npm.ps1`) | Windows PowerShell runs the PowerShell scripts npm installs (`npx.ps1`, `npm.ps1`), and its default execution policy blocks scripts | Type `npx.cmd` / `npm.cmd` instead of `npx` / `npm`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (your organization's policy may override it). The AI client entries setup writes start Node.js directly and are not affected |
| Every tool answers "SETUP REQUIRED" | The server found no connection: no `DIGITAL_AI_BASE_URL` / `DIGITAL_AI_ACCESS_KEY` it can see and no usable profile saved with setup | Run `npx -y digital-ai-testing-mcp@latest setup` (`npx.cmd` on Windows), or add the variable the message names to the client's `env` block (npm) or the `.env` file passed with `--env-file` (Docker). Then restart the client or reconnect the server. See [The setup command](#if-something-goes-wrong) |
| `setup clients add` changed Claude Desktop's config, but the server doesn't appear | On Windows, Claude Desktop may read a different `claude_desktop_config.json` than the one changed | Put back the `.digital-ai-testing.bak` copy beside it, then run `npx.cmd -y digital-ai-testing-mcp@latest setup clients add claude-desktop --config "<file>"` with the file Claude Desktop uses. See [Claude Desktop](#claude-desktop) |
| `403 Forbidden` on admin tools (agents, regions, license) | Active profile has a project-level role (Project Admin or Project User) — v2 endpoints require Cloud Admin access | Ask the AI: *"switch to my Cloud Admin profile"* — it will call `list_environments` and pick the right one. See [Using multiple keys](#using-multiple-keys) |
| Report delete tools refuse with "Reporter deletes are disabled for project …" | The project's `allowUsersDeleteTests` setting is false, so project-level roles can't delete reports | Ask a Cloud Admin to enable it for the project, or switch to a Cloud Admin profile |
| `install_application` returns 400 on a device you can see | Device is reserved via an rdb (remote debug) session | Install **first**, then run `get_remote_debug_command` — not the other way around |
| `install_application` returns 400 (no rdb involved) | App not assigned to a project containing the target device | Call `assign_app_to_project` first |
| Repeatable `NoSuchElementException` while sibling tests pass | Device health, not test code — device stuck in a wrong state or offline-but-pooled | Run `get_device_health_summary`; scope the deviceQuery with `@region='<healthy-region>'` |
| Tests missing from `list_test_reports` results | Project has its own reporter instance — unscoped queries search the default scope | Pass `projectName` (exact name from `list_projects`) |
| rdb fails: `validation error / Failed to reserve device` | With a project-level role, the serial lookup returned an internal device ID instead of the real serial (the `get_remote_debug_command` response warns about this) | Pass the device's real serial (Android) or UDID (iOS) yourself as `serialNumber`, read from Mobile Studio or `list_devices`; or, with a Cloud Admin profile, ask the AI: *"switch to Cloud Admin"* → regenerate the rdb script → switch back; or ask your Cloud Admin to generate the script. See [limitation 13](docs/limitations.md#13-get_remote_debug_command-requires-cloud-admin-for-reliable-serial-resolution) |
| Device query returns nothing for `@manufacturer` / `@tag` | These fields are silently ignored server-side | Use the `manufacturer`/`tags` parameters on `find_available_device` — they filter client-side |
| The AI client reports a timeout connecting to the server (for example "connection timed out after 30000ms" in Claude Code), often right after a new release | The first start of a new version downloads it, which can take longer than the client waits. The client stops the start and reports a timeout | Reconnect the server once more (Claude Code: `/mcp` → digital-ai-testing → Reconnect), or restart the client. To download a new version ahead of time, run `npx -y digital-ai-testing-mcp@latest setup clients add` (`npx.cmd` on Windows): it starts the server once and says how long the start took |
| One project still uses an old setup (for example its own access key, Docker, or a plain `npx` that times out) although `setup clients add` set up Claude Code for all projects | Claude Code prefers a per-project entry (in `~/.claude.json` for that folder, or the projects `.mcp.json`) over the "all your projects" one | Run `npx -y digital-ai-testing-mcp@latest setup clients` (Windows: `npx.cmd`). It lists each project that has its own entry, with the command or file to remove it from. Keep the entry only if that project needs its own key |
| The server doesn't start while the machine is offline, or the first start after a release is slow | The client configuration fetches the newest release at each start (`npx … @latest`, `docker run --pull=always`) | Wait for the first start to finish. For offline use, switch to a fixed install — see [Automatic updates](#automatic-updates) |
| A downloaded file isn't on your machine, or an upload can't find your file (Docker) | Under Docker, file tools use the container's filesystem | See [Local File Transfer](#local-file-transfer-docker--remote-deployments-only) |

### `Failed to reconnect to digital-ai-testing: -32000`

On Windows with Docker, this usually means the `--env-file` path was stored with its backslashes stripped. Open `~/.claude.json`, find the `mcpServers` entry for this project, and check that the env file path looks right (e.g. `C:/projects/digital-ai-testing-mcp/.env`). If it shows something like `C:projectsdigital-ai-testing-mcp.env`, the backslashes were removed. Fix the path in the file directly (use forward slashes), then run `/mcp` in Claude Code to reconnect.

### Workflow tools failing?

Run this sequence:

```
1. get_server_info           — confirm tool count (expect 229) and active profile
2. check_workflow_readiness  — which dependency tools are present or missing
3. check_connectivity        — confirm the backend API is reachable
```

`check_workflow_readiness` returns a structured report:

```json
{
  "allWorkflowsReady": true,
  "registeredToolCount": 229,
  "workflows": {
    "setup_project":           { "ready": true, "missingRead": [], "missingWrite": [] },
    "close_project_resources": { "ready": true, "missingRead": [], "missingWrite": [] }
  }
}
```

If `ready` is `false`, `missingRead` and `missingWrite` list exactly which tools are absent. The most common cause is an outdated install — see [Upgrading](#upgrading).

The server also logs a readiness check at startup (visible in your terminal, or `docker logs`/your AI client's MCP server logs if running in a container): `Workflow readiness: all workflows ready ✓`, or `⚠️ DEGRADED: setup_project — missing: ...` when tools are absent.

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
→ {"deviceGroups":[{"id":"7","name":"Default"},{"id":"12","name":"Payments"}]}

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

1. **Appium and Selenium tests aren't started by the server.** You launch them from your own Appium or Selenium client (IDE, CI scripts); the server manages the devices, apps, reservations and results. Espresso, XCUITest and Maestro suites are different — the platform runs them itself (see [Test runs](#running-tests)).
2. **iOS inspection sessions differ from Android:** no clearing app data, no clipboard on Appium Grid devices, and back navigation uses the navigation-bar button (iOS has no Back button). See [limitation 29](docs/limitations.md#29-ios-inspection-sessions-differ-from-android).
3. **Appium Grid projects support fewer commands than Appium Server** — for example no `-ios predicate string` locator, no Android Auto / CarPlay projection, no pinch/zoom, no webview contexts. See [limitation 18](docs/limitations.md#18-appium-grid-projects-support-fewer-commands-than-appium-server).
4. **Under Docker, file tools work on the container's filesystem, not yours.** Use the command-generator tools instead — see [Local File Transfer](#local-file-transfer-docker--remote-deployments-only) and [limitation 15](docs/limitations.md#15-local-file-io-runs-on-the-mcp-servers-filesystem-not-yours).
5. **Usage reports go back 2 years** (platform 25.9+), and large unfiltered exports need your explicit approval. See [limitation 21](docs/limitations.md#21-usage-reports-2-year-retention-large-exports).
6. **There's no way to disable or lock a user.** Removing access for a user created only for one project means deleting the account, which is why `close_project_resources` asks for confirmation per user.
7. **Deleting test reports with a project-level key depends on a per-project setting** (`allowUsersDeleteTests`). Cloud Admin can always delete. When the setting is off, the tools refuse up front for a Project Admin and explain how to get it enabled; a Project User cannot read the setting, so the platform returns its own 403.
8. **Playwright needs a Cross Browser license, and its Selenium-agent route is experimental.** An `execute_playwright_run` job without free capacity stays queued with "Waiting for licenses". Projects generated for the Selenium agent run on Chrome and Edge only, and the Digital.ai report shows Passed even when a test failed — read the Playwright report. See [limitation 38](docs/limitations.md#38-playwright-known-issues).

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
