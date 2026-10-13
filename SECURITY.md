# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 2.x (latest) | ✅ |
| < 2.0 | ❌ — upgrade to 2.x |

Security fixes are applied to the latest major release only. We do not backport to older versions.

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities via GitHub Issues.**

To report a vulnerability, use [GitHub's private security advisory feature](https://github.com/digitalai-opensource/digital-ai-testing-mcp/security/advisories/new). This keeps the report confidential until a fix is available.

Include as much of the following as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce (or a proof-of-concept)
- The version(s) affected
- Any suggested mitigations you're aware of

We aim to acknowledge reports within **5 business days** and to produce a fix or mitigation plan within **30 days** for confirmed vulnerabilities. We will credit reporters in release notes unless you request otherwise.

---

## Security Considerations

### Credential Handling

This server reads a `DIGITAL_AI_ACCESS_KEY` from environment variables or a `.env` file. This key grants access to your Digital.ai Testing environment.

- **Never commit `.env` to source control.** The `.gitignore` excludes it by default.
- Cloud Admin access keys (either the long `eyJ…` or the short `aut_1_…` format — format does not indicate privilege) grant full administrative access to the platform — user management, project deletion, device control. Treat them with the same care as a root credential.
- Project Admin / Project User keys are narrower in scope but still grant installation, test execution, and reporting access for the assigned project.
- Several tools return the active access key in plaintext in their output: `get_remote_debug_command` (the rdb script), every `get_*_upload_command` and `get_*_download_command` tool, `get_test_run_command`, and the generated test boilerplate. Each output carries a warning. Treat it as a secret: don't commit it or paste it into tickets, and delete generated scripts after use.
- Every tool that reads a local file to send it to the platform (application, repository and provisioning-profile uploads, test-run bundles, pushing a file to a device) validates the path first and refuses credential-file names (`.env*`, SSH private keys). A steered or mistaken request cannot publish secrets to the cloud.
- Credentials are resolved through the active connection profile (`switch_environment`), never raw environment variables — generated artifacts (boilerplate, rdb scripts) always carry the currently active profile's key, so a project-scoped key can be used for customer-facing output.
- The access level of each profile is read from the platform (`GET /api/v1/users/my-account-info`), never guessed from the key, and `list_environments` shows it. Role restrictions are enforced by the platform itself; give an AI assistant the least-privileged profile that covers the task.

### Debug mode (`MCP_DEBUG_MODE`)

Off by default. When set to `true`, the server captures remediation notes and a tool-call event log. With the npm package it writes them to a `remediation/` folder in the root of the project the AI is working in (or in `MCP_REMEDIATION_DIR`); with Docker the event log stays in memory and each note is returned to the AI assistant, which saves it to that folder itself. The folder gets its own `.gitignore` so it is not committed. Each session file records the machine name and OS user name. Access keys, tokens, emails and signed-URL parameters are redacted, but notes can still contain customer data such as app, device, project and test names, on-screen text and error messages. Review them before sharing them outside your organization, and leave debug mode off on customer tenants unless that has been agreed.

### What This Server Can Do

When connected to an AI assistant, this MCP server can — on behalf of the operator:

- Create, delete, and manage user accounts (Cloud Admin key)
- Install and uninstall applications on physical and virtual devices
- Reserve, release, and reboot devices
- Delete test reports and repository files (requires `confirmDeletion: true`)
- Create and delete projects and device groups, and change project settings
- Start and cancel Espresso, XCUITest and Maestro test runs
- Drive devices in live inspection sessions (taps, typing, app and device control, push and pull files)
- Create public, no-login share links to test reports (requires `confirmPublicShare: true`)
- Export platform usage reports (large unfiltered exports require `confirmLargeExport: true`)

Deletions, releases and cancellations are guarded by an explicit `confirmDeletion: true` parameter that must be set by the caller, public sharing by `confirmPublicShare: true`, and large usage exports by `confirmLargeExport: true`. A missing or `false` value returns a confirmation prompt, not an error, so the AI is clearly instructed to re-call with confirmation rather than treating the guard as a failure.

Not every consequential action has a confirmation step: rebooting or resetting a device, creating reservations, starting test runs, installing apps and changing project settings run as soon as they are called. Deleting test reports with a project-level role is refused up front when the project does not allow it; every other role restriction is enforced by the platform. To limit what an assistant can reach, use a least-privileged profile, load only the toolsets you need (`MCP_TOOLSETS`), and add the rules in [docs/recommended-agent-guardrails.md](docs/recommended-agent-guardrails.md) to your project's agent instructions.

### Transport Security

The server communicates over the MCP stdio transport. There is no HTTP listener, no open port, and no web-facing interface. Network access is outbound only — to the configured `DIGITAL_AI_BASE_URL` (and any `DAI_PROFILE_*_URL`). Use an `https://` URL: the server does not upgrade or reject plain-HTTP URLs.

### Deployment Isolation

With the npm package (the recommended install), the server runs as your own user with that user's filesystem access; file tools validate their paths (see Credential Handling). With Docker, credentials are passed with `--env-file` (nothing is mounted), the container runs as the non-root `node` user, no ports are published, and the container cannot reach the host filesystem unless you add a volume yourself.

### Dependency Audit

Runtime dependencies are minimal (the MCP SDK, Axios, adm-zip, dotenv, form-data, Zod). Development dependencies include TypeScript, ESLint, tsx and Vitest. Run `npm audit --omit=dev` to check for vulnerabilities in production dependencies. As of the latest release, it reports no findings.

---

## Out of Scope

The following are not treated as security vulnerabilities in this project:

- Vulnerabilities in the Digital.ai Testing platform itself — report those to [Digital.ai Support](https://support.digital.ai).
- Rate limiting or abuse prevention — the server makes no attempt to throttle requests; that responsibility lies with the platform.
- The AI assistant's decision-making — this server provides tools; what an LLM chooses to call is outside this project's trust boundary.
- Issues that require a valid `DIGITAL_AI_ACCESS_KEY` to exploit — possession of a valid key is assumed to grant the corresponding level of access.
