import { connectHost, HostRequestError, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import {
  DEFAULT_SETTINGS,
  elapsedLabel,
  formatCost,
  formatTokenCount,
  type Settings,
} from '../shared.ts';

type DiscordMode = 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'stopped';

type AppStatus = {
  ok: true;
  version: string;
  settings: Settings;
  discord: {
    mode: DiscordMode;
    enabled: boolean;
    connected: boolean;
    applicationId: string;
    socketPath: string | null;
    lastError: string | null;
    warning: string | null;
    lastSentAt: number | null;
    reconnectAttempt: number;
  };
  opencode: {
    available: boolean;
    connected: boolean;
    lastEventAt: number | null;
    lastError: string | null;
  };
  tracker: {
    currentSessionId: string | null;
    trackedSessions: number;
    working: boolean;
  };
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

type BannerKind = 'info' | 'warning' | 'error';

class ServiceResponseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ServiceResponseError';
    this.status = status;
  }
}

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing panel element #${id}`);
  return element as T;
};

const host = connectHost();

const banner = byId<HTMLDivElement>('banner');
const bannerTitle = byId<HTMLElement>('banner-title');
const bannerText = byId<HTMLElement>('banner-text');
const bannerAction = byId<HTMLButtonElement>('banner-action');
const bannerClose = byId<HTMLButtonElement>('banner-close');
const discordBadge = byId<HTMLElement>('discord-badge');
const opencodeBadge = byId<HTMLElement>('opencode-badge');
const previewCard = document.querySelector<HTMLElement>('.preview-card');
const previewHiddenPill = byId<HTMLElement>('preview-hidden-pill');
const previewDetails = byId<HTMLElement>('preview-details');
const previewState = byId<HTMLElement>('preview-state');
const previewTime = byId<HTMLElement>('preview-time');
const previewElapsed = byId<HTMLElement>('preview-elapsed');
const previewNote = byId<HTMLElement>('preview-note');
const saveState = byId<HTMLElement>('save-state');
const refreshButton = byId<HTMLButtonElement>('refresh');
const reconnectButton = byId<HTMLButtonElement>('reconnect');
const diagDiscord = byId<HTMLElement>('diag-discord');
const diagOpenCode = byId<HTMLElement>('diag-opencode');
const diagSession = byId<HTMLElement>('diag-session');
const diagUsage = byId<HTMLElement>('diag-usage');
const diagError = byId<HTMLElement>('diag-error');
const versionLabel = byId<HTMLElement>('version');

let ready: HostReadyContext | null = null;
let status: AppStatus | null = null;
let draft: Settings | null = null;
let dirty = false;
let saving = false;
let saveAgain = false;
let refreshTimer: number | null = null;
let refreshInFlight = false;
let refreshQueued = false;
let elapsedTimer: number | null = null;
let pollTimer: number | null = null;
let dismissedBannerKey = '';
let currentBannerKey = '';
let bannerHandler: (() => void) | null = null;
let lastServiceError: string | null = null;
let lastSettingsSaveAt = 0;

const settingInputs = Array.from(
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-setting]'),
);

const setBadge = (element: HTMLElement, label: string, tone: 'muted' | 'success' | 'warning' | 'error' | 'info') => {
  element.textContent = label;
  element.className = `badge ${tone}`;
};

const setSaveState = (label: string, kind: 'saved' | 'dirty' | 'saving' | 'error' = 'saved') => {
  saveState.textContent = label;
  saveState.className = `save-state${kind === 'saved' ? '' : ` is-${kind}`}`;
};

const hideBanner = () => {
  banner.hidden = true;
  currentBannerKey = '';
  bannerHandler = null;
};

