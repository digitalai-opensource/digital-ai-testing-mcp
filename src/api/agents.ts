import { apiGet } from './client.js';
import type { Agent } from '../types/digital-ai.js';

// v2 API — Cloud Admin (JWT) only. Project API keys receive 403 Forbidden.

export async function getAgents(): Promise<Agent[]> {
  try {
    const res = await apiGet<Agent[]>('/api/v2/agents');
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getAgents failed: ${(e as Error).message}`);
  }
}

export async function getAgent(agentId: number): Promise<Agent> {
  try {
    const agents = await getAgents();
    const agent = agents.find(a => a.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    return agent;
  } catch (e) {
    throw new Error(`getAgent failed: ${(e as Error).message}`);
  }
}

export async function getAgentDevices(agentId: number): Promise<unknown[]> {
  try {
    const res = await apiGet<unknown[]>(`/api/v2/agents/${agentId}/devices`);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    throw new Error(`getAgentDevices failed: ${(e as Error).message}`);
  }
}
