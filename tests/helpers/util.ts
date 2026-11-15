import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async <T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> => {
  const { timeoutMs = 8_000, intervalMs = 40, label = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? ` (${lastError.message})` : ''}.`);
};

export const getFreePort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a test port.');
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

export const makeTempDir = (label: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `oc-discord-${label}-`));

export const removeDir = (directory: string): Promise<void> =>
  rm(directory, { recursive: true, force: true }).catch(() => undefined);
