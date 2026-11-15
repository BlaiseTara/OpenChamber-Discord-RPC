/**
 * Pure helpers shared by the extension service and its settings panel.
 * Nothing here imports Node or touches the network, so both bundles can use it
 * and the tests can exercise it directly.
 */

export const DEFAULT_APPLICATION_ID = '1571334059324477440';
export const DEFAULT_LARGE_IMAGE_KEY = 'openchamber';
export const DEFAULT_LARGE_IMAGE_TEXT = 'OpenChamber AI Coding';
export const IDLE_CLEAR_DELAY_MS = 45_000;
export const ACTIVITY_MAX = 128;
export const SETTINGS_VERSION = 4;

export type Settings = {
  enabled: boolean;
  customActivity: string;
  showProject: boolean;
  showModel: boolean;
  showElapsed: boolean;
  showTokens: boolean;
  showCost: boolean;
  fallbackText: string;
  clearWhenIdle: boolean;
};

export type StoredSettings = Settings & { version: number };

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  customActivity: '',
  showProject: true,
  showModel: true,
  showElapsed: true,
  showTokens: true,
  showCost: false,
  fallbackText: 'OpenChamber AI Coding',
  clearWhenIdle: false,
};

export type ModelRef = {
  id: string;
  providerID?: string;
  variant?: string;
};

export type SessionView = {
  projectName: string | null;
  modelName: string | null;
  startedAt: number | null;
  tokens: number | null;
  cost: number | null;
  working: boolean;
  hasSession: boolean;
};

export type PresenceCopy = {
  details: string;
  state: string;
  startedAt: number | null;
  largeImageKey: string;
  largeImageText: string;
};

