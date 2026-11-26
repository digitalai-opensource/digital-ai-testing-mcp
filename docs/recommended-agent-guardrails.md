# Recommended Agent Guardrails

**Who this is for:** anyone who connects an AI client to this server and lets it create tests or change things on the
Digital.ai platform — a test engineer setting up their own client, or a team lead or administrator who sets rules for
several people.

**What it gives you:** a ready-to-paste block of rules (the [guardrail text](#the-guardrail-text)) that tells the AI
how to create tests from real element selectors and when to ask before acting, plus where to put it in each client and
what the server already does without it.

**Do you need it?** It is optional. The server already sends a test-authoring policy to the client when it connects
(its MCP `instructions`), and its tools refuse the riskiest requests on their own. Add the guardrail text when you
want the rules to hold whichever client you use — in particular in Claude Desktop, which does not pass the server's
instructions on to the AI.

## Contents

- [Why this exists](#why-this-exists)
- [The guardrail text](#the-guardrail-text)
- [Where to install it](#where-to-install-it)
- [Access, file paths, toolsets and debug mode](#access-file-paths-toolsets-and-debug-mode-governance-notes)
- [What you still cannot guarantee](#what-you-still-cannot-guarantee)

---

## Why this exists

Asked to "create an automated test", an AI tends to fail in one predictable way: it writes a script with **made-up
element selectors** — resource IDs guessed from the package name instead of captured from the real app — and presents
it as finished. The script looks plausible and runs nowhere.

The server guards against this in two ways that need no setup:

- **Server `instructions`** — a "decide the mode first, never guess selectors" policy sent in the MCP `initialize`
  handshake. Clients that pass it on put it in the AI's context before it acts.
- **Tool behaviour** — `get_test_boilerplate` and `generate_maestro_flow` return *no code* for a real app unless a live
  inspection session exists (or you confirm the selectors were captured from the real app). The built-in ExperiBank
  demo, requested with no app ID, package or bundle ID, is returned directly because its steps are already verified.
  `get_web_test_boilerplate` does the same for a real URL without a live browser session. `validate_test_script`
  returns an error when it finds placeholder selectors (including unfilled CSS selectors), the scaffold fail-guard, or
  placeholder credentials.

Consequential actions are guarded the same way. Without the confirmation parameter the tool returns a preview:

| Action | Parameter |
|---|---|
| Deletes, releases and cancellations | `confirmDeletion: true` |
| Public report links (`share_test_report`) | `confirmPublicShare: true` |
| Unfiltered usage exports over 31 days | `confirmLargeExport: true` |
| Tagging devices in `find_unhealthy_devices` | `confirmTagging: true` |
| ADB shell commands outside the read-only list (`device_control` action `shell`) | `confirmChange: true` |

Upload tools refuse credential files (`.env*`, SSH private keys) whatever the request says.

Two gaps remain that **no MCP server can close on its own**:

1. **Not every client passes server `instructions` on to the AI.** The field is optional in the MCP specification, and
   some clients drop it (Claude Desktop does).
2. **An AI can write a file by hand.** The server sees only tool calls; the AI's editor and file-writing tools are
   outside it. The server can make the correct path the easiest one and flag made-up selectors when its tools are
   used, but it cannot stop a file the AI writes directly.

Putting the guardrail text into your client's own context, which the AI reads with higher priority than tool
descriptions, closes gap 1 and narrows gap 2.

---

## The guardrail text

Copy this as it is into one of the places in [Where to install it](#where-to-install-it).

```markdown
## Test authoring on the Digital.ai platform — MANDATORY

Before you plan, generate, scaffold, or hand-write ANY test for a mobile app or
web browser on the Digital.ai platform, decide the mode FIRST — before creating
a task list, before calling any MCP tool, before opening an editor:

### Mobile app tests

- **INTERACTIVE** — the default whenever the intent is vague ("create a test for
  app X", "let's decide as we go"), you do NOT have the app's source code, or you
  have no captured element IDs. Action: call `start_inspection_session`, capture
  REAL element IDs with `get_element_tree` / `open_mobile_studio`, build steps
  from those.
- **AUTONOMOUS** — only when the intent names specific screens/actions/results
  AND you already have a real selector source (captured inspection IDs, or
  authoritative app source in this workspace). Action: `get_test_boilerplate`
  (it returns no code for a real app unless a live inspection session exists or
  you pass `confirmSelectorsVerified: true`).

### Maestro flows

- Same rule: build steps from resource-ids captured in a live Android inspection
  session. `generate_maestro_flow` returns no flow without one (or
  `confirmSelectorsVerified: true`, only for IDs captured from the real app).

### Web browser tests

- **INTERACTIVE** — the default whenever intent is vague, you have no prior
  selector source for this URL, or the user wants to watch/approve each step.
  Action: call `start_browser_inspection_session`, navigate to the target URL,
  use `get_page_dom` / `find_web_elements` to capture REAL CSS selectors and
  element IDs, relay screenshots at every key step.
- **AUTONOMOUS** — only when you already have real CSS selectors (from a live or
  prior browser inspection session, or authoritative source). Action:
  `get_web_test_boilerplate` — with a live browser session open it generates
  directly; otherwise pass `confirmSelectorsVerified: true`.

PROHIBITED — treated as a task FAILURE, not a deliverable:
- Writing or generating a test file with invented/placeholder element IDs
  (`nav_catalog`, `home_container`, …), guessed XPaths, guessed CSS selectors
  (`#YOUR_SELECTOR`, `.your-class`), or fabricated credentials.
- Doing the above by authoring the file yourself instead of calling
  `get_test_boilerplate`, `get_web_test_boilerplate` or `generate_maestro_flow` —
  bypassing the tool does NOT exempt you from this rule.
- Presenting any test built without real, inspection-sourced (or source-derived)
  selectors as finished or runnable.

Before you present or save ANY test — generated or hand-written — run
`validate_test_script` on it and fix anything it flags.

Never set `confirmSelectorsVerified` unless every selector came from the real app.

If you have no selector source you are in INTERACTIVE mode by definition.
A test-type label from a menu ("login test", "smoke", "e2e") is a category, not a
specification. If unsure which mode the user wants, ASK before calling any tool
or writing any code.

## Consequential actions on the Digital.ai platform

- Never set `confirmDeletion`, `confirmPublicShare`, `confirmLargeExport`,
  `confirmTagging` or `confirmChange` to true unless the user explicitly agreed
  in this conversation. Call without it first and show the user the preview the
  tool returns.
- These have no built-in confirmation — ask before calling them: `reboot_device`,
  `reset_device_usb`, `create_reservation` / `reserve_device_for_duration` (they
  hold devices other people may need), `execute_test_run` and
  `execute_playwright_run` (they use devices and licenses),
  `bulk_install_to_group`, `update_project_settings`, `set_telephony_status`,
  and user/project administration (`create_user`, `assign_user_to_project(s)`,
  `setup_project`, `create_poc`).
- If a tool refuses because of your access level or a project setting (for
  example a report delete blocked by `allowUsersDeleteTests`), tell the user. Do
  not `switch_environment` to a more privileged profile to get around it unless
  the user asks.
- Generated tests read the access key from the `DIGITAL_AI_ACCESS_KEY`
  environment variable and never contain it. The command tools
  (`get_*_command`) and the script from `get_remote_debug_command` DO contain the
  active profile's key: run them, do not commit or share them. Never commit or
  upload `.env` files or keys.
```

---

## Where to install it

Pick the place that matches your client. Each is read by the AI with higher priority than tool descriptions, and none
needs a change to the MCP server.

### Claude Code (VS Code / JetBrains / CLI)

Add the text to a `CLAUDE.md` file at the root of the **project where you create tests** (not this server's
repository). Claude Code loads `CLAUDE.md` into every session in that project. A user-level `~/.claude/CLAUDE.md`
applies it to all your projects.

### Claude Desktop

Claude Desktop does **not** pass this server's `instructions` on to the AI, so without the guardrail text the AI sees
only the tool descriptions and the tools' own refusals. Paste the text into a **Project**'s instructions and work from
that Project.

### Cursor

Add the text to `.cursor/rules` (or a `*.mdc` rule file) in the test project. Cursor adds its rules to the AI's context
like a system prompt.

### GitHub Copilot

Add the text to `.github/copilot-instructions.md` in the test project. Copilot reads it as repository-level custom
instructions.

### Any other client

Paste the text into whatever "custom instructions", "system prompt" or "rules" feature the client offers. If it has
none, you are relying on the server's `instructions`; check that your client passes them on.

---

## Access, file paths, toolsets and debug mode (governance notes)

**Limit what an AI can do with the key's role.** What an AI can do is decided by the role of the access key it uses:
Project User, Project Admin or Cloud Admin. The server reads that role from the platform, not from the key's format, and
`list_environments` shows it for each profile. Give an AI the least-privileged profile that covers its task.

**Tool annotations.** Every tool carries the MCP `readOnlyHint` / `destructiveHint` annotations, so a client that
honours them can approve reads automatically and warn before deletes, releases and cancellations. Read-only means the
tool only reads or only produces text (the `get_*_command` tools return a command; running it is up to you).
`find_unhealthy_devices` is deliberately not marked read-only, because it can tag devices. Unknown parameters are
rejected rather than ignored.

**`MCP_TOOLSETS` limits context, not capability.** Tools outside the loaded toolsets still appear and load themselves
when called, so toolsets are not an access control.

**File paths depend on how the server is installed.** With the npm install (local mode, the default outside a
container) file tools read and write your own machine. Under Docker they read and write the container's filesystem, so
the AI should use the `get_*_command` tools (which produce a command you run on your machine) or
`summarize_usage_report` instead. Each tool's description says which applies. See
[limitation 15](limitations.md#15-local-file-io-runs-on-the-mcp-servers-filesystem-not-yours).

**`MCP_DEBUG_MODE=true`** asks the AI to record notes about errors, corrections and wasted calls, and logs every tool
call (duration, response size, outcome, summarised arguments). Keys, tokens, emails and signed-URL parameters are
redacted, and typed text and password-like arguments are not recorded. With the npm install the files go to a
`remediation/` folder in your project with its own `.gitignore` (never your home folder). Under Docker, or when the
server cannot tell which folder is your project, the notes are returned to the AI to save there. Leave debug mode off
outside evaluations, and review the folder before sharing it. See
[Debug mode](../README.md#debug-mode-remediation-notes).

---

## What you still cannot guarantee

Even with the guardrail text installed, an AI *can* ignore instructions and write a test with made-up selectors by
hand: instructions are advice, and writing files is outside the server's reach. The realistic aim is **layered
defences that raise compliance**, not guaranteed prevention. The structural checks — the no-code gates in
`get_test_boilerplate`, `get_web_test_boilerplate` and `generate_maestro_flow`, `validate_test_script`, and the
`confirm*` parameters on consequential tools — are the only layer that works in every client and cannot be ignored, and
they apply only when those tools are used.
