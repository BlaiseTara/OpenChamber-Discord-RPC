import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityFromCopy,
  buildPresenceCopy,
  DEFAULT_SETTINGS,
  desiredActivity,
  elapsedLabel,
  formatCost,
  formatModelName,
  formatTokenCount,
  parseModel,
  projectNameFromDirectory,
  sanitizeSettings,
  sessionViewFrom,
} from '../src/shared.ts';

const session = (overrides: Partial<Parameters<typeof sessionViewFrom>[0]> = {}) =>
  sessionViewFrom({
    projectName: 'MyGame',
    modelName: 'Qwen3.5',
    startedAt: 1_700_000_000_000,
    working: true,
    hasSession: true,
    ...overrides,
  });

test('sanitizeSettings completes and clamps persisted values', () => {
  const settings = sanitizeSettings({
    enabled: false,
    customActivity: 42,
    fallbackText: '  a   fallback  ',
    extra: 'ignored',
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.customActivity, DEFAULT_SETTINGS.customActivity);
  assert.equal(settings.fallbackText, 'a fallback');
  assert.equal('extra' in settings, false);
  assert.equal('applicationId' in settings, false);
  assert.equal('largeImageKey' in settings, false);
  assert.equal('largeImageText' in settings, false);
});

test('sanitizeSettings keeps boolean fields', () => {
  const settings = sanitizeSettings({
    showProject: false,
    showModel: false,
    showElapsed: false,
    clearWhenIdle: true,
  });
  assert.equal(settings.showProject, false);
  assert.equal(settings.showModel, false);
  assert.equal(settings.showElapsed, false);
  assert.equal(settings.showTokens, true);
  assert.equal(settings.showCost, false);
  assert.equal(settings.clearWhenIdle, true);
});

test('model labels are friendly but preserve versions', () => {
  assert.equal(formatModelName({ id: 'qwen3.5' }), 'Qwen3.5');
  assert.equal(formatModelName({ id: 'deepseek-v4.1-flash' }), 'DeepSeek V4.1 Flash');
  assert.equal(formatModelName({ id: 'claude-sonnet-4-5' }), 'Claude Sonnet 4.5');
  assert.equal(formatModelName({ id: 'gpt-5.1-codex' }), 'GPT-5.1 Codex');
  assert.equal(formatModelName({ id: 'gemini-2.5-pro' }), 'Gemini 2.5 Pro');
  assert.equal(formatModelName({ id: 'deepseek/deepseek-v4.1-flash-1017' }), 'DeepSeek V4.1 Flash 1017');
  assert.equal(formatModelName({ id: 'claude-sonnet-4-5-20251101' }), 'Claude Sonnet 4.5');
  assert.equal(formatModelName({ id: '' }), null);
  assert.equal(formatModelName(null), null);
});

test('parseModel accepts the host provider/model form', () => {
  assert.deepEqual(parseModel('openrouter/deepseek/deepseek-v4.1-flash-1017'), {
    providerID: 'openrouter',
    id: 'deepseek/deepseek-v4.1-flash-1017',
  });
  assert.deepEqual(parseModel('qwen3.5'), { id: 'qwen3.5' });
  assert.deepEqual(parseModel({ id: 'x', providerID: 'p', variant: 'default' }), {
    id: 'x',
    providerID: 'p',
    variant: 'default',
  });
  assert.equal(parseModel(null), null);
});

test('project names come from folders and chats get a friendly label', () => {
  assert.equal(projectNameFromDirectory('/home/me/Projects/MyGame/'), 'MyGame');
  assert.equal(projectNameFromDirectory('C:\\Projects\\MyGame'), 'MyGame');
  assert.equal(
    projectNameFromDirectory('/home/me/.config/openchamber/chats/2026-11-14/session-e76e6928-ca50'),
    'OpenChamber Chat',
  );
  assert.equal(projectNameFromDirectory('/home/me/.config/openchamber/chats/tmp/session-1234abcd'), 'OpenChamber Chat');
  assert.equal(projectNameFromDirectory(null), null);
  assert.equal(projectNameFromDirectory(''), null);
});

test('working presence matches the profile example', () => {
  const copy = buildPresenceCopy(DEFAULT_SETTINGS, session());
  assert.equal(copy.details, 'Working on MyGame');
  assert.equal(copy.state, 'Coding with Qwen3.5');
  assert.equal(copy.startedAt, 1_700_000_000_000);
  assert.equal(copy.largeImageKey, 'openchamber');
  assert.equal(copy.largeImageText, 'OpenChamber AI Coding');
});

test('idle and empty sessions use honest fallbacks', () => {
  const idle = buildPresenceCopy(DEFAULT_SETTINGS, session({ working: false }));
  assert.equal(idle.state, 'Idle · Qwen3.5');

  const empty = buildPresenceCopy(DEFAULT_SETTINGS, session({
    hasSession: false,
    working: false,
    projectName: null,
    modelName: null,
    startedAt: null,
  }));
  assert.equal(empty.details, 'OpenChamber AI Coding');
  assert.equal(empty.state, 'Ready');
  assert.equal(empty.startedAt, null);

  const hiddenModel = buildPresenceCopy({ ...DEFAULT_SETTINGS, showModel: false }, session());
  assert.equal(hiddenModel.state, 'Using OpenChamber');
});

test('token and cost stats are compact and optional', () => {
  assert.equal(formatTokenCount(null), null);
  assert.equal(formatTokenCount(0), null);
  assert.equal(formatTokenCount(999), '999 tokens');
  assert.equal(formatTokenCount(1_000), '1k tokens');
  assert.equal(formatTokenCount(12_345), '12.3k tokens');
  assert.equal(formatTokenCount(123_456), '123k tokens');
  assert.equal(formatTokenCount(1_234_567), '1.2M tokens');
  assert.equal(formatTokenCount(12_345_678), '12M tokens');
  assert.equal(formatCost(null), null);
  assert.equal(formatCost(0), null);
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(0.42), '$0.42');
  assert.equal(formatCost(2.196), '$2.20');
});