export type DiscordActivity = {
  type: 0;
  details?: string;
  state?: string;
  timestamps?: { start: number };
  assets?: { large_image: string; large_text?: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

/** Discord rejects empty and over-long activity strings; keep both boundaries safe. */
export const clampActivityText = (value: string, max = ACTIVITY_MAX): string => {
  const clean = collapseWhitespace(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
};

const booleanOr = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const stringOr = (value: unknown, fallback: string, max: number): string =>
  typeof value === 'string' ? collapseWhitespace(value).slice(0, max) : fallback;

/**
 * Merge unknown persisted data over the defaults. The result is always complete,
 * always the right type, and never contains keys the extension does not read.
 */
export const sanitizeSettings = (input: unknown): Settings => {
  const source = isRecord(input) ? input : {};
  return {
    enabled: booleanOr(source.enabled, DEFAULT_SETTINGS.enabled),
    customActivity: stringOr(source.customActivity, DEFAULT_SETTINGS.customActivity, ACTIVITY_MAX),
    showProject: booleanOr(source.showProject, DEFAULT_SETTINGS.showProject),
    showModel: booleanOr(source.showModel, DEFAULT_SETTINGS.showModel),
    showElapsed: booleanOr(source.showElapsed, DEFAULT_SETTINGS.showElapsed),
    showTokens: booleanOr(source.showTokens, DEFAULT_SETTINGS.showTokens),
    showCost: booleanOr(source.showCost, DEFAULT_SETTINGS.showCost),
    fallbackText: stringOr(source.fallbackText, DEFAULT_SETTINGS.fallbackText, ACTIVITY_MAX) || DEFAULT_SETTINGS.fallbackText,
    clearWhenIdle: booleanOr(source.clearWhenIdle, DEFAULT_SETTINGS.clearWhenIdle),
  };
};

/**
 * The settings object on disk. `version` lets a future release migrate without
 * guessing which shape it found.
 */
export const storedSettings = (settings: Settings): StoredSettings => ({
  version: SETTINGS_VERSION,
  ...sanitizeSettings(settings),
});

const BRAND_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  azure: 'Azure',
  bedrock: 'Bedrock',
  cerebras: 'Cerebras',
  claude: 'Claude',
  cohere: 'Cohere',
  copilot: 'Copilot',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  gemini: 'Gemini',
  github: 'GitHub',
  glm: 'GLM',
  google: 'Google',
  grok: 'Grok',
  groq: 'Groq',
  kimi: 'Kimi',
  llama: 'Llama',
  lmstudio: 'LM Studio',
  meta: 'Meta',
  microsoft: 'Microsoft',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  moonshot: 'Moonshot',
  nvidia: 'NVIDIA',
  ollama: 'Ollama',
  openai: 'OpenAI',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  perplexity: 'Perplexity',
  qwen: 'Qwen',
  together: 'Together',
  vertex: 'Vertex',
  xai: 'xAI',
  zhipu: 'Zhipu',
};

const ACRONYMS = new Set(['gpt', 'glm', 'api', 'ai', 'os', 'ui', 'vl', 'tts', 'stt', 'moe']);

/**
 * Turn OpenCode's model id into something a person reads on a profile card.
 * The raw id stays in the settings panel and in logs; Discord gets the label.
 */
export const formatModelName = (model: ModelRef | null | undefined): string | null => {
  const raw = model?.id?.trim();
  if (!raw) return null;

  // A provider-qualified id uses the last segment as the model name.
  const withoutProvider = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const tokens = withoutProvider.split(/[-_\s]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // `claude-sonnet-4-5-20251101` should not advertise the snapshot date.
  if (tokens.length > 1 && /^\d{8}$/.test(tokens[tokens.length - 1] ?? '')) tokens.pop();

  const formatted = tokens.map((token) => {
    const lower = token.toLowerCase();
    if (BRAND_NAMES[lower]) return BRAND_NAMES[lower];

    const gpt = /^gpt(.*)$/i.exec(token);
    if (gpt) {
      const rest = gpt[1] ?? '';
      return rest ? `GPT${rest.startsWith('.') || rest.startsWith('-') ? rest : `-${rest}`}` : 'GPT';
    }

    if (/^o\d/i.test(token)) return token.toUpperCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (/[A-Z]/.test(token)) return token;
    if (/^v\d/i.test(token)) return `V${token.slice(1)}`;
    return token.charAt(0).toUpperCase() + token.slice(1);
  });

  let label = formatted.join(' ');
  // "Claude Sonnet 4 5" reads as "Claude Sonnet 4.5".
  label = label.replace(/\b(\d+) (\d+)\b/g, '$1.$2');
  // Keep GPT's version attached: "GPT 5.1" -> "GPT-5.1".
  label = label.replace(/\bGPT (\d)/g, 'GPT-$1');
  return label.trim() || withoutProvider;
};

/** `ses_…` and the rest of a provider-qualified model id, as the host reports it. */
export const parseModel = (value: unknown): ModelRef | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf('/');
    if (slash > 0 && slash < trimmed.length - 1) {
      return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
    }
    return { id: trimmed };
  }
  if (!isRecord(value)) return null;
  const id = text(value.id).trim();
  if (!id) return null;
  return {
    id,
    ...(text(value.providerID).trim() ? { providerID: text(value.providerID).trim() } : {}),
    ...(text(value.variant).trim() ? { variant: text(value.variant).trim() } : {}),
  };
};

const lastPathSegment = (value: string): string => {
  const normalized = value.replace(/[\\/]+$/, '');
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
};

/**
 * The directory is the only project information the service reads. OpenChamber's
 * ephemeral "Chats" project lives under its data directory, so it gets a friendly
 * name instead of a session UUID.
 */
export const projectNameFromDirectory = (directory: string | null | undefined): string | null => {
  if (!directory) return null;
  const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  if (/(^|\/)openchamber\/chats(\/|$)/i.test(normalized)) return 'OpenChamber Chat';
  const name = lastPathSegment(normalized);
  if (!name) return null;
  // A bare session folder on case-insensitive platforms is still a chat folder.
  if (/^session-[0-9a-f-]{8,}$/i.test(name)) return 'OpenChamber Chat';
  return name;
};

/** The panel hands the service the host's `model` value; this keeps the shape uniform. */
export const sessionViewFrom = (args: {
  projectName: string | null;
  modelName: string | null;
  startedAt: number | null;
  tokens?: number | null;
  cost?: number | null;
  working: boolean;
  hasSession: boolean;
}): SessionView => ({
  projectName: args.projectName,
  modelName: args.modelName,
  startedAt: Number.isFinite(args.startedAt) ? args.startedAt : null,
  tokens: Number.isFinite(args.tokens) ? (args.tokens as number) : null,
  cost: Number.isFinite(args.cost) ? (args.cost as number) : null,
  working: args.working,
  hasSession: args.hasSession,
});

export const interpolateActivity = (
  template: string,
  values: { project: string; model: string; tokens: string; cost: string; app: string },
): string => {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(`{${key}}`).join(value);
  }
  return collapseWhitespace(result);
};

/**
 * Generated tokens are what the model produced (`output + reasoning`), matching
 * OpenChamber's own token totals. Input/cache tokens are not shown because they
 * make the card long and are not a measure of work done.
 */
