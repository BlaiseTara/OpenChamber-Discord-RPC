import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DiscordBridge,
  DiscordIpcClient,
  DiscordNotConnectedError,
  encodeFrame,
  readFrames,
} from '../src/service/discord.ts';
import { MockDiscordServer } from './helpers/mock-discord.ts';
import { sleep, waitFor } from './helpers/util.ts';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const activity = {
  type: 0 as const,
  details: 'Working on MyGame',
  state: 'Coding with Qwen3.5',
  timestamps: { start: 1_700_000_000_000 },
  assets: { large_image: 'openchamber', large_text: 'OpenChamber AI Coding' },
};

test('Discord IPC frames round-trip through the stream parser', () => {
  const first = encodeFrame(0, { v: 1, client_id: '123' });
  const second = encodeFrame(1, { cmd: 'SET_ACTIVITY', nonce: 'abc' });
  const combined = Buffer.concat([first, second.subarray(0, 5)]);
  const parsed = readFrames(combined);
  assert.equal(parsed.frames.length, 1);
  assert.deepEqual(parsed.frames[0]?.data, { v: 1, client_id: '123' });
  assert.equal(parsed.rest.length, 5);

  const rest = readFrames(Buffer.concat([parsed.rest, second.subarray(5)]));
  assert.equal(rest.frames.length, 1);
  assert.equal((rest.frames[0]?.data as { nonce?: string }).nonce, 'abc');
  assert.equal(rest.rest.length, 0);
});

test('the RPC client handshakes, sets activity, and clears it', async () => {
  const mock = new MockDiscordServer();
  await mock.start();
  const client = new DiscordIpcClient({
    applicationId: '1571334059324477440',
    candidates: () => [mock.socketPath],
    logger: silentLogger,
  });
  try {
    await client.connect();
    assert.equal(client.isConnected, true);
    assert.equal(mock.connections, 1);
    await client.setActivity(activity);
    assert.deepEqual(mock.lastActivity(), activity);
    await client.setActivity(null);
    assert.equal(mock.lastActivity(), null);
  } finally {
    client.close();
    await mock.dispose();
  }
});

test('the RPC client says Discord is not running when no socket exists', async () => {
  const client = new DiscordIpcClient({
    applicationId: '1571334059324477440',
    candidates: () => ['/tmp/openchamber-discord-does-not-exist'],
    logger: silentLogger,
  });
  await assert.rejects(() => client.connect(), DiscordNotConnectedError);
});

test('the bridge coalesces the latest activity and reconnects after Discord restarts', async () => {
  const mock = new MockDiscordServer();
  await mock.start();
  const bridge = new DiscordBridge({
    applicationId: '1571334059324477440',
    logger: silentLogger,
    candidates: () => [mock.socketPath],
    minUpdateIntervalMs: 0,
  });
  try {
    bridge.start();
    await waitFor(() => bridge.status().connected, { label: 'Discord connection' });
    bridge.setDesired(activity);
    await mock.waitForActivity((value) => value?.details === 'Working on MyGame');
    bridge.setDesired({ ...activity, state: 'Coding with GPT-5.1' });
    await mock.waitForActivity((value) => value?.state === 'Coding with GPT-5.1');

    const connectionsBeforeRestart = mock.connections;
    mock.clearActivities();
    await mock.stop();
    await waitFor(() => !bridge.status().connected, { label: 'disconnect' });
    await sleep(300);
    await mock.start();
    await waitFor(() => bridge.status().connected, { label: 'reconnection', timeoutMs: 10_000 });
    await mock.waitForActivity((value) => value?.state === 'Coding with GPT-5.1', 10_000);
    assert.ok(mock.connections > connectionsBeforeRestart);
  } finally {
    await bridge.shutdown();
    await mock.dispose();
  }
});

test('disabling during reconnect backoff does not strand the bridge', async () => {
  const mock = new MockDiscordServer();
  const bridge = new DiscordBridge({
    applicationId: '1571334059324477440',
    logger: silentLogger,
    candidates: () => [mock.socketPath],
    minUpdateIntervalMs: 0,
  });
  try {
    bridge.start();
    await waitFor(() => bridge.status().mode === 'connecting' || bridge.status().mode === 'disconnected', {
      label: 'initial connection failure',
      timeoutMs: 3_000,
    });
    bridge.setEnabled(false);
    await sleep(100);
    assert.equal(bridge.status().mode, 'disabled');
    await mock.start();
    bridge.setEnabled(true);
    await waitFor(() => bridge.status().connected, { label: 're-enable', timeoutMs: 10_000 });
    bridge.setDesired(activity);
    await mock.waitForActivity((value) => value?.details === 'Working on MyGame', 10_000);
  } finally {
    await bridge.shutdown();
    await mock.dispose();
  }
});

test('the bridge waits for a Discord that is not running yet', async () => {
  const mock = new MockDiscordServer();
  const bridge = new DiscordBridge({
    applicationId: '1571334059324477440',
    logger: silentLogger,
    candidates: () => [mock.socketPath],
    minUpdateIntervalMs: 0,
  });
  try {
    bridge.start();
    bridge.setDesired(activity);
    await waitFor(() => bridge.status().mode === 'connecting' || bridge.status().mode === 'disconnected', {
      label: 'initial connection failure',
      timeoutMs: 3_000,
    });
    await mock.start();
    await waitFor(() => bridge.status().connected, { label: 'late Discord start', timeoutMs: 10_000 });
    await mock.waitForActivity((value) => value?.details === 'Working on MyGame', 10_000);
  } finally {
    await bridge.shutdown();
    await mock.dispose();
  }
});
