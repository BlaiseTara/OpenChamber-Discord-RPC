import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { activityKey, type DiscordActivity } from '../shared.ts';

export type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
const MAX_FRAME_BYTES = 1024 * 1024;
const SOCKET_CONNECT_TIMEOUT_MS = 1_500;
const HANDSHAKE_TIMEOUT_MS = 8_000;
const ACTIVITY_TIMEOUT_MS = 10_000;
/** Discord allows five presence updates per 20 seconds; stay comfortably inside that. */
const MIN_UPDATE_INTERVAL_MS = 4_200;
const MAX_RECONNECT_DELAY_MS = 30_000;

type DiscordFrame = { op: number; data: unknown };

export const encodeFrame = (op: number, data: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error('Discord frame is too large.');
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

/** Pull every complete frame out of a stream buffer. */
export const readFrames = (buffer: Buffer<ArrayBufferLike>): { frames: DiscordFrame[]; rest: Buffer<ArrayBufferLike> } => {
  const frames: DiscordFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const op = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    if (length > MAX_FRAME_BYTES) throw new Error('Discord sent an oversized frame.');
    if (buffer.length - offset - 8 < length) break;
    const body = buffer.subarray(offset + 8, offset + 8 + length).toString('utf8');
    offset += 8 + length;
    let data: unknown;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      throw new Error('Discord sent a frame that is not JSON.');
    }
    frames.push({ op, data });
  }
  return { frames, rest: offset > 0 ? buffer.subarray(offset) : buffer };
};

export class DiscordRpcError extends Error {
  readonly code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.name = 'DiscordRpcError';
    this.code = code;
  }
}

export class DiscordNotConnectedError extends Error {
  constructor(message = 'Discord is not connected.') {
    super(message);
    this.name = 'DiscordNotConnectedError';
  }
}

export type DiscordIpcPaths = { paths: string[]; fromOverride: boolean };

const pushUnique = (list: string[], value: string | undefined | null) => {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
};

/**
 * Discord's IPC endpoint differs by platform and packaging. The service dials the
 * socket directly (through the host-approved socket capability); this list covers
 * the official client, Canary, Flatpak, Snap, Vesktop and the common temp locations.
 */
export const discoverDiscordIpcPaths = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined,
): DiscordIpcPaths => {
  const paths: string[] = [];
  const override = env.DISCORD_IPC_PATH?.trim();
  if (override) pushUnique(paths, override);

  // The host resolves declared socket bindings and passes them here. The manifest
  // cannot know XDG_RUNTIME_DIR or the user's uid, so this is the authoritative one.
  const sockets = env.OPENCHAMBER_SERVICE_SOCKETS;
  if (sockets) {
    try {
      const parsed: unknown = JSON.parse(sockets);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') pushUnique(paths, value);
        }
      }
    } catch {
      // A malformed env var is not fatal; discovery below still works.
    }
  }

  if (platform === 'win32') {
    for (let index = 0; index < 10; index += 1) {
      pushUnique(paths, `\\\\.\\pipe\\discord-ipc-${index}`);
    }
    return { paths, fromOverride: Boolean(override) };
  }

  const dirs: string[] = [];
  if (env.XDG_RUNTIME_DIR) dirs.push(env.XDG_RUNTIME_DIR);
  if (platform === 'linux' && uid !== undefined) dirs.push(`/run/user/${uid}`);
  if (env.TMPDIR) dirs.push(env.TMPDIR);
  if (platform === 'darwin' && env.HOME) dirs.push(path.join(env.HOME, 'Library', 'Application Support', 'discord'));
  dirs.push('/tmp');
  if (platform === 'darwin') dirs.push(os.tmpdir());

  if (env.XDG_RUNTIME_DIR) {
    dirs.push(path.join(env.XDG_RUNTIME_DIR, 'app', 'com.discordapp.Discord'));
    dirs.push(path.join(env.XDG_RUNTIME_DIR, 'snap.discord'));
    dirs.push(path.join(env.XDG_RUNTIME_DIR, 'vesktop'));
  }

  const seenDirs = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (let index = 0; index < 10; index += 1) {
      pushUnique(paths, path.join(dir, `discord-ipc-${index}`));
    }
  }
  return { paths, fromOverride: Boolean(override) };
};

