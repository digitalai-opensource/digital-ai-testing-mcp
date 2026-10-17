# Recommended Agent Guardrails

**Optional but recommended.** This server ships a test-authoring policy automatically in its
MCP `instructions` (delivered to your client at connect time), so in most setups you do **not**
need to do anything. Add the snippet below when you want a stronger, client-independent guarantee.

---

## Why this exists

When an agent is asked to "create an automated test," the reliable failure mode is that it
generates a script with **fabricated element selectors** — resource IDs it guessed from the
package name rather than captured from the real app — and presents it as finished. The script
looks plausible and runs nowhere.

The server defends against this in two ways that travel with it automatically:

- **Server `instructions`** — a mode-first / no-guessed-selectors policy delivered in the MCP
  `initialize` handshake. Most clients surface it into the model's
  context before it acts.
- **Structural tool behavior** — `get_test_boilerplate` and `generate_maestro_flow` return *no code*
  for a real app unless a live inspection session exists (or you explicitly confirm verified
  selectors) — the built-in ExperiBank demo, requested with no app ID, package or bundle ID, is
  returned directly because its steps are already verified; `get_web_test_boilerplate` does the same for a real URL without a live browser
  session; and `validate_test_script` returns an error when it detects placeholder selectors
  (including unfilled CSS selectors), the scaffold fail-guard, or placeholder credentials.

Consequential actions are guarded the same way: deletes, releases and cancellations need
`confirmDeletion: true` (without it the tool returns a preview), public report links need
`confirmPublicShare: true`, unfiltered usage exports over 31 days need `confirmLargeExport: true`, and
`find_unhealthy_devices` only previews the devices it would tag until it gets `confirmTagging: true`.
Upload tools refuse credential files (`.env*`, SSH private keys) whatever the request says.

Two gaps remain that **no MCP server can close on its own**:

1. **Not every client surfaces server `instructions`.** The field is optional in the MCP spec;
   some clients ignore it.
2. **An agent can hand-write a file.** The MCP boundary ends at tool calls — the agent's editor
   and file-writing tools are outside it. The server can make the correct path easiest and flag
   fabrication when its tools are used, but it cannot intercept a file the agent writes directly.

Installing the snippet below into your client's own context (which the model reads with higher
priority than tool descriptions) is the most effective way to close gap #1 and reduce gap #2.

---

## The guardrail text

Copy this verbatim into one of the targets in the next section.

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

- Never set `confirmDeletion`, `confirmPublicShare`, `confirmLargeExport` or
  `confirmTagging` to true unless the user explicitly agreed in this conversation. Call without it
  first and show the user the preview the tool returns.
- These have no built-in confirmation — ask before calling them: `reboot_device`,
  `reset_device_usb`, `create_reservation` / `reserve_device_for_duration` (they
  hold devices other people may need), `execute_test_run` (uses devices and
  licenses), `bulk_install_to_group`, `update_project_settings`,
  `set_telephony_status`, and user/project administration (`create_user`,
  `assign_user_to_project(s)`, `setup_project`, `create_poc`).
- If a tool refuses because of your access level or a project setting (for
  example a report delete blocked by `allowUsersDeleteTests`), tell the user. Do
  not `switch_environment` to a more privileged profile to get around it unless
  the user asks.
- Generated scripts (`get_test_boilerplate`, `get_web_test_boilerplate`,
  `get_remote_debug_command`) can contain the active profile's access key. Move
  it to an environment variable before committing, and never commit or upload
  `.env` files or keys.
```

---

## Where to install it

Pick the one that matches your client. All are read by the model with higher priority than
tool descriptions, and none requires changes to the MCP server.

### Claude Code (VS Code / JetBrains / CLI)

Add the snippet to a `CLAUDE.md` file at the root of the **project where you create tests**
(not this server's repo). Claude Code loads `CLAUDE.md` into context for every session in that
project. A user-level `~/.claude/CLAUDE.md` applies it to all your projects.

### Claude Desktop

Claude Desktop surfaces MCP server `instructions` automatically, so the policy is already active.
For extra weight, paste the snippet into a **Project**'s custom instructions and work from that
Project.

### Cursor

Add the snippet to `.cursor/rules` (or a `*.mdc` rule file) in the test project. Cursor rules are
injected into the model's context like a system prompt.

### GitHub Copilot

Add the snippet to `.github/copilot-instructions.md` in the test project. Copilot reads it as
repository-level custom instructions.

### Any other client

Paste the snippet into whatever "custom instructions" / "system prompt" / "rules" mechanism the
client offers. If it has none, you are relying on the server `instructions` field — confirm your
client surfaces it (most do).

---

## Access, file paths, toolsets and debug mode (governance notes)

**Restrict capability with the key's role.** What an agent can do is decided by the role of the
access key it uses (Project User / Project Admin / Cloud Admin). The server detects that role from
the API — not from the key's format — and `list_environments` shows it for each profile. Give an
agent the least-privileged profile that covers its task.

**Tool annotations.** Every tool carries MCP `readOnlyHint` / `destructiveHint` annotations, so a
client that honours them can auto-approve reads and warn before deletes, releases and cancellations.
Read-only means the tool only reads or only generates text (the `get_*_command` tools return a
command; running it is up to you). `find_unhealthy_devices` is deliberately not marked read-only,
because it can tag devices. Unknown parameters are rejected rather than ignored.

**`MCP_TOOLSETS` limits context, not capability.** Tools outside the loaded toolsets still appear
and load themselves when called, so toolsets are not an access control.

**File paths depend on how the server is installed.** With the npm install
(`MCP_DEPLOYMENT_MODE=local`), file tools read and write your own machine. Under Docker they read
and write the container's filesystem, so the agent should use the `get_*_command` tools (which
produce a command you run locally) or `summarize_usage_report` instead. Each tool's description
states which applies.

**`MCP_DEBUG_MODE=true`** adds instructions asking the agent to record notes about errors,
corrections and wasted calls, and logs every tool call (duration, response size, outcome,
summarised arguments). Keys, tokens, emails and signed-URL parameters are redacted. With the npm
install, files go to a `remediation/` folder in your project with its own `.gitignore` (never your
home folder); under Docker, or when the server cannot tell which folder is your project, notes are
returned to the agent to save there. Leave it off outside evaluations, and
review the folder before sharing it. See [Debug mode](../README.md#debug-mode-remediation-notes).

---

## What you still cannot guarantee

Even with the snippet installed, an agent *can* ignore instructions and hand-write a fabricated
test — instructions are advisory, and file-writing is outside the MCP boundary. The realistic
posture is **defense in depth that raises compliance**, not guaranteed prevention. The structural
checks (the no-code gates in `get_test_boilerplate`, `get_web_test_boilerplate` and
`generate_maestro_flow`, `validate_test_script`, and the `confirm*` parameters on consequential
tools) are the only client-agnostic, can't-be-ignored layer, and they apply only when those tools
are used.