const showBanner = (
  kind: BannerKind,
  title: string,
  text: string,
  action: { label: string; run: () => void; key: string } | null = null,
) => {
  const key = action?.key ?? `${kind}:${title}:${text}`;
  currentBannerKey = key;
  if (dismissedBannerKey === key) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${kind}`;
  bannerTitle.textContent = title;
  bannerText.textContent = text;
  if (action) {
    bannerAction.hidden = false;
    bannerAction.textContent = action.label;
    bannerHandler = action.run;
  } else {
    bannerAction.hidden = true;
    bannerHandler = null;
  }
};

const parseServiceBody = (body: unknown): unknown => {
  if (typeof body === 'string') {
    if (!body.trim()) return null;
    try {
      return JSON.parse(body);
    } catch {
      throw new ServiceResponseError(0, 'The local service answered with something other than JSON.');
    }
  }
  return body;
};

const callService = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
  const result = await host.serviceRequest({
    method,
    path,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = parseServiceBody(result.body);
  if (result.status < 200 || result.status >= 300) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `The local service answered HTTP ${result.status}.`;
    throw new ServiceResponseError(result.status, message);
  }
  return parsed;
};

const isStatusPayload = (value: unknown): value is AppStatus => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !record.settings || !record.presence || !record.discord) return false;
  return true;
};

const contextFromReady = () => {
  const session = ready?.session ?? null;
  // A rail panel opened on the home screen has no session. That must not clear
  // the session the service already tracks from lifecycle events.
  if (!session?.id) return {};
  return {
    sessionId: session.id,
    directory: ready?.directory ?? null,
    model: session.model ?? null,
    busy: session.busy ?? null,
  };
};

const requestErrorText = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'NO_SERVICE':
        return 'The local service is not available. Approve the extension in Settings → Extensions, then reopen this panel.';
      case 'DISABLED':
        return 'The extension is paused. Enable it in Settings → Extensions.';
      case 'NOT_GRANTED':
        return 'The extension does not have its requested permissions. Re-approve it in Settings → Extensions.';
      case 'SERVICE_FAILED':
        return 'The local service stopped. Press Reconnect, or close and reopen this panel.';
      case 'REQUEST_FAILED':
        return 'The local service did not answer. Press Refresh to try again.';
      case 'HOST_TIMEOUT':
        return 'The local service took too long to answer. Press Refresh to try again.';
      case 'HOST_UNAVAILABLE':
        return 'The settings panel is not connected to OpenChamber. Reopen the panel from the rail.';
      default:
        return error.message;
    }
  }
  if (error instanceof ServiceResponseError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
};

const showServiceError = (message: string) => {
  lastServiceError = message;
  status = null;
  setBadge(discordBadge, 'Service offline', 'error');
  setBadge(opencodeBadge, 'Session sync', 'muted');
  showBanner('error', 'Could not reach the extension service', message, {
    label: 'Retry',
    key: 'service-error',
    run: () => {
      lastServiceError = null;
      void refreshStatus(true);
    },
  });
  diagDiscord.textContent = 'Service unavailable';
  diagOpenCode.textContent = 'Service unavailable';
  diagError.textContent = message;
};

const applyStatus = (next: AppStatus, requestedAt = 0) => {
  status = next;
  lastServiceError = null;
  // A poll sent before a successful save must not overwrite the form with the
  // settings it read on the way out.
  if (!dirty && !saving && requestedAt >= lastSettingsSaveAt) {
    draft = { ...next.settings };
    fillForm(next.settings);
  }
  renderStatus();
};

const fillForm = (settings: Settings) => {
  for (const input of settingInputs) {
    const key = input.dataset.setting as keyof Settings | undefined;
    if (!key) continue;
    if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      input.checked = Boolean(settings[key]);
    } else {
      input.value = String(settings[key] ?? '');
    }
  }
  setSaveState('Saved');
};

const readForm = (): Settings => {
  const base = draft ?? status?.settings ?? DEFAULT_SETTINGS;
  const next: Settings = { ...base };
  const values = next as unknown as Record<string, unknown>;
  for (const input of settingInputs) {
    const key = input.dataset.setting;
    if (!key) continue;
    values[key] = input instanceof HTMLInputElement && input.type === 'checkbox'
      ? input.checked
      : input.value;
  }
  return next;
};

const refreshStatus = async (force = false) => {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  if (!ready) return;
  refreshInFlight = true;
  const requestedAt = Date.now();
  try {
    const payload = await callService('POST', '/status', contextFromReady());
    if (!isStatusPayload(payload)) {
      throw new ServiceResponseError(0, 'The local service returned an unexpected status.');
    }
    applyStatus(payload, requestedAt);
  } catch (error) {
    showServiceError(requestErrorText(error));
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      window.setTimeout(() => void refreshStatus(), 50);
    }
  }
};

const scheduleRefresh = () => {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshStatus();
  }, 120);
};

const renderStatus = () => {
  if (!status) return;
  const { settings, discord, opencode, presence } = status;

  if (!settings.enabled) {
    setBadge(discordBadge, 'Off', 'muted');
  } else if (discord.mode === 'connected') {
    setBadge(discordBadge, 'Connected', 'success');
  } else if (discord.mode === 'connecting') {
    setBadge(discordBadge, 'Connecting…', 'warning');
  } else if (discord.mode === 'disconnected') {
    setBadge(discordBadge, 'Discord not found', 'warning');
  } else {
    setBadge(discordBadge, 'Off', 'muted');
  }

  if (!opencode.available) {
    setBadge(opencodeBadge, 'Session metadata off', 'warning');
  } else if (opencode.connected) {
    setBadge(opencodeBadge, 'Session sync on', 'success');
  } else {
    setBadge(opencodeBadge, 'Session sync waiting', 'warning');
  }

  previewDetails.textContent = presence.details || 'OpenChamber';
  previewState.textContent = presence.state || 'Ready';
  const timerVisible = presence.visible && presence.startedAt !== null;
  previewTime.hidden = !timerVisible;
  if (timerVisible && presence.startedAt !== null) {
    previewElapsed.textContent = elapsedLabel(presence.startedAt);
  }
  previewCard?.classList.toggle('is-hidden', !presence.visible);
  previewHiddenPill.hidden = presence.visible;
  if (!presence.visible) {
    if (presence.reason === 'disabled') previewNote.textContent = 'Presence is turned off.';
    else if (presence.reason === 'idle-cleared') previewNote.textContent = 'Presence is hidden while OpenChamber is idle.';
    else previewNote.textContent = 'Presence is hidden.';
  } else if (settings.enabled && !discord.connected) {
    previewNote.textContent = 'Preview only — Discord is not connected yet.';
  } else {
    previewNote.textContent = 'This is what Discord shows on your profile.';
  }

  versionLabel.textContent = `v${status.version}`;
  const discordMode = discord.enabled ? discord.mode : 'off';
  diagDiscord.textContent = `${discordMode}${discord.applicationId ? ` · ${discord.applicationId}` : ''}${discord.socketPath ? ` · ${discord.socketPath}` : ''}`;
  diagOpenCode.textContent = !opencode.available
    ? 'Not available (OpenCode read access not granted)'
    : `${opencode.connected ? 'connected' : 'reconnecting'}${opencode.lastEventAt ? ` · last event ${new Date(opencode.lastEventAt).toLocaleTimeString()}` : ''}`;
  const sessionParts = [
    presence.project ?? 'No project',
    presence.model ?? 'No model',
    presence.working ? 'working' : (presence.hasSession ? 'idle' : 'no session'),
  ];
  diagSession.textContent = `${sessionParts.join(' · ')}${presence.clearAt ? ` · hides at ${new Date(presence.clearAt).toLocaleTimeString()}` : ''}`;
  const usageParts = [formatTokenCount(presence.tokens), formatCost(presence.cost)].filter(Boolean);
  diagUsage.textContent = usageParts.length > 0 ? usageParts.join(' · ') : 'No usage reported yet';
  const lastError = discord.lastError || opencode.lastError || '';
  diagError.textContent = lastError || 'None';

  if (!settings.enabled) {
    showBanner('info', 'Presence is off', 'Turn on Discord Rich Presence above to show your activity.');
  } else if (discord.warning) {
    showBanner('warning', 'Discord rejected the image', discord.warning, {
      label: 'Reconnect',
      key: 'image-warning',
      run: () => void reconnect(),
    });
  } else if (discord.mode === 'disconnected') {
    showBanner(
      'warning',
      'Discord is not reachable',
      'Keep the Discord desktop app running. The extension reconnects automatically — or try now.',
      { label: 'Reconnect', key: 'discord-down', run: () => void reconnect() },
    );
  } else if (!opencode.available) {
    showBanner(
      'info',
      'Session metadata is off',
      'The extension cannot read the model or project yet. Re-approve it in Settings → Extensions to grant OpenCode read access.',
    );
  } else if (lastServiceError) {
    showBanner('error', 'Could not reach the extension service', lastServiceError);
  } else {
    hideBanner();
  }
};

const reconnect = async () => {
  reconnectButton.disabled = true;
  reconnectButton.textContent = 'Reconnecting…';
  try {
    const payload = await callService('POST', '/reconnect');
    if (isStatusPayload(payload)) applyStatus(payload);
    else await refreshStatus(true);
  } catch (error) {
    showServiceError(requestErrorText(error));
  } finally {
    reconnectButton.disabled = false;
    reconnectButton.textContent = 'Reconnect';
  }
};

const refreshNow = async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = 'Refreshing…';
  try {
    const payload = await callService('POST', '/refresh');
    if (isStatusPayload(payload)) applyStatus(payload);
    else await refreshStatus(true);
  } catch (error) {
    showServiceError(requestErrorText(error));
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh';
  }
};

let saveTimerId: number | null = null;

const queueSave = (delay = 550) => {
  dirty = true;
  setSaveState('Unsaved changes', 'dirty');
  if (saveTimerId !== null) window.clearTimeout(saveTimerId);
  saveTimerId = window.setTimeout(() => {
    saveTimerId = null;
    void saveNow();
  }, delay);
};

const saveNow = async () => {
  if (saving) {
    saveAgain = true;
    return;
  }
  const next = readForm();
  draft = next;
  saving = true;
  setSaveState('Saving…', 'saving');
  try {
    const payload = await callService('POST', '/settings', next);
    if (!isStatusPayload(payload)) throw new ServiceResponseError(0, 'The local service returned an unexpected answer.');
    dirty = false;
    lastSettingsSaveAt = Date.now();
    applyStatus(payload, lastSettingsSaveAt);
    setSaveState('Saved');
  } catch (error) {
    setSaveState('Not saved', 'error');
    showBanner('error', 'Could not save settings', requestErrorText(error), {
      label: 'Retry',
      key: 'save-error',
      run: () => void saveNow(),
    });
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      void saveNow();
    }
  }
};

bannerClose.addEventListener('click', () => {
  dismissedBannerKey = currentBannerKey;
  hideBanner();
});

bannerAction.addEventListener('click', () => {
  bannerHandler?.();
});

for (const input of settingInputs) {
  input.addEventListener('input', () => {
    const key = input.dataset.setting as keyof Settings | undefined;
    if (!key) return;
    if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      queueSave(0);
      return;
    }
    queueSave();
  });
  input.addEventListener('blur', () => {
    if (dirty && !saving) void saveNow();
  });
}

refreshButton.addEventListener('click', () => void refreshNow());
reconnectButton.addEventListener('click', () => void reconnect());

host.onReady((context) => {
  ready = context;
  applyHostReady(context, document.documentElement);
  void refreshStatus(true);
});

host.onSession(() => {
  scheduleRefresh();
});

host.onDirectory(() => {
  scheduleRefresh();
});

elapsedTimer = window.setInterval(() => {
  if (!status || !status.presence.visible || status.presence.startedAt === null) return;
  previewElapsed.textContent = elapsedLabel(status.presence.startedAt);
}, 1_000);

pollTimer = window.setInterval(() => {
  if (document.hidden) return;
  void refreshStatus();
}, 2_000);

window.addEventListener('beforeunload', () => {
  if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (saveTimerId !== null) window.clearTimeout(saveTimerId);
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  host.dispose();
});

