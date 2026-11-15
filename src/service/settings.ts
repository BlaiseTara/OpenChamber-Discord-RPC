import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  SETTINGS_VERSION,
  storedSettings,
  type Settings,
  type StoredSettings,
} from '../shared.ts';
import type { Logger } from './discord.ts';

const FIELDS = [
  'enabled',
  'customActivity',
  'showProject',
  'showModel',
  'showElapsed',
  'showTokens',
  'showCost',
  'fallbackText',
  'clearWhenIdle',
] as const satisfies readonly (keyof Settings)[];

const BOOLEAN_FIELDS = new Set<keyof Settings>([
  'enabled',
  'showProject',
  'showModel',
  'showElapsed',
  'showTokens',
  'showCost',
  'clearWhenIdle',
]);

const STRING_LIMITS: Partial<Record<keyof Settings, number>> = {
  customActivity: 128,
  fallbackText: 128,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type SettingsMerge =
  | { ok: true; settings: Settings }
  | { ok: false; error: string };

/**
 * Validate a settings patch without silently replacing a bad value with a
 * default. The panel sends whole values, so the response can name the field.
 */
export const mergeSettings = (current: Settings, patch: unknown): SettingsMerge => {
  if (!isRecord(patch)) return { ok: false, error: 'Settings must be a JSON object.' };
  const next: Record<string, unknown> = { ...current };
  for (const field of FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (BOOLEAN_FIELDS.has(field)) {
      if (typeof value !== 'boolean') return { ok: false, error: `${field} must be true or false.` };
      next[field] = value;
      continue;
    }
    if (typeof value !== 'string') return { ok: false, error: `${field} must be text.` };
    const limit = STRING_LIMITS[field] ?? 128;
    if (value.length > limit) return { ok: false, error: `${field} is longer than ${limit} characters.` };
    next[field] = value;
  }
  return { ok: true, settings: sanitizeSettings(next) };
};

export class SettingsStore {
  readonly filePath: string;
  private readonly logger: Logger;
  private current: Settings = { ...DEFAULT_SETTINGS };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, logger: Logger) {
    this.filePath = path.join(dataDir, 'settings.json');
    this.logger = logger;
  }

  get(): Settings {
    return { ...this.current };
  }

  async load(): Promise<Settings> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const source = isRecord(parsed) && isRecord(parsed.settings) ? parsed.settings : parsed;
      this.current = sanitizeSettings(source);
      if (isRecord(parsed) && typeof parsed.version === 'number' && parsed.version !== SETTINGS_VERSION) {
        this.logger.info(`Settings file has version ${parsed.version}; using known fields.`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn('Could not read settings; using defaults:', error instanceof Error ? error.message : error);
      }
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.get();
  }

  /**
   * Atomic write. Concurrent saves serialize, and a failed write leaves the
   * previous file untouched.
   */
  async save(settings: Settings): Promise<void> {
    const next = sanitizeSettings(settings);
    const payload = `${JSON.stringify(storedSettings(next), null, 2)}\n`;
    const write = async () => {
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      this.current = next;
    };
    // A failed write must not poison later saves: run the next one either way.
    this.writeChain = this.writeChain.then(write, write);
    await this.writeChain;
  }

  /** The host gives the service a directory of its own; a manual run may not. */
  static defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.OPENCHAMBER_SERVICE_DATA_DIR) return env.OPENCHAMBER_SERVICE_DATA_DIR;
    if (env.OPENCHAMBER_DISCORD_DATA_DIR) return env.OPENCHAMBER_DISCORD_DATA_DIR;
    const home = env.HOME || env.USERPROFILE || process.cwd();
    return path.join(home, '.config', 'openchamber-discord-rpc');
  }
}

export type { StoredSettings };
