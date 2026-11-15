import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MockDiscordServer } from './helpers/mock-discord.ts';
import { getFreePort, makeTempDir, removeDir, sleep, waitFor } from './helpers/util.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-service-token';

type SessionRecord = {
  id: string;
  projectID: string;
  parentID?: string;
  title: string;
  model: { id: string; providerID?: string; variant?: string };
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  cost: number;
  time: { created: number; updated: number; viewed?: number; idle?: number };
  location: { directory: string };
};

class MockOpenCode {
  private server: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();
  private eventSeq = 0;
  port = 0;
  active = false;
  session: SessionRecord;

  constructor(session: SessionRecord) {
    this.session = session;
  }

  get eventClients(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    const server = http.createServer((request, response) => this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Mock OpenCode did not bind.'));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }

  private authorized(request: http.IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${TOKEN}`;
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (!this.authorized(request)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }));
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/event') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.flushHeaders();
      response.write(`data: ${JSON.stringify({
        id: 'evt_connected',
        created: Date.now(),
        type: 'server.connected',
        data: {},
      })}\n\n`);
      this.clients.add(response);
      request.on('close', () => this.clients.delete(response));
      return;
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [this.session], cursor: { previous: null, next: null } }));
      return;
    }
    if (url.pathname === '/api/session/active' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: this.active ? { [this.session.id]: { type: 'running' } } : {},
      }));
      return;
    }
    if (url.pathname === `/api/session/${this.session.id}` && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: this.session }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not-found' }));
  }

  emit(type: string, data: Record<string, unknown>, created = Date.now()): void {
    this.eventSeq += 1;
    const event = {
      id: `evt_${this.eventSeq}`,
      created,
      type,
      data,
      location: { directory: this.session.location.directory },
    };
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
  }
}

type ServiceHandle = {
  port: number;
  child: ChildProcess;
  logs: () => string;
  stop: () => Promise<void>;
};

const startService = async (env: Record<string, string>): Promise<ServiceHandle> => {
  const port = await getFreePort();
  let logs = '';
  const child = spawn(process.execPath, ['service/main.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    logs += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logs += chunk.toString('utf8');
  });
  child.once('exit', (code, signal) => {
    logs += `\n[service exited code=${code} signal=${signal}]\n`;
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Service exited early.\n${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
          signal: AbortSignal.timeout(500),
        });
        return response.ok;
      } catch {
        return false;
      }
    }, { label: 'service health', timeoutMs: 10_000 });
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${String(error)}\n${logs}`);
  }

  return {
    port,
    child,
    logs: () => logs,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(5_000),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
};

const api = async (
  port: number,
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: Record<string, unknown> | null }> => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
};

const statusOf = async (port: number): Promise<Record<string, any>> => {
  const result = await api(port, 'GET', '/status');
  assert.equal(result.status, 200);
  return result.body as Record<string, any>;
};

const sessionRecord = (directory = '/tmp/MyGame'): SessionRecord => {
  const now = Date.now();
  return {
    id: 'ses_test',
    projectID: 'prj_test',
    title: 'A private title that must never be used',
    model: { id: 'qwen3.5', providerID: 'local', variant: 'default' },
    tokens: { input: 1_000, output: 2_000, reasoning: 500, cache: { read: 0, write: 0 } },
    cost: 0.42,
    time: { created: now - 60_000, updated: now, viewed: now },
    location: { directory },
  };
};

const turnEvent = (
  type: 'turn-started' | 'turn-finished' | 'turn-failed',
  at = Date.now(),
  sessionId = 'ses_test',
  directory = '/tmp/MyGame',
) => ({
  v: 1,
  requestId: `req_${type}_${at}_${Math.random().toString(16).slice(2)}`,
  event: {
    id: `evt_${type}_${at}`,
    type,
    at,
    session: { id: sessionId, parentId: null },
    project: { directory },
    linked: [],
  },
});

test('service follows a session, model, project, idle clear, and persists settings', async () => {
  const dataDir = await makeTempDir('data');
  const discord = new MockDiscordServer();
  const opencode = new MockOpenCode(sessionRecord());
  await discord.start();
  await opencode.start();
  const service = await startService({
    OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
    OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${opencode.port}`,
    OPENCHAMBER_SERVICE_SOCKETS: JSON.stringify({ 'discord-ipc': discord.socketPath }),
    DISCORD_IPC_PATH: discord.socketPath,
    OPENCHAMBER_DISCORD_IDLE_CLEAR_MS: '350',
    OPENCHAMBER_DISCORD_MIN_UPDATE_MS: '0',
  });

  try {
    assert.equal((await api(service.port, 'GET', '/status', undefined, null)).status, 401);
    await waitFor(async () => {
      const status = await statusOf(service.port);
      return status.presence?.project === 'MyGame' && status.discord?.connected === true;
    }, { label: 'initial session presence', timeoutMs: 10_000 });

    const initial = await statusOf(service.port);
    assert.equal(initial.presence.details, 'Working on MyGame · 2.5k tokens');
    assert.equal(initial.presence.state, 'Idle · Qwen3.5');
    assert.equal(initial.presence.hasSession, true);
    assert.equal(initial.presence.working, false);
    assert.equal(initial.presence.tokens, 2_500);
    assert.equal(initial.presence.cost, 0.42);
    assert.ok(initial.presence.startedAt < Date.now());
    assert.equal(initial.opencode.available, true);
    await discord.waitForActivity((value) => value?.details === 'Working on MyGame · 2.5k tokens');

    await waitFor(() => opencode.eventClients > 0, { label: 'OpenCode SSE client' });
    opencode.emit('session.execution.started', { sessionID: 'ses_test' });
    await waitFor(async () => (await statusOf(service.port)).presence.working === true, {
      label: 'turn start',
    });
    await discord.waitForActivity((value) => value?.state === 'Coding with Qwen3.5');

    opencode.emit('session.model.selected', {
      sessionID: 'ses_test',
      model: { id: 'llama-3.3-70b', providerID: 'meta' },
    });
    await waitFor(async () => (await statusOf(service.port)).presence.model === 'Llama 3.3 70b', {
      label: 'model change',
    });

    opencode.emit('session.usage.updated', {
      sessionID: 'ses_test',
      cost: 0.5,
      tokens: { input: 2_000, output: 10_000, reasoning: 2_000, cache: { read: 0, write: 0 } },
    });
    await waitFor(async () => {
      const status = await statusOf(service.port);
      return status.presence.tokens === 12_000 && status.presence.cost === 0.5;
    }, { label: 'usage update' });
    assert.match((await statusOf(service.port)).presence.details, /12k tokens/);

    opencode.session.location = { directory: '/tmp/OtherGame' };
    opencode.emit('session.moved', {
      sessionID: 'ses_test',
      location: { directory: '/tmp/OtherGame' },
    });
    await waitFor(async () => (await statusOf(service.port)).presence.project === 'OtherGame', {
      label: 'project change',
    });

    const saved = await api(service.port, 'POST', '/settings', {
      clearWhenIdle: true,
      showElapsed: false,
      showCost: true,
      customActivity: '',
    });
    assert.equal(saved.status, 200);
    assert.equal((saved.body as Record<string, any>).settings.clearWhenIdle, true);
    assert.equal((saved.body as Record<string, any>).settings.showElapsed, false);
    assert.equal((saved.body as Record<string, any>).settings.showCost, true);
    assert.match((await statusOf(service.port)).presence.state, /\$0\.50/);

    await api(service.port, 'POST', '/session-events', turnEvent('turn-finished', Date.now(), 'ses_test', '/tmp/OtherGame'));
    await waitFor(async () => (await statusOf(service.port)).presence.working === false, {
      label: 'turn finish',
    });
    const idle = await statusOf(service.port);
    assert.equal(idle.presence.details, 'Working on OtherGame · 12k tokens');
    assert.equal(idle.presence.state, 'Idle · Llama 3.3 70b · $0.50');

    await waitFor(async () => {
      const status = await statusOf(service.port);
      return status.presence.visible === false && status.presence.reason === 'idle-cleared';
    }, { label: 'idle clear', timeoutMs: 5_000 });
    await discord.waitForActivity((value) => value === null, 5_000);

    await api(service.port, 'POST', '/session-events', turnEvent('turn-started', Date.now(), 'ses_test', '/tmp/OtherGame'));
    await waitFor(async () => {
      const status = await statusOf(service.port);
      return status.presence.visible === true && status.presence.working === true;
    }, { label: 'turn restart' });
    await discord.waitForActivity((value) => value?.state === 'Coding with Llama 3.3 70b · $0.50');

    const malformed = await api(service.port, 'POST', '/session-events', { v: 1 });
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as Record<string, unknown>).ok, false);

    const missing = await api(service.port, 'POST', '/session-events', {
      v: 1,
      requestId: 'req_missing',
      event: { id: 'evt_missing', type: 'turn-finished', at: Date.now(), session: {}, project: {}, linked: [] },
    });
    assert.equal(missing.status, 400);
  } finally {
    await service.stop();
  }

  // Restart with the same data directory: the settings must survive.
  const restarted = await startService({
    OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
    OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${opencode.port}`,
    OPENCHAMBER_SERVICE_SOCKETS: JSON.stringify({ 'discord-ipc': discord.socketPath }),
    DISCORD_IPC_PATH: discord.socketPath,
    OPENCHAMBER_DISCORD_IDLE_CLEAR_MS: '350',
    OPENCHAMBER_DISCORD_MIN_UPDATE_MS: '0',
  });
  try {
    const status = await waitFor(async () => {
      const value = await statusOf(restarted.port);
      return value.settings?.clearWhenIdle === true ? value : null;
    }, { label: 'persisted settings' });
    assert.equal((status as Record<string, any>).settings.showElapsed, false);
    assert.equal((status as Record<string, any>).settings.showCost, true);
    assert.equal((status as Record<string, any>).settings.clearWhenIdle, true);
  } finally {
    await restarted.stop();
    await opencode.stop();
    await discord.dispose();
    await removeDir(dataDir);
  }
});

test('service degrades to fallback presence without OpenCode metadata', async () => {
  const dataDir = await makeTempDir('fallback');
  const discord = new MockDiscordServer();
  await discord.start();
  const service = await startService({
    OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
    OPENCHAMBER_SERVICE_SOCKETS: JSON.stringify({ 'discord-ipc': discord.socketPath }),
    DISCORD_IPC_PATH: discord.socketPath,
    OPENCHAMBER_DISCORD_MIN_UPDATE_MS: '0',
  });
  try {
    await waitFor(async () => (await statusOf(service.port)).discord.connected === true, {
      label: 'fallback Discord connection',
    });
    const status = await statusOf(service.port);
    assert.equal(status.opencode.available, false);
    assert.equal(status.presence.hasSession, false);
    assert.equal(status.presence.details, 'OpenChamber AI Coding');
    assert.equal(status.presence.state, 'Ready');
    assert.equal(status.presence.visible, true);
    await discord.waitForActivity((value) => value?.details === 'OpenChamber AI Coding');

    // The panel can still provide context when OpenCode read access is off.
    await api(service.port, 'POST', '/status', {
      sessionId: 'ses_panel',
      directory: '/tmp/PanelProject',
      model: 'openrouter/qwen3.5',
      busy: true,
    });
    const withContext = await statusOf(service.port);
    assert.equal(withContext.presence.project, 'PanelProject');
    assert.equal(withContext.presence.model, 'Qwen3.5');
    assert.equal(withContext.presence.state, 'Coding with Qwen3.5');
    assert.equal(withContext.presence.working, true);
    await discord.waitForActivity((value) => value?.details === 'Working on PanelProject');
  } finally {
    await service.stop();
    await discord.dispose();
    await removeDir(dataDir);
  }
});
