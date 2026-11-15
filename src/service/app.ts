import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { readSessionEventRequest } from '@openchamber/sdk';

import packageJson from '../../package.json';
import {
  buildPresenceCopy,
  DEFAULT_APPLICATION_ID,
  desiredActivity,
  IDLE_CLEAR_DELAY_MS,
  type Settings,
  type SessionView,
} from '../shared.ts';
import {
  DiscordBridge,
  discoverDiscordIpcPaths,
  type DiscordBridgeStatus,
  type Logger,
} from './discord.ts';
import {
  OpenCodeEventsClient,
  type OpenCodeStatus,
} from './opencode.ts';
import { SettingsStore, mergeSettings } from './settings.ts';
import { SessionTracker, type GuestSessionEvent, type PanelContext } from './tracker.ts';

const VERSION = packageJson.version;
const MAX_BODY_BYTES = 256 * 1024;
const HEALTH_PATH = '/health';
const SESSION_EVENTS_PATH = '/session-events';

const EVENT_TYPES = [
  'session.created',
  'session.viewed',
  'session.model.selected',
  'session.usage.updated',
  'session.moved',
  'session.archived',
  'session.deleted',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.step.started',
  'session.idle',
  'session.status',
];

const SDK_EVENT_MAX_BYTES = 64 * 1024;

const defaultLogger: Logger = {
  info: (...args: unknown[]) => console.log('[discord-rpc]', ...args),
  warn: (...args: unknown[]) => console.warn('[discord-rpc]', ...args),
  error: (...args: unknown[]) => console.error('[discord-rpc]', ...args),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  if (response.destroyed || response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
};

const readBody = (request: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(() => reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 })));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', (error) => finish(() => reject(error)));
    request.on('aborted', () => finish(() => reject(Object.assign(new Error('Request was aborted.'), { statusCode: 400 }))));
  });

const parseJsonBody = async (request: http.IncomingMessage): Promise<unknown> => {
  const body = await readBody(request);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400 });
  }
};

