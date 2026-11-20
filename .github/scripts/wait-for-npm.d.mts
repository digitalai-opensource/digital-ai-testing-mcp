export function tarballUrl(pkg: string, version: string): string;

export function waitForNpm(options: {
  pkg: string;
  version: string;
  fetch?: (url: string) => Promise<{ status: number }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  timeoutMs?: number;
  intervalMs?: number;
  marginMs?: number;
  confirmations?: number;
}): Promise<boolean>;
