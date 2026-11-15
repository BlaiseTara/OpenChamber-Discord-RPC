import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpenCodeEventsClient, OpenCodeSessionInfo } from '../src/service/opencode.ts';
import { SessionTracker } from '../src/service/tracker.ts';
import { sleep } from './helpers/util.ts';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const info = (id: string, overrides: Partial<OpenCodeSessionInfo> = {}): OpenCodeSessionInfo => ({
  id,
  parentID: null,
  directory: '/home/me/Projects/MyGame',
  model: { id: 'qwen3.5', providerID: 'local' },
  tokens: null,
  cost: null,
  createdAt: 1_000,
  updatedAt: 2_000,
  viewedAt: 2_000,
  archivedAt: null,
  busyAt: null,
  idleAt: null,
  working: false,
  ...overrides,
});

const fakeOpenCode = (sessions: OpenCodeSessionInfo[] = [], active: string[] = []) => {
  const map = new Map(sessions.map((session) => [session.id, session]));
  const activeSet = new Set(active);
  return {
    available: true,
    getSession: async (id: string) => map.get(id) ?? null,
    listSessions: async () => [...map.values()],
    activeSessions: async () => new Set(activeSet),
    setActive: (id: string) => activeSet.add(id),
    clearActive: () => activeSet.clear(),
    setSession: (session: OpenCodeSessionInfo) => map.set(session.id, session),
  } as unknown as OpenCodeEventsClient & {
    setActive: (id: string) => void;
    clearActive: () => void;
    setSession: (session: OpenCodeSessionInfo) => void;
  };
};

const makeTracker = (opencode: OpenCodeEventsClient, clock: { now: number }) => {
  let updates = 0;
  const tracker = new SessionTracker({
    opencode,
    logger: silentLogger,
    notify: () => {
      updates += 1;
    },
    now: () => clock.now,
  });
  return { tracker, updates: () => updates };
};

test('seeding a session produces working presence text', () => {
  const clock = { now: 3_000 };
  const { tracker } = makeTracker(fakeOpenCode(), clock);
  tracker.seedSession(info('ses_a', {
    working: true,
    tokens: { input: 1_000, output: 2_000, reasoning: 500, cache: { read: 0, write: 0 } },
    cost: 0.42,
  }));
  const view = tracker.view();
  assert.equal(view.projectName, 'MyGame');
  assert.equal(view.modelName, 'Qwen3.5');
  assert.equal(view.startedAt, 1_000);
  assert.equal(view.tokens, 2_500);
  assert.equal(view.cost, 0.42);
  assert.equal(view.working, true);
  assert.equal(tracker.idleSince(), null);
});

test('usage events update generated tokens and cost for the current session', async () => {
  const clock = { now: 4_000 };
  const { tracker } = makeTracker(fakeOpenCode([info('ses_a')]), clock);
  tracker.seedSession(info('ses_a', { working: true }));

  await tracker.handleWireEvent({
    type: 'session.usage.updated',
    created: 4_100,
    data: {
      sessionID: 'ses_a',
      cost: 0.5,
      tokens: { input: 900, output: 10_000, reasoning: 2_000, cache: { read: 0, write: 0 } },
    },
  });
  assert.equal(tracker.view().tokens, 12_000);
  assert.equal(tracker.view().cost, 0.5);

  await tracker.handleWireEvent({
    type: 'session.usage.updated',
    created: 4_200,
    data: {
      sessionID: 'ses_a',
      cost: 0.75,
      tokens: { input: 2_000, output: 15_000, reasoning: 3_000, cache: { read: 500, write: 0 } },
    },
  });
  assert.equal(tracker.view().tokens, 18_000);
  assert.equal(tracker.view().cost, 0.75);
});