const bearerMatches = (header: string | undefined, token: string): boolean => {
  if (!header || !token) return false;
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  const actual = Buffer.from(header, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};

const presenceReason = (
  settings: Settings,
  session: SessionView,
  cleared: boolean,
): 'disabled' | 'idle-cleared' | 'no-session' | 'working' | 'idle' => {
  if (!settings.enabled) return 'disabled';
  if (cleared) return 'idle-cleared';
  if (!session.hasSession) return 'no-session';
  return session.working ? 'working' : 'idle';
};

export type PresenceAppStatus = {
  ok: true;
  version: string;
  settings: Settings;
  discord: DiscordBridgeStatus;
  opencode: OpenCodeStatus;
  tracker: { currentSessionId: string | null; trackedSessions: number; working: boolean };
  presence: {
    visible: boolean;
    details: string;
    state: string;
    startedAt: number | null;
    largeImageKey: string;
    largeImageText: string;
    project: string | null;
    model: string | null;
    tokens: number | null;
    cost: number | null;
    working: boolean;
    hasSession: boolean;
    reason: 'disabled' | 'idle-cleared' | 'no-session' | 'working' | 'idle';
    clearAt: number | null;
  };
};

export type PresenceAppOptions = {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  now?: () => number;
};

/**
 * The extension's host-side service. It owns the Discord IPC connection, reads
 * only session metadata from OpenCode, and answers the settings panel over the
 * host's authenticated loopback proxy.
 */
export class PresenceApp {
  readonly version = VERSION;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly dataDir: string;
  private readonly token: string | null;
  private readonly port: number | null;
  private readonly idleClearDelayMs: number;
  private settingsStore!: SettingsStore;
  private bridge!: DiscordBridge;
  private opencode!: OpenCodeEventsClient;
  private tracker!: SessionTracker;
  private server: http.Server | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private cleared = false;
  private startedAt = 0;

  constructor(options: PresenceAppOptions = {}) {
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
    this.dataDir = SettingsStore.defaultDataDir(this.env);
    this.token = this.env.OPENCHAMBER_SERVICE_TOKEN || null;
    const port = Number(this.env.OPENCHAMBER_SERVICE_PORT);
    this.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    // The host does not set this. It exists so an integration test can prove the
    // idle-clear path without waiting 45 seconds.
    const idleOverride = Number(this.env.OPENCHAMBER_DISCORD_IDLE_CLEAR_MS);
    this.idleClearDelayMs = Number.isFinite(idleOverride) && idleOverride >= 0
      ? idleOverride
      : IDLE_CLEAR_DELAY_MS;
  }

  async start(): Promise<void> {
    if (!this.token) {
      throw new Error('OPENCHAMBER_SERVICE_TOKEN is missing; refusing to start an unauthenticated service.');
    }
    if (this.port === null) {
      throw new Error('OPENCHAMBER_SERVICE_PORT is missing or invalid.');
    }
    this.startedAt = this.now();
    this.settingsStore = new SettingsStore(this.dataDir, this.logger);
    const settings = await this.settingsStore.load();

    const minUpdate = Number(this.env.OPENCHAMBER_DISCORD_MIN_UPDATE_MS);
    this.bridge = new DiscordBridge({
      applicationId: DEFAULT_APPLICATION_ID,
      enabled: settings.enabled,
      logger: this.logger,
      candidates: () => discoverDiscordIpcPaths(this.env).paths,
      ...(Number.isFinite(minUpdate) && minUpdate >= 0 ? { minUpdateIntervalMs: minUpdate } : {}),
    });

    this.opencode = new OpenCodeEventsClient({
      baseUrl: this.env.OPENCHAMBER_OPENCODE_URL ?? null,
      token: this.env.OPENCHAMBER_SERVICE_TOKEN || this.env.OPENCHAMBER_OPENCODE_TOKEN || null,
      logger: this.logger,
      types: EVENT_TYPES,
      onEvent: (event) => {
        void this.tracker.handleWireEvent(event).catch((error: unknown) => {
          this.logger.warn('Could not apply an OpenCode event:', error instanceof Error ? error.message : error);
        });
      },
      onConnected: () => {
        void this.tracker.reconcile(false);
      },
    });

    this.tracker = new SessionTracker({
      opencode: this.opencode,
      logger: this.logger,
      notify: () => this.refreshPresence(),
      now: this.now,
    });

    await this.startServer();
    this.refreshPresence();
    this.bridge.start();
    this.opencode.start();
    void this.tracker.reconcile(true);
    this.logger.info(`Discord Rich Presence ${VERSION} is listening on 127.0.0.1:${this.port}.`);
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response);
      });
      server.on('error', reject);
      server.listen(this.port as number, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error('The local service did not bind a port.'));
          return;
        }
        this.server = server;
        resolve();
      });
    });
  }

  private isAuthorized(request: http.IncomingMessage): boolean {
    return bearerMatches(request.headers.authorization, this.token ?? '');
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.isAuthorized(request)) {
      json(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    try {
      if (path === HEALTH_PATH && method === 'GET') {
        json(response, 200, {
          ok: true,
          service: 'openchamber-discord-rpc',
          version: this.version,
          uptimeMs: this.now() - this.startedAt,
          discord: this.bridge.status().mode,
          opencode: this.opencode.status().connected,
        });
        return;
      }

      if (path === '/status' && method === 'GET') {
        json(response, 200, this.statusPayload());
        return;
      }

      if (path === '/status' && method === 'POST') {
        const body = await parseJsonBody(request);
        const context = this.readPanelContext(body);
        if (context) {
          this.tracker.applyPanelContext(context);
          this.refreshPresence();
        }
        json(response, 200, this.statusPayload());
        return;
      }

      if (path === '/settings' && method === 'GET') {
        json(response, 200, { ok: true, settings: this.settingsStore.get() });
        return;
      }

      if (path === '/settings' && method === 'POST') {
        const body = await parseJsonBody(request);
        const previous = this.settingsStore.get();
        const merged = mergeSettings(previous, body);
        if (!merged.ok) {
          json(response, 400, { ok: false, error: merged.error });
          return;
        }
        try {
          await this.settingsStore.save(merged.settings);
        } catch (error) {
          this.logger.warn('Could not save settings:', error instanceof Error ? error.message : error);
          json(response, 500, { ok: false, error: 'Could not save settings.' });
          return;
        }
        this.applySettings(previous, merged.settings);
        json(response, 200, this.statusPayload());
        return;
      }

      if (path === '/reconnect' && method === 'POST') {
        this.bridge.restart('Reconnecting at the user\'s request.');
        json(response, 200, this.statusPayload());
        return;
      }

      if (path === '/refresh' && method === 'POST') {
        await this.tracker.reconcile(true);
        this.refreshPresence();
        json(response, 200, this.statusPayload());
        return;
      }

      if (path === SESSION_EVENTS_PATH && method === 'POST') {
        const body = await readBody(request);
        if (Buffer.byteLength(body, 'utf8') > SDK_EVENT_MAX_BYTES) {
          json(response, 400, { ok: false, error: 'Session event is too large.' });
          return;
        }
        const parsed = readSessionEventRequest(body);
        if (!parsed) {
          json(response, 400, { ok: false, error: 'Not a supported session event.' });
          return;
        }
        this.tracker.handleSessionEvent(parsed as unknown as GuestSessionEvent);
        this.refreshPresence();
        json(response, 200, { ok: true });
        return;
      }

      json(response, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      const statusCode = isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : 500;
      const message = statusCode === 413
        ? 'Request body is too large.'
        : statusCode === 400
          ? error instanceof Error ? error.message : 'Bad request.'
          : 'The service could not handle the request.';
      if (statusCode >= 500) {
        this.logger.warn('Request failed:', error instanceof Error ? error.message : error);
      }
      json(response, statusCode, { ok: false, error: message });
    }
  }

  private readPanelContext(body: unknown): PanelContext | null {
    if (!isRecord(body) || !('sessionId' in body)) return null;
    const sessionId = body.sessionId;
    if (sessionId !== null && typeof sessionId !== 'string') return null;
    if (typeof sessionId === 'string' && !/^ses_[\w-]+$/.test(sessionId)) return null;

    const directory = body.directory;
    if (directory !== undefined && directory !== null && typeof directory !== 'string') return null;
    const model = body.model;
    if (model !== undefined && model !== null && typeof model !== 'string') return null;
    const busy = body.busy;
    if (busy !== undefined && busy !== null && typeof busy !== 'boolean') return null;

    return {
      sessionId: sessionId as string | null,
      directory: typeof directory === 'string' ? directory : null,
      model: typeof model === 'string' ? model : null,
      busy: typeof busy === 'boolean' ? busy : null,
    };
  }

  private applySettings(previous: Settings, next: Settings): void {
    if (previous.enabled !== next.enabled) {
      this.bridge.setEnabled(next.enabled);
    }
    this.refreshPresence();
  }

  /**
   * Compute the desired activity, coalesce it into the RPC bridge, and arm the
   * idle-clear timer. Called on every lifecycle event; the bridge drops no-ops.
   */
  refreshPresence(): void {
    if (!this.bridge || !this.tracker) return;
    const settings = this.settingsStore.get();
    const session = this.tracker.view();
    const idleSince = this.tracker.idleSince();

    let cleared = false;
    if (settings.enabled && settings.clearWhenIdle && idleSince !== null) {
      cleared = this.now() >= idleSince + this.idleClearDelayMs;
    }
    this.cleared = cleared;
    this.bridge.setDesired(desiredActivity(settings, session, cleared));
    this.scheduleIdleTimer(settings, idleSince, cleared);
  }

  private scheduleIdleTimer(settings: Settings, idleSince: number | null, cleared: boolean): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!settings.enabled || !settings.clearWhenIdle || idleSince === null || cleared) return;
    const delay = Math.max(0, idleSince + this.idleClearDelayMs - this.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.refreshPresence();
    }, delay + 25);
  }

  statusPayload(): PresenceAppStatus {
    const settings = this.settingsStore.get();
    const session = this.tracker.view();
    const copy = buildPresenceCopy(settings, session);
    const desired = desiredActivity(settings, session, this.cleared);
    const idleSince = this.tracker.idleSince();
    const clearAt = settings.enabled && settings.clearWhenIdle && idleSince !== null
      ? idleSince + this.idleClearDelayMs
      : null;
    return {
      ok: true,
      version: this.version,
      settings,
      discord: this.bridge.status(),
      opencode: this.opencode.status(),
      tracker: this.tracker.status(),
      presence: {
        visible: desired !== null,
        details: copy.details,
        state: copy.state,
        startedAt: copy.startedAt,
        largeImageKey: copy.largeImageKey,
        largeImageText: copy.largeImageText,
        project: session.projectName,
        model: session.modelName,
        tokens: session.tokens,
        cost: session.cost,
        working: session.working,
        hasSession: session.hasSession,
        reason: presenceReason(settings, session, this.cleared),
        clearAt,
      },
    };
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.opencode?.stop();
    await this.bridge?.shutdown();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.server = null;
  }
}
