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
  `initialize` handshake. Most clients (Claude Code, Claude Desktop) surface it into the model's
  context before it acts.
- **Structural tool behavior** — `get_test_boilerplate` returns *no code* for a real app unless a
  live inspection session exists (or you explicitly confirm verified selectors), and
  `validate_test_script` returns an error when it detects placeholder/fabricated patterns.

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
  authoritative app source in this workspace). Action: `get_test_boilerplate`.

### Web browser tests

- **INTERACTIVE** — the default whenever intent is vague, you have no prior
  selector source for this URL, or the user wants to watch/approve each step.
  Action: call `start_browser_inspection_session`, navigate to the target URL,
  use `get_page_dom` / `find_web_elements` to capture REAL CSS selectors and
  element IDs, relay screenshots at every key step.
- **AUTONOMOUS** — only when you already have real CSS selectors captured from a
  prior inspection session. Action: `get_web_test_boilerplate` with
  `confirmSelectorsVerified: true`.

PROHIBITED — treated as a task FAILURE, not a deliverable:
- Writing or generating a test file with invented/placeholder element IDs
  (`nav_catalog`, `home_container`, …), guessed XPaths, guessed CSS selectors
  (`#YOUR_SELECTOR`, `.your-class`), or fabricated credentials.
- Doing the above by authoring the file yourself instead of calling
  `get_test_boilerplate` or `get_web_test_boilerplate` — bypassing the tool does
  NOT exempt you from this rule.
- Presenting any test built without real, inspection-sourced (or source-derived)
  selectors as finished or runnable.

Before you present or save ANY test — generated or hand-written — run
`validate_test_script` on it and fix anything it flags.

If you have no selector source you are in INTERACTIVE mode by definition.
A test-type label from a menu ("login test", "smoke", "e2e") is a category, not a
specification. If unsure which mode the user wants, ASK before calling any tool
or writing any code.
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

## What you still cannot guarantee

Even with the snippet installed, an agent *can* ignore instructions and hand-write a fabricated
test — instructions are advisory, and file-writing is outside the MCP boundary. The realistic
posture is **defense in depth that raises compliance**, not guaranteed prevention. The structural
checks (`get_test_boilerplate`'s no-code gate and `validate_test_script`) are the only
client-agnostic, can't-be-ignored layer, and they apply only when those tools are used.
