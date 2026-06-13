import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentRegion } from '../types/digital-ai.js';
import { getNvServers, getNvServer } from '../api/nv-servers.js';
import { formatNvServerList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

const regionName = (r: AgentRegion | string | undefined): string =>
  typeof r === 'object' && r !== null ? r.name : (r ?? '');

export function registerNvServerTools(server: McpServer): void {
  server.tool(
    'list_nv_servers',
    'List all Network Virtualization (NV) servers. Shows status, region, host, and tunneling connectivity. NV servers enable network condition simulation (latency, packet loss, bandwidth throttling) during test sessions. ' +
    'CALL THIS BEFORE running any performance-instrumented test session: a performance transaction records nothing unless an NV server in the device\'s region is ONLINE and tunnel-connected. Speed Index and network metrics collected without a connected NV server are unreliable and will produce misleading compare_performance_transactions results. Filter with region=<device region> and connectedOnly=true to confirm one is available. Cloud Admin only.',
    {
      region: z.string().optional().describe('Filter by region name (client-side, partial match). E.g. "US1", "SG1".'),
      connectedOnly: z.boolean().optional().describe('If true, return only NV servers with active tunneling connections.'),
      outputFormat: outputFormatParam,
    },
    async ({ region, connectedOnly, outputFormat }) => {
      try {
        let servers = await getNvServers();
        if (region) {
          const q = region.toLowerCase();
          servers = servers.filter(s => regionName(s.region).toLowerCase().includes(q));
        }
        if (connectedOnly) {
          servers = servers.filter(s => s.tunnelingConnected);
        }
        const structured = {
          nvServers: servers.map(s => ({
            id: s.id,
            name: s.name,
            region: regionName(s.region),
            hostOrIp: s.hostOrIp,
            status: s.status,
            tunnelingConnected: s.tunnelingConnected,
            proxyServerPort: s.proxyServerPort,
            tunnelingPort: s.tunnelingPort,
            version: s.version,
            error: s.error,
          })),
          total: servers.length,
        };
        return respond(outputFormat, structured, formatNvServerList(servers));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_nv_server',
    'Get details for a specific NV server by ID. Cloud Admin only.',
    {
      nvServerId: z.number().int().describe('Numeric NV server ID from list_nv_servers.'),
      outputFormat: outputFormatParam,
    },
    async ({ nvServerId, outputFormat }) => {
      try {
        const server_data = await getNvServer(nvServerId);
        const lines = [
          `NV Server: ${server_data.name} (ID: ${server_data.id})`,
          `Region: ${regionName(server_data.region)}`,
          `Host: ${server_data.hostOrIp}`,
          `Status: ${server_data.status}`,
          `Tunneling: ${server_data.tunnelingConnected ? '✅ Connected' : '❌ Disconnected'}`,
          server_data.proxyServerPort ? `Proxy Port: ${server_data.proxyServerPort}` : '',
          server_data.tunnelingPort ? `Tunnel Port: ${server_data.tunnelingPort}` : '',
          server_data.version ? `Version: ${server_data.version}` : '',
          server_data.error ? `⚠️ Error: ${server_data.error}` : '',
        ].filter(Boolean).join('\n');
        return respond(outputFormat, server_data as unknown as object, lines);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
