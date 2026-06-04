import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAgents, getAgentDevices } from '../api/agents.js';
import { formatAgentList, formatDeviceList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import type { Device } from '../types/digital-ai.js';

export function registerAgentTools(server: McpServer): void {
  server.tool(
    'list_agents',
    'List all test agents (host machines) connected to the platform. Shows OS, region, device count, status, and any warnings. Cloud Admin only.',
    {
      region: z.string().optional().describe('Filter by region code (client-side, partial match). E.g. "US1", "SG1".'),
      osType: z.string().optional().describe('Filter by OS type (client-side, case-insensitive). E.g. "Mac", "Linux", "Windows".'),
      availableOnly: z.boolean().optional().describe('If true, return only agents that are available and enabled.'),
      maxResults: z.number().optional().default(50).describe('Maximum number of results to return (default: 50).'),
      outputFormat: outputFormatParam,
    },
    async ({ region, osType, availableOnly, maxResults, outputFormat }) => {
      try {
        let agents = await getAgents();
        if (region) {
          const q = region.toLowerCase();
          agents = agents.filter(a =>
            (a.region?.name ?? '').toLowerCase().includes(q) ||
            (a.location ?? '').toLowerCase().includes(q)
          );
        }
        if (osType) {
          const q = osType.toLowerCase();
          agents = agents.filter(a => a.osType.toLowerCase().includes(q));
        }
        if (availableOnly) {
          agents = agents.filter(a => a.available && a.enabled);
        }
        const paged = applyMaxResults(agents, maxResults);
        const structured = {
          agents: paged.items.map(a => ({
            id: a.id,
            name: a.name,
            region: a.region?.name ?? null,   // string name for easy consumption
            regionDetail: a.region,            // full object {id, name, master, icon}
            location: a.location,
            osType: a.osType,
            osVersion: a.osVersion,
            xcodeVersion: a.xcodeVersion,
            version: a.version,
            available: a.available,
            enabled: a.enabled,
            devicesCount: a.devicesCount,
            statusForDisplay: a.statusForDisplay,
            warningMessages: a.warningMessages,
          })),
          total: paged.total,
          truncated: paged.truncated,
        };
        const header = `Found ${paged.total} agent(s):\n\n`;
        const humanText = appendTruncationNotice(header + formatAgentList(paged.items), paged);
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_agent_devices',
    'List all devices connected to a specific agent (host machine). Cloud Admin only.',
    {
      agentId: z.number().int().describe('Numeric agent ID from list_agents.'),
      outputFormat: outputFormatParam,
    },
    async ({ agentId, outputFormat }) => {
      try {
        const devices = await getAgentDevices(agentId) as Device[];
        const structured = { agentId, deviceCount: devices.length, devices };
        const humanText = devices.length === 0
          ? `No devices found on agent ${agentId}.`
          : `${devices.length} device(s) on agent ${agentId}:\n\n` + formatDeviceList(devices);
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