const existingPaths = (paths: string[], fromOverride: boolean): string[] => {
  if (process.platform === 'win32') return paths;
  // A stale socket file may still be present, so an existing path is only a hint.
  const existing = paths.filter((candidate) => {
    try {
      fs.statSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (existing.length > 0) return existing;
  return fromOverride ? paths : [];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type DiscordIpcOptions = {
  applicationId: string;
  candidates?: () => string[];
  logger?: Logger;
};

/**
 * A deliberately small Discord RPC client. It speaks the documented local IPC
 * framing (8-byte little-endian header + JSON) and does not need a gateway
 * library, a background daemon, or a network connection.
 */
export class DiscordIpcClient {
  private readonly applicationId: string;
  private readonly candidates: () => string[];
  private readonly logger: Logger;
  private socket: net.Socket | null = null;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private connected = false;
  private closing = false;
  private closeNotified = false;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private closeCallback: (error: Error | null) => void = () => {};
  socketPath: string | null = null;

  constructor(options: DiscordIpcOptions) {
    this.applicationId = options.applicationId;
    this.candidates = options.candidates ?? (() => discoverDiscordIpcPaths().paths);
    this.logger = options.logger ?? silentLogger;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onClose(callback: (error: Error | null) => void): void {
    this.closeCallback = callback;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.closing = false;
    const discovered = discoverDiscordIpcPaths();
    const paths = existingPaths(this.candidates(), discovered.fromOverride);
    if (paths.length === 0) {
      throw new DiscordNotConnectedError('Discord is not running (no IPC socket found).');
    }

    let lastError: Error | null = null;
    for (const candidate of paths) {
      try {
        await this.connectTo(candidate);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (this.connected) return;
        this.destroySocket(null, false);
      }
    }
    throw lastError ?? new DiscordNotConnectedError('Discord is not running.');
  }

  private async connectTo(socketPath: string): Promise<void> {
    const socket = net.createConnection(socketPath);
    this.socket = socket;
    this.socketPath = socketPath;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.closeNotified = false;

    const ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new DiscordNotConnectedError('Discord did not accept the IPC connection.'));
      }, SOCKET_CONNECT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });

    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', (error) => this.handleSocketError(error));
    socket.on('close', () => this.handleSocketClose(null));
    socket.setNoDelay(true);
    socket.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.applicationId }));

    this.readyTimer = setTimeout(() => {
      this.rejectReady?.(new DiscordNotConnectedError('Discord did not answer the RPC handshake.'));
    }, HANDSHAKE_TIMEOUT_MS);

    try {
      await ready;
      this.connected = true;
      this.logger.info('Connected to the Discord client.');
    } catch (error) {
      this.connected = false;
      throw error;
    } finally {
      this.clearReady();
    }
  }

  private clearReady(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let parsed: ReturnType<typeof readFrames>;
    try {
      parsed = readFrames(this.buffer);
    } catch (error) {
      this.logger.warn('Discord IPC framing error:', error);
      this.destroySocket(new DiscordRpcError('Discord sent unreadable data.'));
      return;
    }
    this.buffer = parsed.rest;
    for (const frame of parsed.frames) this.handleFrame(frame);
  }

  private handleFrame(frame: DiscordFrame): void {
    if (frame.op === OP_PING) {
      this.tryWrite(encodeFrame(OP_PONG, frame.data));
      return;
    }
    if (frame.op === OP_CLOSE) {
      const data = frame.data && typeof frame.data === 'object' ? (frame.data as Record<string, unknown>) : {};
      const code = typeof data.code === 'number' ? data.code : 0;
      const message = typeof data.message === 'string' ? data.message : 'Discord closed the IPC connection.';
      this.destroySocket(new DiscordRpcError(message, code));
      return;
    }
    if (frame.op !== OP_FRAME) return;

    const payload = frame.data && typeof frame.data === 'object' ? (frame.data as Record<string, unknown>) : {};
    if (payload.evt === 'READY') {
      this.resolveReady?.();
      return;
    }
    if (payload.evt === 'ERROR') {
      const nonce = typeof payload.nonce === 'string' ? payload.nonce : null;
      const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
      const code = typeof data.code === 'number' ? data.code : 0;
      const message = typeof data.message === 'string' ? data.message : 'Discord rejected the RPC command.';
      if (nonce) {
        this.rejectPending(nonce, new DiscordRpcError(message, code));
      } else {
        this.logger.warn('Discord RPC error:', message);
      }
      return;
    }

    const nonce = typeof payload.nonce === 'string' ? payload.nonce : null;
    if (!nonce) return;
    const entry = this.pending.get(nonce);
    if (!entry) return;
    this.pending.delete(nonce);
    clearTimeout(entry.timer);
    entry.resolve();
  }

  private handleSocketError(error: Error): void {
    if (!this.connected) {
      this.rejectReady?.(error);
      return;
    }
    this.logger.warn('Discord IPC socket error:', error.message);
  }

  private handleSocketClose(error: Error | null): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.rejectReady?.(error ?? new DiscordNotConnectedError('Discord closed the IPC connection.'));
    this.clearReady();
    this.rejectAllPending(error ?? new DiscordNotConnectedError('Discord closed the IPC connection.'));
    if ((wasConnected || this.closeNotified) && this.closing) return;
    if (wasConnected) this.notifyClose(error);
    this.closeNotified = false;
  }

  private notifyClose(error: Error | null): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closeCallback(error);
  }

  private tryWrite(frame: Buffer): boolean {
    try {
      this.socket?.write(frame);
      return Boolean(this.socket);
    } catch (error) {
      this.logger.warn('Could not write to the Discord IPC socket:', error);
      return false;
    }
  }

  async setActivity(activity: DiscordActivity | null): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new DiscordNotConnectedError();
    }
    const nonce = randomUUID();
    const payload = {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity,
      },
      nonce,
    };
    const response = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new DiscordRpcError('Discord did not answer SET_ACTIVITY.'));
      }, ACTIVITY_TIMEOUT_MS);
      this.pending.set(nonce, { resolve, reject, timer });
    });
    try {
      this.socket.write(encodeFrame(OP_FRAME, payload));
    } catch (error) {
      this.rejectPending(nonce, error instanceof Error ? error : new Error(String(error)));
    }
    await response;
  }

  private rejectPending(nonce: string, error: Error): void {
    const entry = this.pending.get(nonce);
    if (!entry) return;
    this.pending.delete(nonce);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const [nonce, entry] of this.pending) {
      this.pending.delete(nonce);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private destroySocket(error: Error | null = null, notify = true): void {
    const socket = this.socket;
    const wasConnected = this.connected;
    this.socket = null;
    this.connected = false;
    this.rejectReady?.(error ?? new DiscordNotConnectedError('Discord connection was closed.'));
    this.clearReady();
    if (socket) {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    }
    this.rejectAllPending(error ?? new DiscordNotConnectedError('Discord connection was closed.'));
    if (notify && wasConnected && !this.closing) this.notifyClose(error);
  }

  close(error: Error | null = null): void {
    const wasConnected = this.connected;
    this.closing = true;
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    this.rejectReady?.(error ?? new DiscordNotConnectedError('Discord connection was closed.'));
    this.clearReady();
    this.rejectAllPending(error ?? new DiscordNotConnectedError('Discord connection was closed.'));
    if (socket) {
      try {
        socket.end();
        socket.destroy();
      } catch {
        // already gone
      }
    }
    if (wasConnected) this.notifyClose(error);
  }
}

