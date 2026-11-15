#!/usr/bin/env node
/**
 * Runs the built service without OpenChamber, for checking the Discord connection.
 * It still requires the bearer token the host normally injects, so nothing on the
 * machine can drive it accidentally.
 *
 *   node scripts/dev-service.mjs
 *   DISCORD_IPC_PATH=/run/user/1000/discord-ipc-0 node scripts/dev-service.mjs
 *
 * The settings file lives in OPENCHAMBER_DISCORD_DATA_DIR (default:
 * /tmp/opencode/discord-rpc-dev), so development never touches the installed copy.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OPENCHAMBER_SERVICE_PORT ??= '47123';
process.env.OPENCHAMBER_SERVICE_TOKEN ??= 'dev-token';
process.env.OPENCHAMBER_DISCORD_DATA_DIR ??= await mkdtemp(path.join(tmpdir(), 'openchamber-discord-rpc-'));

console.log('[discord-rpc] dev service:');
console.log(`  port:     ${process.env.OPENCHAMBER_SERVICE_PORT}`);
console.log(`  token:    ${process.env.OPENCHAMBER_SERVICE_TOKEN}`);
console.log(`  data dir: ${process.env.OPENCHAMBER_DISCORD_DATA_DIR}`);
if (process.env.DISCORD_IPC_PATH) console.log(`  socket:   ${process.env.DISCORD_IPC_PATH}`);
if (!process.env.OPENCHAMBER_OPENCODE_URL) console.log('  OpenCode: not configured (fallback presence only)');

await import('../service/main.js');
