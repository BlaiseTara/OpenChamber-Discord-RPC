import { PresenceApp } from './app.ts';

const logger = {
  info: (...args: unknown[]) => console.log('[discord-rpc]', ...args),
  warn: (...args: unknown[]) => console.warn('[discord-rpc]', ...args),
  error: (...args: unknown[]) => console.error('[discord-rpc]', ...args),
};

const app = new PresenceApp({ logger });
let shuttingDown = false;

const shutdown = async (reason: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Stopping (${reason}).`);
  const watchdog = setTimeout(() => process.exit(0), 3_500);
  watchdog.unref();
  try {
    await app.stop();
  } catch (error) {
    logger.warn('Shutdown was not clean:', error instanceof Error ? error.message : error);
  }
  clearTimeout(watchdog);
  process.exit(0);
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

// A broken Discord client or OpenCode request must never take OpenChamber down.
// The service is a host-spawned child process; it logs and lets the host restart it.
process.on('unhandledRejection', (reason) => {
  logger.warn('Unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in the Discord presence service:', error);
  void shutdown('uncaught exception');
});

app.start().catch((error: unknown) => {
  logger.error('Could not start the Discord presence service:', error instanceof Error ? error.message : error);
  process.exit(1);
});
