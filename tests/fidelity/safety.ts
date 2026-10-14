/**
 * Which MCP tools a fidelity-eval agent may actually RUN. Everything else (deletes, creates, updates, sessions, test
 * runs, public sharing, installs, downloads…) is denied by the headless CLI — the attempt is still recorded and scored,
 * so scenarios can judge the agent's choice without anything changing on the tenant.
 */
import { REGISTERED_TOOLS } from '../../src/tools/meta-tools.js';
import { isReadOnlyTool } from '../../src/utils/tool-annotations.js';

/**
 * The same rule the server uses for readOnlyHint annotations, so the eval allows exactly what the server declares
 * read-only. get_*_command tools only generate text (their output embeds the access key — transcripts are redacted).
 */
export const SAFE_TOOLS: string[] = (REGISTERED_TOOLS as readonly string[]).filter(isReadOnlyTool);
