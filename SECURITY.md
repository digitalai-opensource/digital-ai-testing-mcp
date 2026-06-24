# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 1.0.x (latest) | ✅ |
| < 1.0.0 | ❌ |

Security fixes are applied to the latest release only. We do not backport to older minor versions.

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities via GitHub Issues.**

To report a vulnerability, use [GitHub's private security advisory feature](https://github.com/dai-continuous-testing/digital-ai-testing-mcp/security/advisories/new). This keeps the report confidential until a fix is available.

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
- Cloud Admin JWTs grant full administrative access to the platform — user management, project deletion, device control. Treat them with the same care as a root credential.
- Project-scoped API keys (`aut_1_...`) are narrower in scope but still grant installation, test execution, and reporting access for the assigned project.
- The `get_remote_debug_command` tool embeds the active access key in the generated script file. The generated script is intended for local use only — delete it after your session. The tool includes a warning to this effect.
- Tools that read local files for upload (`upload_application_file`, `upload_repository_file`, `update_repository_file`, `upload_provisioning_profile`) validate the path first and refuse credential-file names (`.env*`, SSH private keys) — a steered or mistaken request cannot publish secrets to the cloud repository.
- Credentials are resolved through the active connection profile (`switch_environment`), never raw environment variables — generated artifacts (boilerplate, rdb scripts) always carry the currently active profile's key, so a project-scoped key can be used for customer-facing output.

### What This Server Can Do

When connected to an AI assistant, this MCP server can — on behalf of the operator:

- Create, delete, and manage user accounts (Cloud Admin key)
- Install and uninstall applications on physical and virtual devices
- Reserve, release, and reboot devices
- Delete test reports and repository files (requires `confirmDeletion: true`)
- Create and delete projects and device groups

All destructive operations are guarded by an explicit `confirmDeletion: true` parameter that must be set by the caller. A missing or `false` value returns a confirmation prompt, not an error, so the AI is clearly instructed to re-call with confirmation rather than treating the guard as a failure.

### Transport Security

The server communicates over the MCP stdio transport. There is no HTTP listener, no open port, and no web-facing interface. Network access is outbound only — to the configured `DIGITAL_AI_BASE_URL` endpoint. All API calls use HTTPS.

### Docker Isolation

When run via Docker (the recommended deployment), the container has no access to the host filesystem except for the explicitly mounted `.env` file. The container runs as a non-root user. No ports are published.

### Dependency Audit

Runtime dependencies are minimal (Axios, dotenv, Zod, the MCP SDK). Development dependencies include Vitest. Run `npm audit --omit=dev` to check for vulnerabilities in production dependencies. No known findings are currently tracked.

---

## Out of Scope

The following are not treated as security vulnerabilities in this project:

- Vulnerabilities in the Digital.ai Testing platform itself — report those to [Digital.ai Support](https://support.digital.ai).
- Rate limiting or abuse prevention — the server makes no attempt to throttle requests; that responsibility lies with the platform.
- The AI assistant's decision-making — this server provides tools; what an LLM chooses to call is outside this project's trust boundary.
- Issues that require a valid `DIGITAL_AI_ACCESS_KEY` to exploit — possession of a valid key is assumed to grant the corresponding level of access.