test('session tokens sit on the project row and cost stays on the model row', () => {
  const stats = session({ tokens: 12_345, cost: 0.42 });
  const withTokens = buildPresenceCopy(DEFAULT_SETTINGS, stats);
  assert.equal(withTokens.details, 'Working on MyGame · 12.3k tokens');
  assert.equal(withTokens.state, 'Coding with Qwen3.5');

  const withCost = buildPresenceCopy({ ...DEFAULT_SETTINGS, showCost: true }, stats);
  assert.equal(withCost.details, 'Working on MyGame · 12.3k tokens');
  assert.equal(withCost.state, 'Coding with Qwen3.5 · $0.42');

  const hidden = buildPresenceCopy(
    { ...DEFAULT_SETTINGS, showTokens: false, showCost: false },
    stats,
  );
  assert.equal(hidden.details, 'Working on MyGame');
  assert.equal(hidden.state, 'Coding with Qwen3.5');

  const idle = buildPresenceCopy(
    { ...DEFAULT_SETTINGS, showCost: true },
    session({ tokens: 12_345, cost: 0.42, working: false }),
  );
  assert.equal(idle.details, 'Working on MyGame · 12.3k tokens');
  assert.equal(idle.state, 'Idle · Qwen3.5 · $0.42');
});

test('custom stats placeholders suppress the duplicate state suffix', () => {
  const stats = session({ tokens: 12_345, cost: 0.42 });
  const detailsOnly = buildPresenceCopy(
    {
      ...DEFAULT_SETTINGS,
      showCost: true,
      customActivity: 'Working on {project} · {tokens}',
    },
    stats,
  );
  assert.equal(detailsOnly.details, 'Working on MyGame · 12.3k tokens');
  assert.equal(detailsOnly.state, 'Coding with Qwen3.5 · $0.42');

  const both = buildPresenceCopy(
    {
      ...DEFAULT_SETTINGS,
      showCost: true,
      customActivity: '{tokens} · {cost} · {project}',
    },
    stats,
  );
  assert.equal(both.details, '12.3k tokens · $0.42 · MyGame');
  assert.equal(both.state, 'Coding with Qwen3.5');
});

test('stats are not shown without a session', () => {
  const copy = buildPresenceCopy(
    { ...DEFAULT_SETTINGS, showCost: true },
    session({ hasSession: false, tokens: 12_345, cost: 0.42, working: false }),
  );
  assert.equal(copy.details, 'OpenChamber AI Coding');
  assert.equal(copy.state, 'Ready');
});

test('custom activity respects placeholders and the show/hide toggles', () => {
  const custom = buildPresenceCopy(
    { ...DEFAULT_SETTINGS, customActivity: 'Building {project} with {model} in {app}' },
    session(),
  );
  assert.equal(custom.details, 'Building MyGame with Qwen3.5 in OpenChamber');

  const hidden = buildPresenceCopy(
    {
      ...DEFAULT_SETTINGS,
      customActivity: 'Building {project} with {model}',
      showProject: false,
      showModel: false,
    },
    session(),
  );
  assert.equal(hidden.details, 'Building with');

  const noElapsed = buildPresenceCopy({ ...DEFAULT_SETTINGS, showElapsed: false }, session());
  assert.equal(noElapsed.startedAt, null);
});

test('activity shape includes the logo and timestamp only when requested', () => {
  const copy = buildPresenceCopy(DEFAULT_SETTINGS, session());
  const activity = activityFromCopy(copy);
  assert.equal(activity.type, 0);
  assert.equal(activity.details, 'Working on MyGame');
  assert.equal(activity.state, 'Coding with Qwen3.5');
  assert.deepEqual(activity.timestamps, { start: 1_700_000_000_000 });
  assert.deepEqual(activity.assets, {
    large_image: 'openchamber',
    large_text: 'OpenChamber AI Coding',
  });

  const withoutAssets = activityFromCopy({
    ...copy,
    largeImageKey: '',
  });
  assert.equal('assets' in withoutAssets, false);
});

test('desiredActivity clears when disabled or cleared, but keeps a disabled copy out', () => {
  assert.equal(desiredActivity({ ...DEFAULT_SETTINGS, enabled: false }, session(), false), null);
  assert.equal(desiredActivity(DEFAULT_SETTINGS, session(), true), null);
  assert.notEqual(desiredActivity(DEFAULT_SETTINGS, session(), false), null);
});

test('activity text is clamped below Discord limits', () => {
  const copy = buildPresenceCopy({ ...DEFAULT_SETTINGS, customActivity: 'x'.repeat(200) }, session());
  assert.equal(copy.details.length, 128);
  assert.ok(copy.details.endsWith('…'));
});

test('elapsed labels are compact and stable', () => {
  assert.equal(elapsedLabel(null, 0), '');
  assert.equal(elapsedLabel(1_000, 62_000), '1:01 elapsed');
  assert.equal(elapsedLabel(0, 3_661_000), '1:01:01 elapsed');
});