export type BridgeMode = 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'stopped';

export type DiscordBridgeStatus = {
  mode: BridgeMode;
  enabled: boolean;
  connected: boolean;
  applicationId: string;
  socketPath: string | null;
  lastError: string | null;
  warning: string | null;
  lastSentAt: number | null;
  reconnectAttempt: number;
};

export type DiscordBridgeOptions = {
  applicationId: string;
  enabled?: boolean;
  logger?: Logger;
  candidates?: () => string[];
  minUpdateIntervalMs?: number;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const code = error instanceof DiscordRpcError && error.code ? ` (code ${error.code})` : '';
    return `${error.message}${code}`;
  }
  return String(error);
};

/**
 * Keeps one RPC connection alive, coalesces presence updates, and reconnects
 * forever with backoff. A missing Discord client is a normal state, not an error
 * that stops the service.
 */
export class DiscordBridge {
  private applicationId: string;
  private readonly logger: Logger;
  private readonly candidates: () => string[];
  private readonly minUpdateIntervalMs: number;
  private client: DiscordIpcClient | null = null;
  private enabled: boolean;
  private stopped = false;
  private mode: BridgeMode = 'stopped';
  private socketPath: string | null = null;
  private lastError: string | null = null;
  private warning: string | null = null;
  private lastSentKey = '';
  private lastSentAt: number | null = null;
  private desired: DiscordActivity | null = null;
  private rejectedAssetKey: string | null = null;
  private sending = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectResolve: (() => void) | null = null;
  private reconnectAttempt = 0;
  private lastLoggedError: string | null = null;
  private loopRunning = false;
  private loopToken = 0;
  private pendingStart = false;