test('viewed, model, project, execution, and archive events drive one session', async () => {
  const clock = { now: 10_000 };
  const opencode = fakeOpenCode([info('ses_a')]);
  const { tracker } = makeTracker(opencode, clock);

  await tracker.handleWireEvent({
    type: 'session.viewed',
    created: 10_000,
    data: { sessionID: 'ses_a' },
  });
  await sleep(10);
  assert.equal(tracker.view().projectName, 'MyGame');
  assert.equal(tracker.view().working, false);

  await tracker.handleWireEvent({
    type: 'session.model.selected',
    created: 11_000,
    data: { sessionID: 'ses_a', model: { id: 'llama-3.3-70b', providerID: 'meta' } },
  });
  assert.equal(tracker.view().modelName, 'Llama 3.3 70b');

  await tracker.handleWireEvent({
    type: 'session.moved',
    created: 12_000,
    data: { sessionID: 'ses_a', location: { directory: '/home/me/Projects/OtherGame' } },
  });
  assert.equal(tracker.view().projectName, 'OtherGame');

  await tracker.handleWireEvent({
    type: 'session.execution.started',
    created: 13_000,
    data: { sessionID: 'ses_a' },
  });
  assert.equal(tracker.view().working, true);

  await tracker.handleWireEvent({
    type: 'session.execution.succeeded',
    created: 14_000,
    data: { sessionID: 'ses_a' },
  });
  assert.equal(tracker.view().working, false);

  await tracker.handleWireEvent({
    type: 'session.archived',
    created: 15_000,
    data: { sessionID: 'ses_a' },
  });
  assert.equal(tracker.view().hasSession, false);
  assert.equal(tracker.status().currentSessionId, null);
});

test('subagent sessions never replace the human session', async () => {
  const clock = { now: 10_000 };
  const opencode = fakeOpenCode([
    info('ses_parent'),
    info('ses_child', { parentID: 'ses_parent' }),
  ]);
  const { tracker } = makeTracker(opencode, clock);
  tracker.seedSession(info('ses_parent'));

  await tracker.handleWireEvent({
    type: 'session.viewed',
    created: 10_000,
    data: { sessionID: 'ses_child' },
  });
  await sleep(10);
  assert.equal(tracker.status().currentSessionId, 'ses_parent');

  tracker.handleSessionEvent({
    event: {
      id: 'evt_child',
      type: 'turn-started',
      at: 10_000,
      session: { id: 'ses_child', parentId: 'ses_parent' },
      project: { directory: '/home/me/Projects/MyGame' },
      linked: [],
    },
  });
  assert.equal(tracker.status().currentSessionId, 'ses_parent');
});

test('stale execution-end events do not end a newer turn', async () => {
  const clock = { now: 20_000 };
  const { tracker } = makeTracker(fakeOpenCode([info('ses_a')]), clock);
  tracker.seedSession(info('ses_a'));

  tracker.handleSessionEvent({
    event: {
      id: 'evt_start',
      type: 'turn-started',
      at: 20_000,
      session: { id: 'ses_a', parentId: null },
      project: { directory: '/home/me/Projects/MyGame' },
      linked: [],
    },
  });
  assert.equal(tracker.view().working, true);

  tracker.handleSessionEvent({
    event: {
      id: 'evt_old_end',
      type: 'turn-finished',
      at: 19_000,
      session: { id: 'ses_a', parentId: null },
      project: { directory: '/home/me/Projects/MyGame' },
      linked: [],
    },
  });
  assert.equal(tracker.view().working, true);

  tracker.handleSessionEvent({
    event: {
      id: 'evt_end',
      type: 'turn-finished',
      at: 21_000,
      session: { id: 'ses_a', parentId: null },
      project: { directory: '/home/me/Projects/MyGame' },
      linked: [],
    },
  });
  assert.equal(tracker.view().working, false);
  assert.equal(tracker.idleSince(), 21_000);

  // A duplicate idle event does not move the idle-clear timer forward.
  clock.now = 25_000;
  tracker.handleSessionEvent({
    event: {
      id: 'evt_end_duplicate',
      type: 'turn-finished',
      at: 25_000,
      session: { id: 'ses_a', parentId: null },
      project: { directory: '/home/me/Projects/MyGame' },
      linked: [],
    },
  });
  assert.equal(tracker.idleSince(), 21_000);
});