export const formatTokenCount = (tokens: number | null | undefined): string | null => {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens < 1000) return `${Math.round(tokens)} tokens`;
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    const value = thousands >= 100
      ? String(Math.round(thousands))
      : thousands.toFixed(1).replace(/\.0$/, '');
    return `${value}k tokens`;
  }
  const millions = tokens / 1_000_000;
  const value = millions >= 10
    ? String(Math.round(millions))
    : millions.toFixed(1).replace(/\.0$/, '');
  return `${value}M tokens`;
};

export const formatCost = (cost: number | null | undefined): string | null => {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost <= 0) return null;
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
};

/**
 * Append a stat without letting a long project name push the stat off the end
 * of Discord's 128-character line.
 */
const appendStat = (base: string, stat: string, max = ACTIVITY_MAX): string => {
  const cleanBase = collapseWhitespace(base);
  const suffix = ` · ${stat}`;
  if (!cleanBase || suffix.length >= max) return clampActivityText(stat, max);
  const room = max - suffix.length;
  if (room <= 1) return clampActivityText(stat, max);
  const head = cleanBase.length > room ? `${cleanBase.slice(0, room - 1).trimEnd()}…` : cleanBase;
  return `${head}${suffix}`;
};

export const buildPresenceCopy = (settings: Settings, session: SessionView): PresenceCopy => {
  const project = session.hasSession && settings.showProject ? session.projectName : null;
  const model = session.hasSession && settings.showModel ? session.modelName : null;
  const fallback = collapseWhitespace(settings.fallbackText) || DEFAULT_SETTINGS.fallbackText;
  const tokens = settings.showTokens ? formatTokenCount(session.tokens) : null;
  const cost = settings.showCost ? formatCost(session.cost) : null;
  const custom = collapseWhitespace(settings.customActivity);

  let details: string;
  if (custom) {
    details = interpolateActivity(settings.customActivity, {
      project: project ?? '',
      model: model ?? '',
      tokens: session.hasSession ? tokens ?? '' : '',
      cost: session.hasSession ? cost ?? '' : '',
      app: 'OpenChamber',
    });
    if (!details) details = fallback;
  } else if (project) {
    details = `Working on ${project}`;
  } else {
    details = fallback;
  }

  let state: string;
  if (!session.hasSession) {
    state = 'Ready';
  } else if (session.working) {
    state = model ? `Coding with ${model}` : 'Using OpenChamber';
  } else {
    state = model ? `Idle · ${model}` : 'Idle';
  }

  if (session.hasSession) {
    // Tokens live on the project line; cost stays on the model line. A custom
    // placeholder is not repeated automatically.
    if (tokens && !custom.includes('{tokens}')) details = appendStat(details, tokens);
    if (cost && !custom.includes('{cost}')) state = appendStat(state, cost);
  }

  return {
    details: clampActivityText(details) || 'OpenChamber',
    state: clampActivityText(state) || 'OpenChamber',
    startedAt: settings.showElapsed && session.hasSession ? session.startedAt : null,
    largeImageKey: DEFAULT_LARGE_IMAGE_KEY,
    largeImageText: DEFAULT_LARGE_IMAGE_TEXT,
  };
};

export const activityFromCopy = (copy: PresenceCopy): DiscordActivity => {
  const activity: DiscordActivity = {
    type: 0,
    details: copy.details,
    state: copy.state,
  };
  if (copy.startedAt !== null && Number.isFinite(copy.startedAt)) {
    activity.timestamps = { start: copy.startedAt };
  }
  if (copy.largeImageKey) {
    activity.assets = { large_image: copy.largeImageKey };
    if (copy.largeImageText) activity.assets.large_text = copy.largeImageText;
  }
  return activity;
};

/**
 * What should be on the profile right now. `cleared` is how the idle-clear timer
 * and the enable toggle hide presence without forgetting the current session.
 */
export const desiredActivity = (
  settings: Settings,
  session: SessionView,
  cleared: boolean,
): DiscordActivity | null => {
  if (!settings.enabled || cleared) return null;
  return activityFromCopy(buildPresenceCopy(settings, session));
};

/** Stable comparison key for the coalescing sender. */
export const activityKey = (activity: DiscordActivity | null): string =>
  activity === null ? 'null' : JSON.stringify(activity);

/** A preview can show the timer without a Discord connection. */
export const elapsedLabel = (startedAt: number | null, now = Date.now()): string => {
  if (startedAt === null || !Number.isFinite(startedAt)) return '';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} elapsed`;
  return `${m}:${String(s).padStart(2, '0')} elapsed`;
};