  constructor(options: DiscordBridgeOptions) {
    this.applicationId = options.applicationId;
    this.logger = options.logger ?? silentLogger;
    this.candidates = options.candidates ?? (() => discoverDiscordIpcPaths().paths);
    this.minUpdateIntervalMs = options.minUpdateIntervalMs ?? MIN_UPDATE_INTERVAL_MS;
    this.enabled = options.enabled ?? true;
  }

  start(): void {
    if (this.stopped) return;
    if (!this.enabled) {
      this.setMode('disabled');
      return;
    }
    if (this.loopRunning) {
      this.pendingStart = true;
      return;
    }
    void this.runLoop(++this.loopToken);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.loopToken += 1;
    this.clearReconnect();
    this.client?.close();
    this.client = null;
    this.lastSentKey = '';
    this.lastSentAt = null;
    if (!enabled) {
      this.setMode('disabled');
      return;
    }
    this.reconnectAttempt = 0;
    this.setMode('disconnected');
    this.start();
  }

  setApplicationId(applicationId: string): void {
    if (this.applicationId === applicationId) return;
    this.applicationId = applicationId;
    this.restart('The Discord application changed.');
  }

  setDesired(activity: DiscordActivity | null): void {
    const nextKey = activityKey(activity);
    const previousKey = activityKey(this.desired);
    this.desired = activity;
    if (nextKey !== previousKey) {
      if (activity?.assets?.large_image !== this.rejectedAssetKey) this.rejectedAssetKey = null;
    }
    this.scheduleFlush();
  }

  restart(reason = 'The Discord connection was restarted.'): void {
    this.logger.info(reason);
    this.loopToken += 1;
    this.clearReconnect();
    this.client?.close();
    this.client = null;
    this.lastSentKey = '';
    this.lastSentAt = null;
    this.rejectedAssetKey = null;
    this.reconnectAttempt = 0;
    if (this.enabled && !this.stopped) {
      this.setMode('disconnected');
      this.start();
    }
  }

  private setMode(mode: BridgeMode): void {
    this.mode = mode;
  }

  status(): DiscordBridgeStatus {
    return {
      mode: this.mode,
      enabled: this.enabled,
      connected: this.mode === 'connected',
      applicationId: this.applicationId,
      socketPath: this.socketPath,
      lastError: this.lastError,
      warning: this.warning,
      lastSentAt: this.lastSentAt,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  private async runLoop(token: number): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      while (!this.stopped && this.enabled && token === this.loopToken) {
        this.setMode('connecting');
        const client = new DiscordIpcClient({
          applicationId: this.applicationId,
          candidates: this.candidates,
          logger: this.logger,
        });
        this.client = client;
        let resolveDisconnected: () => void = () => {};
        const disconnected = new Promise<void>((resolve) => {
          resolveDisconnected = resolve;
        });
        client.onClose((error) => {
          if (this.client === client) {
            this.client = null;
            this.socketPath = null;
            this.lastSentKey = '';
            this.lastSentAt = null;
            this.rejectedAssetKey = null;
            this.setMode(this.enabled ? 'disconnected' : 'disabled');
            if (error) this.recordError(errorMessage(error));
            resolveDisconnected();
          }
        });

        try {
          await client.connect();
          if (this.stopped || !this.enabled || token !== this.loopToken) {
            client.close();
            break;
          }
          this.socketPath = client.socketPath;
          this.mode = 'connected';
          this.reconnectAttempt = 0;
          this.lastError = null;
          this.logger.info('Discord Rich Presence is ready.');
          this.lastSentKey = '';
          this.lastSentAt = null;
          void this.flush(true);
          await disconnected;
          if (this.stopped || !this.enabled || token !== this.loopToken) break;
          await this.waitBeforeReconnect();
        } catch (error) {
          if (this.stopped || !this.enabled || token !== this.loopToken) {
            client.close();
            break;
          }
          this.recordError(errorMessage(error));
          client.close();
          this.setMode('disconnected');
          await this.waitBeforeReconnect();
        } finally {
          if (this.client === client) this.client = null;
        }
      }
    } finally {
      this.loopRunning = false;
      if (!this.stopped && this.enabled && (this.pendingStart || token !== this.loopToken)) {
        this.pendingStart = false;
        this.start();
      }
    }
  }

