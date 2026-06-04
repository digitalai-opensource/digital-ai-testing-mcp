import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRegions, getRegionTopology } from '../api/regions.js';
import { formatRegionList, formatRegionTopology } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerRegionTools(server: McpServer): void {
  server.tool(
    'list_regions',
    'List all geographic regions in the Digital.ai platform — US1, UK1, SG1, DE1, AU1, CA1, US2, CH1. Shows status, host, and whether a region is the master. Cloud Admin only.',
    {
      outputFormat: outputFormatParam,
    },
    async ({ outputFormat }) => {
      try {
        const regions = await getRegions();
        const structured = {
          regions: regions.map(r => ({
            id: r.id,
            name: r.name,
            master: r.master,
            status: r.status,
            location: r.location,
            hostOrIp: r.hostOrIp,
            port: r.port,
            version: r.version,
            errors: r.errors,
            warnings: r.warnings,
          })),
        };
        return respond(outputFormat, structured, formatRegionList(regions));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_region_topology',
    'Get the full infrastructure topology of a region: NV servers, Selenium agents, signers, storages, DHMs, EHMs, reporters, and more. Useful for diagnosing connectivity issues. Cloud Admin only.',
    {
      regionId: z.number().int().describe('Numeric region ID from list_regions.'),
      regionName: z.string().optional().describe('Region name for display (e.g. "US1"). Optional — used in output only.'),
      outputFormat: outputFormatParam,
    },
    async ({ regionId, regionName, outputFormat }) => {
      try {
        const topology = await getRegionTopology(regionId);
        const label = regionName ?? `Region ${regionId}`;
        return respond(outputFormat, topology as object, formatRegionTopology(label, topology));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
