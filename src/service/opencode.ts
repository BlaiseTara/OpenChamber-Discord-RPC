import type { ModelRef } from '../shared.ts';

export type OpenCodeLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const silentLogger: OpenCodeLogger = { info: () => {}, warn: () => {}, error: () => {} };

export type OpenCodeTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type OpenCodeSessionInfo = {
  id: string;
  parentID: string | null;
  directory: string | null;
  model: ModelRef | null;
  tokens: OpenCodeTokenUsage | null;
  cost: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  viewedAt: number | null;
  archivedAt: number | null;
  busyAt: number | null;
  idleAt: number | null;
  working: boolean;
};

export type OpenCodeStatus = {
  available: boolean;
  connected: boolean;
  lastEventAt: number | null;
  lastError: string | null;
};

export type OpenCodeWireEvent = {
  id?: string;
  created?: number;
  type?: string;
  data?: Record<string, unknown>;
  location?: { directory?: string };
};

type EventsClientOptions = {
  baseUrl: string | null;
  token: string | null;
  logger?: OpenCodeLogger;
  types: string[];
  onEvent: (event: OpenCodeWireEvent) => void;
  onConnected?: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const modelFrom = (value: unknown): ModelRef | null => {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  if (!id) return null;
  return {
    id,
    ...(stringOrNull(value.providerID) ? { providerID: stringOrNull(value.providerID) as string } : {}),
    ...(stringOrNull(value.variant) ? { variant: stringOrNull(value.variant) as string } : {}),
  };
};

export const tokenUsageFrom = (value: unknown): OpenCodeTokenUsage | null => {
  if (!isRecord(value)) return null;
  const cache = isRecord(value.cache) ? value.cache : {};
  const usage: OpenCodeTokenUsage = {
    input: numberOrNull(value.input) ?? 0,
    output: numberOrNull(value.output) ?? 0,
    reasoning: numberOrNull(value.reasoning) ?? 0,
    cache: {
      read: numberOrNull(cache.read) ?? 0,
      write: numberOrNull(cache.write) ?? 0,
    },
  };
  return usage;
};

export const sessionInfoFrom = (value: unknown, working = false): OpenCodeSessionInfo | null => {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  if (!id) return null;
  const time = isRecord(value.time) ? value.time : {};
  const location = isRecord(value.location) ? value.location : {};
  return {
    id,
    parentID: stringOrNull(value.parentID),
    directory: stringOrNull(location.directory),
    model: modelFrom(value.model),
    tokens: tokenUsageFrom(value.tokens),
    cost: numberOrNull(value.cost),
    createdAt: numberOrNull(time.created),
    updatedAt: numberOrNull(time.updated),
    viewedAt: numberOrNull(time.viewed),
    archivedAt: numberOrNull(time.archived),
    busyAt: numberOrNull(time.busy),
    idleAt: numberOrNull(time.idle),
    working,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

/**
 * Reads only session metadata and the live event stream. It never requests
 * messages, so prompts, replies, tool input and file contents cannot reach the
 * extension or Discord.
 */
export class OpenCodeEventsClient {
  private readonly baseUrl: string | null;
  private readonly token: string | null;
  private readonly logger: OpenCodeLogger;
  private readonly types: string[];
  private readonly onEvent: (event: OpenCodeWireEvent) => void;
  private readonly onConnected: (() => void) | undefined;
  private stopped = false;
  private loopRunning = false;
  private connected = false;
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private lastLoggedError: string | null = null;
  private attempt = 0;
  private abort: AbortController | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private loopToken = 0;

  constructor(options: EventsClientOptions) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : null;
    this.token = options.token;
    this.logger = options.logger ?? silentLogger;
    this.types = options.types;
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
  }

  get available(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  status(): OpenCodeStatus {
    return {
      available: this.available,
      connected: this.connected,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }

  start(): void {
    if (this.stopped || this.loopRunning || !this.available) {
      if (!this.available) this.logger.warn('OpenCode access is unavailable; presence will use fallback text.');
      return;
    }
    void this.runLoop(++this.loopToken);
  }

  stop(): void {
    this.stopped = true;
    this.loopToken += 1;
    this.clearRetry();
    this.stopWatchdog();
    this.abort?.abort();
    this.abort = null;
    this.connected = false;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token ?? ''}`,
      Accept: 'application/json, text/event-stream',
    };
  }

  private url(pathname: string): string {
    if (!this.baseUrl) throw new Error('OpenCode is not available.');
    return `${this.baseUrl}${pathname}`;
  }

  /** Every request is a read on the OpenCode routes the host explicitly allows. */
  async requestJson(pathname: string): Promise<unknown> {
    if (!this.baseUrl || !this.token) return null;
    try {
      const response = await fetch(this.url(pathname), {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(12_000),
        cache: 'no-store',
      });
      if (!response.ok) {
        this.lastError = `OpenCode answered HTTP ${response.status}.`;
        return null;
      }
      const body: unknown = await response.json();
      if (isRecord(body) && 'data' in body) return body.data;
      return body;
    } catch (error) {
      this.lastError = errorMessage(error);
      return null;
    }
  }

  async listSessions(limit = 50): Promise<OpenCodeSessionInfo[]> {
    const data = await this.requestJson(`/api/session?limit=${limit}&archived=false`);
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => sessionInfoFrom(entry))
      .filter((entry): entry is OpenCodeSessionInfo => entry !== null);
  }

  async getSession(sessionId: string): Promise<OpenCodeSessionInfo | null> {
    if (!/^ses_[\w-]+$/.test(sessionId)) return null;
    const data = await this.requestJson(`/api/session/${encodeURIComponent(sessionId)}`);
    return sessionInfoFrom(data);
  }

  async activeSessions(): Promise<Set<string>> {
    const data = await this.requestJson('/api/session/active');
    const active = new Set<string>();
    if (isRecord(data)) {
      for (const [sessionId, value] of Object.entries(data)) {
        if (isRecord(value) && value.type === 'running') active.add(sessionId);
      }
    }
    return active;
  }

  private async runLoop(token: number): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      while (!this.stopped && token === this.loopToken) {
        try {
          await this.connectStream(token);
        } catch (error) {
          if (this.stopped || token !== this.loopToken) break;
          const message = errorMessage(error);
          this.lastError = message;
          if (message !== this.lastLoggedError) {
            this.lastLoggedError = message;
            this.logger.warn(`OpenCode events are unavailable: ${message}`);
          }
        } finally {
          this.connected = false;
          this.stopWatchdog();
          this.abort = null;
        }
        if (this.stopped || token !== this.loopToken) break;
        this.attempt += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt - 1, 5));
        await new Promise<void>((resolve) => {
          this.retryTimer = setTimeout(resolve, delay);
        });
        this.retryTimer = null;
      }
    } finally {
      this.loopRunning = false;
    }
  }

  private async connectStream(token: number): Promise<void> {
    const params = new URLSearchParams();
    for (const type of this.types) params.append('types', type);
    const url = `${this.url('/api/event')}?${params.toString()}`;
    const abort = new AbortController();
    this.abort = abort;
    this.lastActivityAt = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivityAt > 75_000) {
        abort.abort(new Error('OpenCode event stream went quiet.'));
      }
    }, 15_000);

    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
      signal: abort.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`OpenCode answered HTTP ${response.status}.`);
    }
    if (!response.body) throw new Error('OpenCode sent no event stream.');

    this.connected = true;
    this.attempt = 0;
    this.lastError = null;
    this.logger.info('Listening for OpenCode session events.');
    this.onConnected?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!this.stopped && token === this.loopToken) {
        const next = await reader.read();
        if (next.done) break;
        this.lastActivityAt = Date.now();
        buffer += decoder.decode(next.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) this.handlePayload(data);
          boundary = buffer.indexOf('\n\n');
        }
        if (buffer.length > 4 * 1024 * 1024) {
          // A server that never terminates a block is not something to buffer forever.
          buffer = buffer.slice(-1024 * 1024);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // stream already gone
      }
    }
  }

  private handlePayload(data: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    const event: OpenCodeWireEvent = {
      ...(stringOrNull(payload.id) ? { id: stringOrNull(payload.id) as string } : {}),
      ...(numberOrNull(payload.created) !== null ? { created: numberOrNull(payload.created) as number } : {}),
      ...(stringOrNull(payload.type) ? { type: stringOrNull(payload.type) as string } : {}),
      ...(isRecord(payload.data) ? { data: payload.data } : {}),
      ...(isRecord(payload.location) ? { location: payload.location as { directory?: string } } : {}),
    };
    this.lastEventAt = Date.now();
    try {
      this.onEvent(event);
    } catch (error) {
      this.logger.warn('A session event handler failed:', errorMessage(error));
    }
  }
}

export { sleep };
