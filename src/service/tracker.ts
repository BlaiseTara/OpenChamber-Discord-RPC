import {
  formatModelName,
  parseModel,
  projectNameFromDirectory,
  type ModelRef,
  type SessionView,
} from '../shared.ts';
import {
  sessionInfoFrom,
  tokenUsageFrom,
  type OpenCodeEventsClient,
  type OpenCodeSessionInfo,
  type OpenCodeTokenUsage,
  type OpenCodeWireEvent,
} from './opencode.ts';
import type { Logger } from './discord.ts';

export type PanelContext = {
  sessionId: string | null;
  directory: string | null;
  model: string | null;
  busy: boolean | null;
};

export type GuestSessionEvent = {
  event: {
    id: string;
    type:
      | 'turn-finished'
      | 'turn-failed'
      | 'permission-asked'
      | 'question-asked'
      | 'turn-started'
      | 'session-created'
      | 'session-archived'
      | 'session-deleted';
    at: number;
    session: { id: string; parentId: string | null };
    project: { directory: string | null };
    linked: unknown[];
  };
};

type TrackedSession = {
  id: string;
  parentID: string | null;
  directory: string | null;
  model: ModelRef | null;
  tokens: OpenCodeTokenUsage | null;
  cost: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  viewedAt: number | null;
  busyAt: number | null;
  idleAt: number | null;
  firstSeenAt: number;
  working: boolean;
  turnStartedAt: number | null;
  idleSince: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const PANEL_AUTHORITY_MS = 90_000;
const RECONCILE_THROTTLE_MS = 45_000;

/** `active` can outlive the turn; the busy/idle timestamps decide. */
const isLive = (busyAt: number | null, idleAt: number | null, active: boolean): boolean =>
  active && (idleAt === null || busyAt === null || busyAt > idleAt);

/**
 * Turns OpenChamber's session lifecycle and OpenCode's metadata events into the
 * one session the profile card describes. It never reads a message.
 */
export class SessionTracker {
  private readonly opencode: OpenCodeEventsClient;
  private readonly logger: Logger;
  private readonly notify: () => void;
  private readonly now: () => number;
  private readonly cache = new Map<string, TrackedSession>();
  private currentId: string | null = null;
  private noSessionSince = Date.now();
  private panelSessionId: string | null = null;
  private panelAuthorityUntil = 0;
  private lastReconcileAt = 0;
  private reconcileInFlight: Promise<void> | null = null;
  private viewSeq = 0;

  constructor(options: {
    opencode: OpenCodeEventsClient;
    logger: Logger;
    notify: () => void;
    now?: () => number;
  }) {
    this.opencode = options.opencode;
    this.logger = options.logger;
    this.notify = options.notify;
    this.now = options.now ?? Date.now;
  }

  status(): { currentSessionId: string | null; trackedSessions: number; working: boolean } {
    const current = this.currentId ? this.cache.get(this.currentId) : null;
    return {
      currentSessionId: this.currentId,
      trackedSessions: this.cache.size,
      working: Boolean(current?.working),
    };
  }

  view(): SessionView {
    const current = this.currentId ? this.cache.get(this.currentId) : null;
    if (!current) {
      return {
        projectName: null,
        modelName: null,
        startedAt: null,
        tokens: null,
        cost: null,
        working: false,
        hasSession: false,
      };
    }
    const generated = current.tokens
      ? current.tokens.output + current.tokens.reasoning
      : null;
    return {
      projectName: projectNameFromDirectory(current.directory),
      modelName: formatModelName(current.model),
      startedAt: current.createdAt ?? current.firstSeenAt,
      tokens: generated,
      cost: current.cost,
      working: current.working,
      hasSession: true,
    };
  }

  /** The moment the profile should clear when the idle-clear option is on. */
  idleSince(): number | null {
    const current = this.currentId ? this.cache.get(this.currentId) : null;
    if (!current) return this.noSessionSince;
    if (current.working) return null;
    return current.idleSince ?? this.now();
  }

  private panelAuthorityActive(): boolean {
    return this.panelSessionId !== null && this.now() < this.panelAuthorityUntil;
  }

  private panelOwns(sessionId: string): boolean {
    return this.panelAuthorityActive() && this.panelSessionId !== sessionId;
  }

  /** A background turn does not replace a session that is still generating. */
  private shouldFollow(sessionId: string): boolean {
    if (this.panelOwns(sessionId)) return false;
    const current = this.currentId ? this.cache.get(this.currentId) : null;
    return !current || current.id === sessionId || !current.working;
  }

  private clearCurrent(): void {
    if (this.currentId === null) return;
    this.currentId = null;
    this.noSessionSince = this.now();
    this.notify();
  }

  private ensure(id: string, partial: Partial<TrackedSession> = {}): TrackedSession {
    const existing = this.cache.get(id);
    if (existing) {
      if (partial.parentID !== undefined) existing.parentID = partial.parentID;
      if (partial.directory) existing.directory = partial.directory;
      if (partial.model) existing.model = partial.model;
      if (partial.tokens) existing.tokens = partial.tokens;
      if (partial.cost !== undefined && partial.cost !== null) existing.cost = partial.cost;
      if (partial.createdAt !== undefined && partial.createdAt !== null) existing.createdAt = partial.createdAt;
      if (partial.updatedAt !== undefined && partial.updatedAt !== null) existing.updatedAt = partial.updatedAt;
      if (partial.viewedAt !== undefined && partial.viewedAt !== null) existing.viewedAt = partial.viewedAt;
      if (partial.busyAt !== undefined && partial.busyAt !== null) existing.busyAt = partial.busyAt;
      if (partial.idleAt !== undefined && partial.idleAt !== null) existing.idleAt = partial.idleAt;
      return existing;
    }
    const created: TrackedSession = {
      id,
      parentID: partial.parentID ?? null,
      directory: partial.directory ?? null,
      model: partial.model ?? null,
      tokens: partial.tokens ?? null,
      cost: partial.cost ?? null,
      createdAt: partial.createdAt ?? null,
      updatedAt: partial.updatedAt ?? null,
      viewedAt: partial.viewedAt ?? null,
      busyAt: partial.busyAt ?? null,
      idleAt: partial.idleAt ?? null,
      firstSeenAt: this.now(),
      working: partial.working ?? false,
      turnStartedAt: partial.turnStartedAt ?? null,
      idleSince: partial.idleSince ?? null,
    };
    this.cache.set(id, created);
    return created;
  }

  private mergeInfo(info: OpenCodeSessionInfo): TrackedSession {
    const session = this.ensure(info.id, {
      parentID: info.parentID,
      directory: info.directory,
      model: info.model,
      tokens: info.tokens,
      cost: info.cost,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      viewedAt: info.viewedAt,
      busyAt: info.busyAt,
      idleAt: info.idleAt,
    });
    if (info.archivedAt !== null) session.idleSince = info.archivedAt;
    if (info.working) this.markWorking(info.id, this.now());
    return session;
  }

  private setCurrent(id: string, working: boolean): void {
    if (this.currentId !== id) {
      this.currentId = id;
      const session = this.ensure(id);
      if (!working && session.idleSince === null) session.idleSince = this.now();
    }
    if (working) this.markWorking(id, this.now());
    this.notify();
  }

  private markWorking(id: string, at: number | null): void {
    const timestamp = at ?? this.now();
    const session = this.ensure(id);
    if (session.turnStartedAt !== null && timestamp < session.turnStartedAt) return;
    const changed = !session.working || session.idleSince !== null;
    session.working = true;
    session.turnStartedAt = timestamp;
    session.idleSince = null;
    if (changed || this.currentId === id) this.notify();
  }

  private markIdle(id: string, at: number | null): void {
    const session = this.cache.get(id);
    if (!session) return;
    const timestamp = at ?? this.now();
    if (session.turnStartedAt !== null && timestamp < session.turnStartedAt) return;
    // Keep the first idle timestamp of this idle period. Reconciliation and a
    // repeated idle event must not keep pushing the 45-second clear forward.
    if (!session.working && session.idleSince !== null) return;
    session.working = false;
    session.idleSince = timestamp;
    session.turnStartedAt = null;
    if (this.currentId === id) this.notify();
  }

  private activate(id: string, working: boolean): void {
    if (this.panelOwns(id)) return;
    this.setCurrent(id, working);
  }

  /** A model change is the strongest signal that the user changed the picker. */
  private applyModel(id: string, model: ModelRef | null): void {
    if (!model) return;
    const session = this.ensure(id);
    if (session.model?.id === model.id && session.model?.providerID === model.providerID) return;
    session.model = model;
    if (this.currentId === id) this.notify();
  }

  private applyDirectory(id: string, directory: string | null): void {
    if (!directory) return;
    const session = this.ensure(id);
    if (session.directory === directory) return;
    session.directory = directory;
    if (this.currentId === id) this.notify();
  }

  /** Cumulative usage from `/api/session` or `session.usage.updated`. */
  private applyUsage(id: string, tokens: OpenCodeTokenUsage | null, cost: number | null): void {
    if (!tokens && cost === null) return;
    const session = this.ensure(id);
    if (tokens) session.tokens = tokens;
    if (cost !== null) session.cost = cost;
    if (this.currentId === id) this.notify();
  }

  private async refreshSession(id: string): Promise<OpenCodeSessionInfo | null> {
    const info = await this.opencode.getSession(id);
    if (!info) return null;
    const session = this.mergeInfo(info);
    if (session.parentID !== null && this.currentId === id) {
      this.clearCurrent();
    }
    return info;
  }

  /**
   * `session.viewed` arrives when the user opens a chat. Fetch metadata only when
   * the event stream did not carry it yet, and ask whether the session is running.
   */
  private async activateFromView(id: string): Promise<void> {
    const seq = ++this.viewSeq;
    const cached = this.cache.get(id);
    if (cached?.parentID) return;
    if (this.panelOwns(id)) return;

    const active = await this.opencode.activeSessions();
    let working = isLive(cached?.busyAt ?? null, cached?.idleAt ?? null, active.has(id));
    if (!cached?.model || !cached.directory) {
      const info = await this.refreshSession(id);
      if (info?.parentID) return;
      if (info) working = isLive(info.busyAt, info.idleAt, active.has(id));
    }
    // A newer `session.viewed` may have won while the metadata was loading.
    if (seq !== this.viewSeq) return;
    if (this.panelOwns(id)) return;
    this.setCurrent(id, working);
  }

  async handleWireEvent(event: OpenCodeWireEvent): Promise<void> {
    const type = event.type;
    const data = isRecord(event.data) ? event.data : {};
    const id = stringOrNull(data.sessionID);
    if (!type || !id) return;
    const at = numberOrNull(event.created) ?? this.now();

    switch (type) {
      case 'session.created': {
        const location = isRecord(data.location) ? data.location : {};
        const parentID = stringOrNull(data.parentID);
        const model = parseModel(data.model);
        const session = this.ensure(id, {
          parentID,
          directory: stringOrNull(location.directory) ?? stringOrNull(event.location?.directory),
          model,
          createdAt: at,
        });
        if (session.parentID === null && this.currentId === null) this.activate(id, false);
        break;
      }
      case 'session.viewed': {
        void this.activateFromView(id);
        break;
      }
      case 'session.model.selected': {
        this.applyModel(id, parseModel(data.model));
        break;
      }
      case 'session.usage.updated': {
        this.applyUsage(id, tokenUsageFrom(data.tokens), numberOrNull(data.cost));
        break;
      }
      case 'session.moved': {
        const location = isRecord(data.location) ? data.location : {};
        this.applyDirectory(id, stringOrNull(location.directory) ?? stringOrNull(event.location?.directory));
        break;
      }
      case 'session.execution.started': {
        const cached = this.cache.get(id);
        if (cached?.parentID) return;
        if (!cached) {
          // A subagent can start before its creation event; check before switching.
          void this.refreshSession(id).then((info) => {
            if (info?.parentID) return;
            this.markWorking(id, at);
            if (this.shouldFollow(id)) this.setCurrent(id, true);
          });
          return;
        }
        this.markWorking(id, at);
        if (this.shouldFollow(id)) this.activate(id, true);
        break;
      }
      case 'session.step.started': {
        this.applyModel(id, parseModel(data.model));
        const cached = this.cache.get(id);
        if (cached?.parentID) return;
        this.markWorking(id, at);
        // If the previously shown session is idle, follow the session that is
        // actually generating. A working current session keeps the card.
        if (this.shouldFollow(id)) this.activate(id, true);
        break;
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed': {
        this.markIdle(id, at);
        break;
      }
      case 'session.execution.interrupted': {
        if (stringOrNull(data.reason) === 'shutdown') return;
        this.markIdle(id, at);
        break;
      }
      case 'session.idle': {
        this.markIdle(id, at);
        break;
      }
      case 'session.status': {
        const status = isRecord(data.status) ? data.status : {};
        const statusType = stringOrNull(status.type);
        if (statusType === 'idle') this.markIdle(id, at);
        else if (statusType === 'busy' || statusType === 'retry') {
          const cached = this.cache.get(id);
          if (!cached?.parentID) this.markWorking(id, at);
        }
        break;
      }
      case 'session.archived':
      case 'session.deleted': {
        this.cache.delete(id);
        if (this.currentId === id) this.clearCurrent();
        else this.notify();
        break;
      }
      default:
        break;
    }
  }

  /**
   * `contributes.sessionEvents` gives headless turn boundaries and directories
   * even when no window is open. They carry no model or transcript.
   */
  handleSessionEvent(request: GuestSessionEvent): void {
    const event = request.event;
    const id = event.session.id;
    const at = Number.isFinite(event.at) ? event.at : this.now();
    const parentID = event.session.parentId;
    const directory = event.project.directory;

    switch (event.type) {
      case 'session-created': {
        const session = this.ensure(id, { parentID, directory, createdAt: at });
        if (session.parentID === null && this.currentId === null) this.activate(id, false);
        break;
      }
      case 'turn-started': {
        if (parentID) return;
        this.ensure(id, { parentID, directory });
        this.markWorking(id, at);
        if (this.shouldFollow(id)) this.activate(id, true);
        break;
      }
      case 'turn-finished':
      case 'turn-failed': {
        if (parentID) return;
        this.ensure(id, { parentID, directory });
        this.markIdle(id, at);
        break;
      }
      case 'session-archived':
      case 'session-deleted': {
        this.cache.delete(id);
        if (this.currentId === id) this.clearCurrent();
        else this.notify();
        break;
      }
      default:
        break;
    }
  }

  /**
   * The panel is the only surface that knows which chat the user is looking at.
   * While it is open and sending context, it wins over background session events.
   */
  applyPanelContext(context: PanelContext): void {
    const now = this.now();
    if (context.sessionId === null) {
      // No chat is open in the panel. Keep whatever the lifecycle events last
      // established; the home screen is not proof that the session ended.
      this.panelSessionId = null;
      this.panelAuthorityUntil = 0;
      return;
    }
    if (!/^ses_[\w-]+$/.test(context.sessionId)) return;

    const session = this.ensure(context.sessionId, {
      directory: context.directory,
      model: parseModel(context.model),
    });
    if (session.parentID) return;
    this.panelSessionId = context.sessionId;
    this.panelAuthorityUntil = now + PANEL_AUTHORITY_MS;
    const working = context.busy === true;
    if (working) this.markWorking(context.sessionId, now);
    else if (session.working) this.markIdle(context.sessionId, now);
    this.setCurrent(context.sessionId, working);

    if (!session.createdAt) {
      void this.refreshSession(context.sessionId).then((info) => {
        if (info?.createdAt && this.currentId === context.sessionId) this.notify();
      });
    }
  }

  /**
   * One metadata read at startup and after a reconnect. Events do the rest.
   */
  async reconcile(force = false): Promise<void> {
    if (!this.opencode.available) return;
    if (this.reconcileInFlight) return this.reconcileInFlight;
    if (!force && this.now() - this.lastReconcileAt < RECONCILE_THROTTLE_MS) return;

    this.reconcileInFlight = (async () => {
      try {
        const [sessions, active] = await Promise.all([
          this.opencode.listSessions(50),
          this.opencode.activeSessions(),
        ]);
        if (sessions.length === 0) return;
        const workingIds = new Set<string>();
        for (const info of sessions) {
          // `active` can keep a drain owned while its last turn is already
          // settled. The busy/idle timestamps say whether a turn is still live.
          info.working = isLive(info.busyAt, info.idleAt, active.has(info.id));
          if (info.working) workingIds.add(info.id);
          const session = this.mergeInfo(info);
          if (info.working) this.markWorking(info.id, this.now());
          else if (session.working) this.markIdle(info.id, this.now());
        }

        const current = this.currentId ? this.cache.get(this.currentId) : null;
        if (current) {
          if (sessions.some((session) => session.id === current.id)) {
            if (workingIds.has(current.id)) this.markWorking(current.id, this.now());
            else this.markIdle(current.id, this.now());
          }
          this.notify();
          return;
        }
        if (this.currentId || this.panelAuthorityActive()) return;

        const topLevel = sessions.filter((session) => !session.parentID);
        const running = topLevel
          .filter((session) => workingIds.has(session.id))
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
        const latest = running ?? topLevel
          .sort((a, b) => (b.viewedAt ?? b.updatedAt ?? 0) - (a.viewedAt ?? a.updatedAt ?? 0))[0];
        if (latest) this.setCurrent(latest.id, workingIds.has(latest.id));
      } catch (error) {
        this.logger.warn('Could not reconcile session metadata:', error instanceof Error ? error.message : error);
      } finally {
        this.lastReconcileAt = this.now();
        this.reconcileInFlight = null;
      }
    })();
    return this.reconcileInFlight;
  }

  /** Tests use this to seed a session without a live OpenCode server. */
  seedSession(info: OpenCodeSessionInfo, current = true): void {
    const session = this.mergeInfo(info);
    if (current) this.setCurrent(session.id, info.working);
  }

  /** Exposed for tests and diagnostics: the raw metadata the service holds. */
  snapshot(): { current: string | null; sessions: OpenCodeSessionInfo[] } {
    return {
      current: this.currentId,
      sessions: [...this.cache.values()].map((session) => ({
        id: session.id,
        parentID: session.parentID,
        directory: session.directory,
        model: session.model,
        tokens: session.tokens,
        cost: session.cost,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        viewedAt: session.viewedAt,
        archivedAt: null,
        busyAt: session.busyAt,
        idleAt: session.idleAt,
        working: session.working,
      })),
    };
  }
}

export { sessionInfoFrom };