test('a background turn does not replace a session that is still working', () => {
  const clock = { now: 30_000 };
  const opencode = fakeOpenCode([
    info('ses_a'),
    info('ses_b', { directory: '/home/me/Projects/OtherGame' }),
  ]);
  const { tracker } = makeTracker(opencode, clock);
  tracker.seedSession(info('ses_a', { working: true }));

  tracker.handleSessionEvent({
    event: {
      id: 'evt_b_start',
      type: 'turn-started',
      at: 30_000,
      session: { id: 'ses_b', parentId: null },
      project: { directory: '/home/me/Projects/OtherGame' },
      linked: [],
    },
  });
  assert.equal(tracker.status().currentSessionId, 'ses_a');
  assert.equal(tracker.view().working, true);

  tracker.handleSessionEvent({
    event: {
      id: 'evt_a_end',
      type: 'turn-finished',
      at: 30_100,
      session: { id: 'ses_a', parentId: null },
      project: { directory: '/home/me/Projects/MyGame' },
      linked: [],
    },
  });
  tracker.handleSessionEvent({
    event: {
      id: 'evt_b_start_2',
      type: 'turn-started',
      at: 30_200,
      session: { id: 'ses_b', parentId: null },
      project: { directory: '/home/me/Projects/OtherGame' },
      linked: [],
    },
  });
  assert.equal(tracker.status().currentSessionId, 'ses_b');
  assert.equal(tracker.view().projectName, 'OtherGame');
});

test('the open panel wins over background sessions until its authority expires', () => {
  const clock = { now: 30_000 };
  const opencode = fakeOpenCode([
    info('ses_a'),
    info('ses_b', { directory: '/home/me/Projects/OtherGame', viewedAt: 25_000 }),
  ]);
  const { tracker } = makeTracker(opencode, clock);
  tracker.applyPanelContext({
    sessionId: 'ses_a',
    directory: '/home/me/Projects/MyGame',
    model: 'local/qwen3.5',
    busy: true,
  });
  assert.equal(tracker.status().currentSessionId, 'ses_a');
  assert.equal(tracker.view().working, true);

  tracker.handleSessionEvent({
    event: {
      id: 'evt_b',
      type: 'turn-started',
      at: 30_000,
      session: { id: 'ses_b', parentId: null },
      project: { directory: '/home/me/Projects/OtherGame' },
      linked: [],
    },
  });
  assert.equal(tracker.status().currentSessionId, 'ses_a');

  clock.now += 91_000;
  tracker.handleSessionEvent({
    event: {
      id: 'evt_a2_end',
      type: 'turn-finished',
      at: clock.now,
      session: { id: 'ses_a', parentId: null },
      project: { directory: '/home/me/Projects/MyGame' },
      linked: [],
    },
  });
  tracker.handleSessionEvent({
    event: {
      id: 'evt_b2',
      type: 'turn-started',
      at: clock.now + 1,
      session: { id: 'ses_b', parentId: null },
      project: { directory: '/home/me/Projects/OtherGame' },
      linked: [],
    },
  });
  assert.equal(tracker.status().currentSessionId, 'ses_b');
  assert.equal(tracker.view().projectName, 'OtherGame');
});

test('a home-screen panel does not clear a session tracked from events', () => {
  const clock = { now: 40_000 };
  const { tracker } = makeTracker(fakeOpenCode([info('ses_a')]), clock);
  tracker.seedSession(info('ses_a'));
  tracker.applyPanelContext({ sessionId: null, directory: null, model: null, busy: null });
  assert.equal(tracker.view().hasSession, true);
  assert.equal(tracker.status().currentSessionId, 'ses_a');
});

test('reconcile prefers a running session and refreshes the current one', async () => {
  const clock = { now: 50_000 };
  const opencode = fakeOpenCode(
    [
      info('ses_idle', { viewedAt: 49_000, updatedAt: 49_000, busyAt: 40_000, idleAt: 49_000 }),
      info('ses_running', {
        directory: '/home/me/Projects/OtherGame',
        viewedAt: 30_000,
        updatedAt: 48_000,
        busyAt: 48_500,
        idleAt: null,
        model: { id: 'deepseek-v4.1-flash', providerID: 'local' },
      }),
    ],
    ['ses_idle', 'ses_running'],
  );
  const { tracker } = makeTracker(opencode, clock);
  await tracker.reconcile(true);
  assert.equal(tracker.status().currentSessionId, 'ses_running');
  assert.equal(tracker.view().working, true);
  assert.equal(tracker.view().modelName, 'DeepSeek V4.1 Flash');
  assert.equal(tracker.view().projectName, 'OtherGame');

  // A forced reconcile sees the running session become idle.
  (opencode as unknown as { clearActive: () => void }).clearActive();
  await tracker.reconcile(true);
  assert.equal(tracker.view().working, false);
});
