import { mkdir, rm, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { encodeFrame, readFrames } from '../../src/service/discord.ts';
import type { DiscordActivity as SharedActivity } from '../../src/shared.ts';

type MockMessage = {
  cmd?: string;
  nonce?: string;
  args?: { activity?: SharedActivity | null };
};

export class MockDiscordServer {
  readonly dir = path.join(os.tmpdir(), `oc-discord-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  readonly socketPath = path.join(this.dir, 'discord-ipc-0');
  readonly activities: (SharedActivity | null)[] = [];
  connections = 0;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  async start(): Promise<void> {
    await unlink(this.socketPath).catch(() => undefined);
    await mkdir(this.dir, { recursive: true });
    const server = net.createServer((socket) => this.handle(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  private handle(socket: net.Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed: ReturnType<typeof readFrames>;
      try {
        parsed = readFrames(buffer);
      } catch {
        socket.destroy();
        return;
      }
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.op === 0) {
          socket.write(encodeFrame(1, {
            v: 1,
            evt: 'READY',
            data: { v: 1, config: { cdn_host: 'cdn.discordapp.com' }, user: { username: 'tester' } },
          }));
          continue;
        }
        if (frame.op !== 1 || !frame.data || typeof frame.data !== 'object') continue;
        const message = frame.data as MockMessage;
        if (message.cmd !== 'SET_ACTIVITY') continue;
        const activity = message.args?.activity ?? null;
        this.activities.push(activity);
        socket.write(encodeFrame(1, {
          cmd: 'SET_ACTIVITY',
          evt: null,
          data: null,
          nonce: message.nonce,
        }));
      }
    });
    socket.on('error', () => {
      this.sockets.delete(socket);
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
    });
  }

  activityCount(): number {
    return this.activities.length;
  }

  lastActivity(): SharedActivity | null | undefined {
    return this.activities[this.activities.length - 1];
  }

  clearActivities(): void {
    this.activities.length = 0;
  }

  async waitForActivity(
    predicate: (activity: SharedActivity | null) => boolean,
    timeoutMs = 5_000,
  ): Promise<SharedActivity | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const last = this.lastActivity();
      if (last !== undefined && predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for Discord activity.');
  }

  disconnectClients(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async stop(): Promise<void> {
    this.disconnectClients();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
    await unlink(this.socketPath).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.stop();
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

