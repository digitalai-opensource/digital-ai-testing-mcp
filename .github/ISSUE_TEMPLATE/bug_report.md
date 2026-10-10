---
name: Bug report
about: Report something that doesn't work as documented
title: ''
labels: ''
assignees: ''

---

> Security issue? Don't file it here — use a private advisory (see SECURITY.md).
> Never paste access keys, `.env` contents, or the output of `*_command` tools — they contain credentials.

**Describe the bug**
What went wrong, in a sentence or two.

**Environment**
- MCP server version (from `get_server_info`): [e.g. 2.0.0]
- Install: [npm (`MCP_DEPLOYMENT_MODE=local`) / Docker (image tag) / from source]
- Node.js version (npm installs): [e.g. 22.x]
- AI client and version: [Claude Code / Claude Desktop / Cursor / VS Code / other]
- `MCP_TOOLSETS`: [unset / value]
- `MCP_DEBUG_MODE`: [false / true]
- Access level (from `list_environments`): [Cloud Admin / Project Admin / Project User]
- Project type, if relevant: [Appium Server / Appium Grid]; device platform and region, if relevant

**Steps to reproduce**
1. Prompt given to the AI, or the tool you called:
2. Tool parameters (redact keys):
3. Tool response (redact keys and URLs):

**Expected behavior**
What you expected to happen instead.

**Remediation note**
If debug mode was on, attach the relevant `remediation/*.md` file after reviewing it for customer data.

**Additional context**
Anything else that helps.