  private recordError(message: string): void {
    this.lastError = message;
    if (message !== this.lastLoggedError) {
      this.lastLoggedError = message;
      this.logger.warn(`Discord is unavailable: ${message}`);
    }
  }

  private async waitBeforeReconnect(): Promise<void> {
    if (this.stopped || !this.enabled) return;
    this.reconnectAttempt += 1;
    const exponent = Math.min(this.reconnectAttempt - 1, 5);
    const base = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** exponent);
    const delay = base + Math.floor(Math.random() * 500);
    await new Promise<void>((resolve) => {
      this.reconnectResolve = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectResolve = null;
        resolve();
      }, delay);
    });
  }

  /** Wake a backoff wait so a disable, restart or shutdown is not stuck behind it. */
  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const resolve = this.reconnectResolve;
    this.reconnectResolve = null;
    resolve?.();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush(false);
    }, 0);
  }

  private clearFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flush(force: boolean): Promise<void> {
    if (this.stopped || !this.enabled || this.mode !== 'connected' || this.sending) return;
    const client = this.client;
    if (!client) return;

    const requested = this.desired;
    let toSend = requested;
    if (requested?.assets && this.rejectedAssetKey === requested.assets.large_image) {
      toSend = { ...requested };
      delete toSend.assets;
    }
    const key = activityKey(toSend);
    if (!force && key === this.lastSentKey) return;

    if (!force && this.lastSentAt !== null) {
      const wait = this.lastSentAt + this.minUpdateIntervalMs - Date.now();
      if (wait > 0) {
        this.clearFlush();
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush(false);
        }, wait);
        return;
      }
    }

    this.sending = true;
    try {
      await client.setActivity(toSend);
      this.lastSentKey = key;
      this.lastSentAt = Date.now();
      if (toSend?.assets) this.warning = null;
      this.lastError = null;
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof DiscordNotConnectedError) {
        // The reconnect loop owns this state; do not retry on a dead socket.
        this.lastSentKey = '';
        this.lastSentAt = null;
      } else if (
        requested?.assets &&
        this.rejectedAssetKey !== requested.assets.large_image &&
        (error instanceof DiscordRpcError ? error.code === 4000 || /asset|image/i.test(error.message) : /asset|image/i.test(message))
      ) {
        // A missing or unapproved large-image key should not hide the presence.
        this.rejectedAssetKey = requested.assets.large_image;
        this.warning = `Discord rejected the "${requested.assets.large_image}" image asset. Upload it in the Discord Developer Portal under Rich Presence → Art Assets.`;
        this.sending = false;
        this.scheduleFlush();
        return;
      } else {
        this.recordError(message);
        this.lastSentKey = '';
        this.lastSentAt = null;
        this.clearFlush();
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush(true);
        }, 15_000);
      }
    } finally {
      this.sending = false;
    }

    // If the desired state changed while the request was in flight, send it now.
    if (activityKey(this.desired) !== this.lastSentKey) this.scheduleFlush();
  }

  /** Best-effort clear before the host stops the service. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    this.loopToken += 1;
    this.clearFlush();
    this.clearReconnect();
    const client = this.client;
    this.client = null;
    if (client?.isConnected) {
      try {
        await Promise.race([client.setActivity(null), sleep(1_000)]);
      } catch {
        // The process is going away; a failed clear is harmless.
      }
    }
    client?.close();
    this.mode = 'stopped';
  }
}
