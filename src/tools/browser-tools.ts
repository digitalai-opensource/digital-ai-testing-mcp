import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllBrowsers,
  startWebControlSession,
  startWebControlWithTemplate,
} from '../api/browsers.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatBrowserList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerBrowserTools(server: McpServer): void {
  server.tool(
    'list_available_browsers',
    'Lists all browser/OS combinations available for Selenium testing in your Digital.ai environment. Shows browser name, version, OS, and which agent hosts them.',
    {
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ maxResults, outputFormat }) => {
      try {
        const browsers = await getAllBrowsers();
        const paged = applyMaxResults(browsers, maxResults);
        const structured = {
          browsers: paged.items.map(b => ({
            browserName: b.browserName,
            browserVersion: b.browserVersion,
            platform: b.platform,
            osName: b.osName,
            agentName: b.agentName,
            region: b.region,
          })),
        };
        const humanText = appendTruncationNotice(
          `Available browsers (${paged.total} total):\n\n${formatBrowserList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'start_selenium_session',
    'Opens an interactive browser-based Selenium session. Returns a URL you can open to start a manual browser test. Use list_available_browsers to find valid browser/OS combinations.',
    {
      browserName: z
        .string()
        .optional()
        .describe("Browser name, e.g. 'chrome', 'firefox', 'MicrosoftEdge', 'safari'."),
      browserVersion: z
        .string()
        .optional()
        .describe("Browser version, e.g. '95.0'. Leave blank for the latest available."),
      os: z
        .string()
        .optional()
        .describe("Operating system, e.g. 'Windows 10', 'macOS'."),
    },
    async ({ browserName, browserVersion, os }) => {
      try {
        const result = await startWebControlSession({ browserName, browserVersion, os });
        return {
          content: [
            {
              type: 'text',
              text: `✅ Selenium session started.\nSession URL: ${result.regularLink}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'start_manual_test_session',
    'Creates a structured manual browser test with predefined steps. Returns a session URL and a report ID for retrieving results from the Reporter.',
    {
      testName: z.string().describe('Name of the test (appears in the report).'),
      testSteps: z
        .array(
          z.object({
            name: z.string().max(255).describe('Step name (max 255 characters).'),
            description: z.string().optional().describe('What to do in this step.'),
            expectedResult: z.string().optional().describe('Expected outcome.'),
            attachment: z.string().optional().describe('URL to attachment or screenshot.'),
          })
        )
        .describe('Ordered list of test steps.'),
      browserName: z.string().optional().describe("Browser name, e.g. 'chrome'."),
      browserVersion: z.string().optional().describe('Browser version.'),
      osName: z
        .string()
        .optional()
        .describe("OS name, e.g. 'Windows 10'."),
    },
    async ({ testName, testSteps, browserName, browserVersion, osName }) => {
      try {
        const result = await startWebControlWithTemplate({
          testName,
          testSteps,
          browserName,
          browserVersion,
          osName,
        });
        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ Manual browser test session created: "${testName}"`,
                `Session URL: ${result.link}`,
                `Report ID: ${result.report_api_id}`,
                `Steps: ${testSteps.length}`,
              ].join('\n'),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
