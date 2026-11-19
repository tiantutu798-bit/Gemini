import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { backendHarness } from './backend-harness.mjs';
import {
  extractContextBreakdown,
  extractLiveActivity,
  extractModelSteps,
  normalizeCachedStep,
} from '../trajectory-metrics.mjs';
import {
  formatCountdown,
  formatUsd,
  speedReasonText,
} from '../src/core/formatters.js';
import { createReactiveStore } from '../src/core/reactive.js';
import { buildBundle, stripModuleSyntax } from '../scripts/build-bundle.mjs';

const nowMs = Date.now();
const nowIso = new Date(nowMs - 5_000).toISOString();
const doneIso = new Date(nowMs - 3_000).toISOString();
const promoMs = Date.parse('2026-11-17T12:00:00Z');
const promoNowIso = new Date(promoMs - 5_000).toISOString();
const promoDoneIso = new Date(promoMs - 3_000).toISOString();

test('BUG-01 & INCON-01: Google-proxied Claude/GPT/o-series never misclassify as Gemini, and M429/M322/M149/M20 resolve accurately', () => {
  const h = backendHarness({
    clock: () => promoMs,
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelOrAlias: { model: 'MODEL_CLAUDE_PROXY' },
            label: 'Claude Opus 4.6 (Google Vertex)',
            quotaInfo: { remainingFraction: 0.75, resetTime: new Date(nowMs + 3600_000).toISOString() },
          },
        ],
      },
    },
  });

  const infoClaude = h.resolveModelInfo('claude-opus-4-6', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(infoClaude.family, 'Claude');
  const infoO3 = h.resolveModelInfo('o3-mini', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(infoO3.family, 'GPT');

  // Calling resolveModelInfo with omitted dynamicModelMap must not throw (BUG-03)
  const infoDefaultMap = h.resolveModelInfo('MODEL_PLACEHOLDER_M320');
  assert.equal(infoDefaultMap.modelId, 'gemini-3.8-flash-low');
  assert.equal(infoDefaultMap.pricing?.input, 0.3);

  const m429 = h.resolveModelInfo('MODEL_PLACEHOLDER_M429', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m429.modelId, 'gemini-4-carbon-high');
  assert.equal(m429.shortName, 'carbon-4-high');

  const m322 = h.resolveModelInfo('MODEL_PLACEHOLDER_M322', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m322.modelId, 'gemini-3.8-flash-tiered');
  assert.equal(
    h.computeStepCost(
      {
        modelKey: 'MODEL_PLACEHOLDER_M322',
        inputTokens: 1_000_000,
        cacheReadTokens: 0,
        outputTokens: 0,
      },
      m322.pricing
    ),
    0.75
  );

  const m149 = h.resolveModelInfo('MODEL_PLACEHOLDER_M149', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m149.modelId, 'gemini-3.5-flash-high');

  const m20 = h.resolveModelInfo('MODEL_PLACEHOLDER_M20', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m20.modelId, 'gemini-3.5-flash');

  // Gemini Hydrogen ($1.50/$0.075/$7.50) & Helix ($0.30/$0.015/$2.50), shared Gemini pool
  const dynHydrogenMap = new Map([
    ['MODEL_PLACEHOLDER_M480', { modelId: '', label: 'Gemini 4 Hydrogen (High)' }],
    ['MODEL_PLACEHOLDER_M481', { modelId: '', label: 'Gemini 4 Hydrogen (Low)' }],
    ['MODEL_PLACEHOLDER_M482', { modelId: '', label: 'Gemini 4 Helix' }],
  ]);
  const hydroHigh = h.resolveModelInfo('MODEL_PLACEHOLDER_M480', dynHydrogenMap);
  assert.equal(hydroHigh.family, 'Gemini');
  assert.equal(hydroHigh.shortName, 'hydrogen-4-high');
  assert.deepEqual(
    { i: hydroHigh.pricing?.input, c: hydroHigh.pricing?.cache, o: hydroHigh.pricing?.output },
    { i: 1.5, c: 0.075, o: 7.5 }
  );
  const hydroLow = h.resolveModelInfo('MODEL_PLACEHOLDER_M481', dynHydrogenMap);
  assert.equal(hydroLow.shortName, 'hydrogen-4-low');
  assert.deepEqual(
    { i: hydroLow.pricing?.input, c: hydroLow.pricing?.cache, o: hydroLow.pricing?.output },
    { i: 1.5, c: 0.075, o: 7.5 }
  );
  const hydroCodename = h.resolveModelInfo('gemini-hydrogen');
  assert.equal(hydroCodename.family, 'Gemini');
  assert.equal(hydroCodename.label, 'Gemini Hydrogen');
  assert.equal(hydroCodename.pricing?.input, 1.5);
  assert.equal(hydroCodename.pricing?.output, 7.5);

  const helixInfo = h.resolveModelInfo('MODEL_PLACEHOLDER_M482', dynHydrogenMap);
  assert.equal(helixInfo.family, 'Gemini');
  assert.equal(helixInfo.shortName, 'helix-4');
  assert.deepEqual(
    { i: helixInfo.pricing?.input, c: helixInfo.pricing?.cache, o: helixInfo.pricing?.output },
    { i: 0.3, c: 0.015, o: 2.5 }
  );
  const helixCodename = h.resolveModelInfo('gemini-helix');
  assert.equal(helixCodename.family, 'Gemini');
  assert.equal(helixCodename.label, 'Gemini Helix');
  assert.equal(helixCodename.pricing?.output, 2.5);

  const { quotaPoolsMap } = h.buildOfficialQuotaPools(null, [
    {
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M480' },
      label: 'Gemini 4 Hydrogen (High)',
      quotaInfo: { remainingFraction: 0.8, resetTime: new Date(nowMs + 3600_000).toISOString() },
    },
    {
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M482' },
      label: 'Gemini 4 Helix',
      quotaInfo: { remainingFraction: 0.8, resetTime: new Date(nowMs + 3600_000).toISOString() },
    },
  ]);
  assert.equal(quotaPoolsMap.has('Hydrogen'), false, 'Hydrogen has no dedicated quota pool');
  assert.equal(quotaPoolsMap.has('Helix'), false, 'Helix has no dedicated quota pool');
  assert.equal(quotaPoolsMap.get('Gemini')?.isAvailable, true);
});

test('BUG-02 & BUG-11: ide:<uuid> external sessions do not double-count live conversations, only quota pools isolate cross-account entries, and orphan subagents never leak to top-level list', async () => {
  const reset5hIso = new Date(Date.now() + 4 * 3600_000).toISOString();
  const resetWkIso = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();
  const stepObj = {
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 1 },
      createdAt: nowIso,
      completedAt: doneIso,
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: '10000',
        cacheReadTokens: '20000',
        outputTokens: '5000',
      },
    },
  };
  const h = backendHarness({
    userStatus: { email: 'alice@example.com' },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: reset5hIso },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.95, resetTime: resetWkIso },
          ],
        },
      ],
    },
    deepStats: {
      accountName: 'alice@example.com',
      perConvo: {
        // Same conversation ID as live 'abcd-1234' (case-insensitive, prefixed with 'ide:') -> must deduplicate!
        'ide:AbCd-1234': {
          accountName: 'alice@example.com',
          appSource: 'ide',
          entries: [
            { ts: nowIso, model: 'MODEL_PLACEHOLDER_M318', inp: 10000, cache: 20000, out: 5000, reasoning: 0 },
            { ts: doneIso, model: 'MODEL_PLACEHOLDER_M318', inp: 10000, cache: 20000, out: 5000, reasoning: 0 },
          ],
        },
        // Different account -> retained in global consumption, isolated out of Alice's quota pools!
        'ide:bob-conv': {
          accountName: 'bob@example.com',
          appSource: 'ide',
          entries: [
            { ts: nowIso, model: 'MODEL_PLACEHOLDER_M318', inp: 99000, cache: 0, out: 1000, reasoning: 0 },
          ],
        },
      },
    },
    cache: {
      'orphan-sub': {
        accountName: 'bob@example.com',
        isSubagent: true,
        parentCascadeId: 'deleted-parent',
        signature: 'v10-model-identity:sub',
        steps: extractModelSteps([stepObj]),
      },
    },
    summaries: {
      'abcd-1234': { stepCount: 1, lastModifiedTime: doneIso, status: 'IDLE' },
    },
    trajectories: {
      'abcd-1234': { trajectory: { steps: [stepObj] } },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('abcd-1234', false, { range: 'all' });
  // ide:AbCd-1234 (70k) deduplicates live abcd-1234 (35k); global consumption retains ide:bob-conv (100k) + orphan-sub (35k)
  assert.equal(p.consumption.account.conversationsCount, 3);
  assert.equal(p.consumption.account.calls, 4);
  assert.equal(p.consumption.account.totalTokens, 205_000);
  // Quota pools & weekly cycle strictly isolate to alice@example.com (2 calls = 70,000 tokens)
  const geminiPool = p.quotas.pools.find((pool) => pool.poolKey === 'Gemini');
  assert.equal(geminiPool.cycle5h.calls, 2);
  assert.equal(geminiPool.cycle5h.tokens, 70_000);
  assert.equal(geminiPool.cycleWeekly.calls, 2);
  assert.equal(geminiPool.cycleWeekly.tokens, 70_000);
  assert.equal(p.quotas.weekly.calls, 2);
  assert.equal(p.quotas.weekly.tokens, 70_000);
  assert.equal(
    p.conversations.some((c) => c.cascadeId === 'orphan-sub'),
    false,
    'orphan subagent must not appear in top-level conversation dropdown'
  );
});

test('account switch preserves conversation list, locked session steps, and consumption history while isolating quota pools per step across mid-conversation switches', async () => {
  const baseMs = Date.now() - 60_000;
  const reset5hIso = new Date(baseMs + 4 * 3600_000).toISOString();
  const resetWkIso = new Date(baseMs + 6 * 24 * 3600_000).toISOString();
  const makeStepAt = (idx, inTok, outTok, offsetMs) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: idx },
      createdAt: new Date(baseMs + offsetMs).toISOString(),
      completedAt: new Date(baseMs + offsetMs + 1000).toISOString(),
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: String(inTok),
        cacheReadTokens: '0',
        outputTokens: String(outTok),
      },
    },
  });
  const makeQuota = (rem5h, remWk) => ({
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: rem5h, resetTime: reset5hIso },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: remWk, resetTime: resetWkIso },
        ],
      },
    ],
  });

  const sharedStep1 = makeStepAt(1, 25_000, 5_000, 1_000); // 30,000
  const sharedStep2 = makeStepAt(2, 25_000, 5_000, 3_000); // 30,000
  const aliceOldStep = makeStepAt(1, 35_000, 5_000, 5_000); // 40,000

  const h = backendHarness({
    userStatus: { email: 'alice@example.com', userTier: { name: 'Google AI Ultra' } },
    quotaSummary: makeQuota(0.8, 0.9),
    summaries: {
      'conv-shared': {
        stepCount: 2,
        lastModifiedTime: new Date(baseMs + 4_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Greeting and Hello' },
      },
      'conv-alice-old': {
        stepCount: 1,
        lastModifiedTime: new Date(baseMs + 6_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Earlier Alice Session' },
      },
    },
    trajectories: {
      'conv-shared': { trajectory: { steps: [sharedStep1, sharedStep2] } },
      'conv-alice-old': { trajectory: { steps: [aliceOldStep] } },
    },
  });

  // 1. Initial state under Alice: 3 calls = 100,000 tokens in both consumption and Alice's quota pools
  const pAlice = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pAlice.conversations.length, 2);
  assert.equal(pAlice.activeConversation.cascadeId, 'conv-shared');
  assert.equal(pAlice.activeConversation.stepCount, 2);
  assert.equal(pAlice.consumption.account.calls, 3);
  assert.equal(pAlice.consumption.account.totalTokens, 100_000);
  assert.equal(pAlice.quotas.weekly.calls, 3);
  assert.equal(pAlice.quotas.weekly.tokens, 100_000);

  // 2. Switch to Bob and create 1 new step (15,900 tokens) in conv-bob while keeping conv-shared locked
  const bobStep1 = makeStepAt(1, 15_552, 348, 10_000); // 15,900
  h.state.userStatus = { email: 'bob@example.com', userTier: { name: 'Google AI Ultra' } };
  h.state.quotaSummary = makeQuota(0.977, 0.994);
  h.state.summaries['conv-bob'] = {
    stepCount: 1,
    lastModifiedTime: new Date(baseMs + 11_000).toISOString(),
    status: 'IDLE',
    annotations: { title: 'New Bob Session' },
  };
  h.state.trajectories['conv-bob'] = { trajectory: { steps: [bobStep1] } };

  const pBob = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pBob.conversations.length, 3, 'All historical conversations remain visible after account switch');
  assert.equal(pBob.activeConversation.cascadeId, 'conv-shared', 'Locked conversation stays selected');
  assert.equal(pBob.activeConversation.stepCount, 2, 'Step details of locked conversation are preserved');
  assert.equal(pBob.consumption.account.calls, 4, 'Global consumption retains all 4 calls across accounts');
  assert.equal(pBob.consumption.account.totalTokens, 115_900);
  const bobGemini = pBob.quotas.pools.find((pool) => pool.poolKey === 'Gemini');
  assert.equal(bobGemini.cycle5h.calls, 1, 'Quota 5h isolates strictly to Bob');
  assert.equal(bobGemini.cycle5h.tokens, 15_900);
  assert.equal(bobGemini.cycleWeekly.tokens, 15_900);
  assert.equal(pBob.quotas.weekly.calls, 1);
  assert.equal(pBob.quotas.weekly.tokens, 15_900);

  // 3. Continue chatting inside conv-shared while logged in as Bob (step #3 = 25,000 tokens)
  const sharedStep3ByBob = makeStepAt(3, 24_000, 1_000, 20_000); // 25,000
  h.state.summaries['conv-shared'] = {
    ...h.state.summaries['conv-shared'],
    stepCount: 3,
    lastModifiedTime: new Date(baseMs + 21_000).toISOString(),
  };
  h.state.trajectories['conv-shared'] = {
    trajectory: { steps: [sharedStep1, sharedStep2, sharedStep3ByBob] },
  };

  const pBobContinued = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pBobContinued.activeConversation.stepCount, 3);
  assert.equal(pBobContinued.consumption.account.calls, 5);
  assert.equal(pBobContinued.consumption.account.totalTokens, 140_900);
  const bobGeminiAfter = pBobContinued.quotas.pools.find((pool) => pool.poolKey === 'Gemini');
  assert.equal(bobGeminiAfter.cycle5h.calls, 2, 'Bob quota includes conv-bob + his new step #3 in conv-shared');
  assert.equal(bobGeminiAfter.cycle5h.tokens, 40_900);
  assert.equal(pBobContinued.quotas.weekly.calls, 2);
  assert.equal(pBobContinued.quotas.weekly.tokens, 40_900);

  // 4. Switch back to Alice -> Alice quota remains strictly her 3 calls (100,000 tokens)
  h.state.userStatus = { email: 'alice@example.com', userTier: { name: 'Google AI Ultra' } };
  h.state.quotaSummary = makeQuota(0.8, 0.9);
  const pAliceBack = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pAliceBack.consumption.account.calls, 5);
  assert.equal(pAliceBack.consumption.account.totalTokens, 140_900);
  assert.equal(pAliceBack.quotas.weekly.calls, 3);
  assert.equal(pAliceBack.quotas.weekly.tokens, 100_000);
});

test('BUG-03, BUG-12 & BUG-16: negative/NaN token sanitization, deferred costUsd rounding, and dynamicModelMap default', async () => {
  const badStep = {
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 1 },
      createdAt: nowIso,
      completedAt: doneIso,
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: '-5000',
        cacheReadTokens: 'NaN',
        outputTokens: '1000',
        thinkingOutputTokens: '2500',
      },
    },
  };
  const extracted = extractModelSteps([badStep]);
  assert.equal(extracted[0].inputTokens, 0);
  assert.equal(extracted[0].cacheReadTokens, 0);
  assert.equal(extracted[0].outputTokens, 1000);
  assert.equal(extracted[0].thinkingTokens, 1000);
  assert.equal(extracted[0].responseTokens, 0);
  assert.equal(normalizeCachedStep({ ...extracted[0], inputTokens: -99 }).inputTokens, 0);
  assert.equal(normalizeCachedStep(null), null);

  // Micro-steps: 100 steps * (1067 output * $3.75 / 1M = $0.00400125) = $0.40 (previously rounded per-step to $0.00 -> $0.00!)
  const microSteps = Array.from({ length: 100 }, (_, idx) => ({
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: idx + 1 },
      createdAt: promoNowIso,
      completedAt: promoDoneIso,
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318', // gemini-3.8-flash-high: $0.75/1M input, $3.75/1M output
        inputTokens: '0',
        cacheReadTokens: '0',
        outputTokens: '1067',
      },
    },
  }));
  const h = backendHarness({
    clock: () => promoMs,
    summaries: { micro: { stepCount: 100, lastModifiedTime: promoDoneIso, status: 'IDLE' } },
    trajectories: { micro: { trajectory: { steps: microSteps } } },
  });
  const p = await h.buildTelemetryPayloadInternal('micro', false, { range: 'today' });
  assert.equal(p.consumption.account.costUsd, 0.4);
});

test('BUG-04 & BUG-10: failed RUNNING trajectory fetch enters cooldown instead of hammering RPC every poll, cleared by forceRefresh', async () => {
  const h = backendHarness({
    summaries: { run1: { stepCount: 2, lastModifiedTime: doneIso, status: 'CASCADE_RUN_STATUS_RUNNING' } },
    trajectories: { run1: new Error('LS timeout') },
    quotaSummary: new Error('Quota RPC down'),
  });

  await h.buildTelemetryPayloadInternal('run1', false);
  const callsAfterFirst = h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length;
  const quotaCallsAfterFirst = h.state.calls.filter((c) => c.method === 'RetrieveUserQuotaSummary').length;
  assert.equal(callsAfterFirst, 1);
  assert.equal(quotaCallsAfterFirst, 1);

  // Immediate second background poll must respect cooldown for both trajectory and quota RPC
  await h.buildTelemetryPayloadInternal('run1', false);
  assert.equal(h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length, 1);
  assert.equal(h.state.calls.filter((c) => c.method === 'RetrieveUserQuotaSummary').length, 1);

  // Manual forceRefresh=true bypasses cooldown immediately
  await h.buildTelemetryPayloadInternal('run1', true);
  assert.equal(h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length, 2);
  assert.equal(h.state.calls.filter((c) => c.method === 'RetrieveUserQuotaSummary').length, 2);
});

test('BUG-09, BUG-14 & BUG-15: SemVer 2.0 prerelease/build ordering, future-only exhausted quota inference, and <6h dual-bucket classification', async () => {
  const h = backendHarness({
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            {
              // Omitted remainingFraction with epoch-0 resetTime must NOT falsely report 0% remaining!
              resetTime: '1970-01-01T00:00:00Z',
            },
          ],
        },
        {
          displayName: 'Claude & GPT',
          buckets: [
            {
              remainingFraction: 0.4,
              resetTime: new Date(nowMs + 2 * 3600_000).toISOString(),
            },
            {
              remainingFraction: 0.8,
              // Weekly bucket that happens to be 4h away from resetting!
              resetTime: new Date(nowMs + 4 * 3600_000).toISOString(),
            },
          ],
        },
      ],
    },
  });

  assert.equal(h.compareSemver('1.4.2+20261110', '1.4.2'), 0);
  assert.equal(h.compareSemver('1.5.0-beta.2', '1.5.0-alpha.10'), 1);
  assert.equal(h.compareSemver('1.5.0-alpha.1', '1.5.0-alpha.beta'), -1);

  const p = await h.buildTelemetryPayloadInternal('');
  const geminiPool = p.quotas.pools.find((x) => x.poolKey === 'Gemini');
  assert.ok(geminiPool);
  assert.equal(geminiPool.isAvailable, false, 'epoch-0 omitted remainingFraction must not create fake 0% exhausted pool');
  assert.equal(geminiPool.remainingPct, null);
  assert.equal(geminiPool.usedPct, null);

  const claudePool = p.quotas.pools.find((x) => x.poolKey === 'Claude & GPT');
  assert.ok(claudePool);
  assert.equal(claudePool.remainingPct, 40);
  assert.equal(claudePool.weeklyRemainingPct, 80);

  assert.equal(formatCountdown(new Date(nowMs + 30_000).toISOString(), nowMs), '<1分钟后重置');
  assert.equal(formatCountdown('1969-12-31T23:59:59Z', nowMs), '未知重置时间');
  assert.equal(formatUsd(0.0004, { precise: true }), '<$0.001');
  assert.equal(formatUsd(12.34, { unpricedCalls: 1, compactPending: true }), '$12.34');
  assert.equal(speedReasonText('short_timing'), '耗时过短 (<0.5s)');
});

test('BUG-17 & CANCEL-06: extractContextBreakdown classifies messagePrompts when children are empty and blocks post-compaction carryover', () => {
  const ctx = extractContextBreakdown({
    chatStartMetadata: {
      contextWindowMetadata: {
        estimatedTokensUsed: 10000,
        tokenBreakdown: {
          groups: [
            { type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 2000 },
            { type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 8000, children: [] },
          ],
        },
      },
    },
    messagePrompts: [
      { source: 'CHAT_MESSAGE_SOURCE_USER', prompt: '<USER_REQUEST>hello world</USER_REQUEST>' },
      { source: 'CHAT_MESSAGE_SOURCE_MODEL', prompt: 'Assistant reply content here!' },
    ],
  });
  assert.ok(ctx);
  assert.equal(ctx.systemPromptTokens, 2000);
  assert.ok(ctx.userInputTokens > 0);
  assert.ok(ctx.assistantTokens > 0);
  assert.equal(ctx.userInputTokens + ctx.assistantTokens, 8000);

  const stepsWithTrailingCheckpoint = extractModelSteps(
    [
      {
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          sourceTrajectoryStepInfo: { stepIndex: 1 },
          createdAt: nowIso,
          completedAt: doneIso,
          modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: '180000', outputTokens: '500' },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          sourceTrajectoryStepInfo: { stepIndex: 2 },
          createdAt: nowIso,
          completedAt: doneIso,
          modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: '180000', outputTokens: '1200' },
        },
      },
    ],
    [
      {
        stepIndices: [1],
        chatModel: {
          chatStartMetadata: {
            contextWindowMetadata: {
              estimatedTokensUsed: 180_000,
              tokenBreakdown: {
                groups: [{ type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 180_000 }],
              },
            },
          },
        },
      },
    ]
  );
  assert.equal(stepsWithTrailingCheckpoint.length, 2);
  assert.equal(stepsWithTrailingCheckpoint[1].isCompactionStep, true);
  assert.equal(
    stepsWithTrailingCheckpoint[1].contextBreakdown,
    null,
    'compaction checkpoint must not inherit pre-compaction 180k contextBreakdown'
  );
});

test('BUG-20 & BUG-24: reactive store microtask deduplication, stripModuleSyntax safety, and IIFE bundle isolation', async () => {
  const store = createReactiveStore({ a: 1, b: 2 });
  let calls = 0;
  store.subscribe((s) => s.a + s.b, () => {
    calls += 1;
  }, { immediate: false });

  store.setState({ a: 10 });
  store.setState({ b: 20 });
  await new Promise((r) => queueMicrotask(r));
  assert.equal(calls, 1, 'multiple setState calls in same microtask must batch into 1 subscriber flush');

  const trickyModule = [
    "import './side-effect.js';",
    "import { foo,\n  bar } from './multi.js';",
    'const tpl = `\nimport { keepMe } from "tpl";\nexport const KEEP_ME = 42;\n`;',
    'export async function runTask() { return tpl; }',
    'export { runTask };',
  ].join('\n');

  const stripped = stripModuleSyntax(trickyModule);
  assert.ok(stripped.includes('import { keepMe } from "tpl"'));
  assert.ok(stripped.includes('export const KEEP_ME = 42'));
  assert.equal(/^\s*import\s/m.test(stripped.replace(/`[\s\S]*?`/g, '')), false);
  assert.doesNotThrow(() => new vm.Script(stripped));

  const appBundle = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appBundle.startsWith('(() => {\n\'use strict\';'));
  assert.ok(appBundle.trimEnd().endsWith('})();'));
});

test('bundle validation rejects incompatible imports and duplicate bindings before touching output', (t) => {
  const tempDir = fs.mkdtempSync(fileURLToPath(new URL('./.bundle-test-', import.meta.url)));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  for (const dir of ['src', 'shared']) {
    fs.cpSync(new URL(`../${dir}/`, import.meta.url), join(tempDir, dir), { recursive: true });
  }
  const outputs = ['app.js', 'styles.css', 'index.html'];
  for (const file of outputs) fs.writeFileSync(join(tempDir, file), file);

  const iconSource = join(tempDir, 'src', 'icons', 'svgRegistry.js');
  const original = fs.readFileSync(iconSource, 'utf8');
  for (const [prefix, error] of [
    ["import { SVG_NS /* comment */ as ns } from './SvgIcon.js';", /svgRegistry\.js.*without aliases/],
    ["import { SVG_NS } from './SvgIcon.js';", /svgRegistry\.js.*SvgIcon\.js.*earlier in jsOrder/],
    ["import './missing.js';", /svgRegistry\.js.*missing\.js.*earlier in jsOrder/],
    ['export const SVG_NS = "duplicate";', /Identifier 'SVG_NS' has already been declared/],
  ]) {
    fs.writeFileSync(iconSource, `${prefix}\n${original}`);
    assert.throws(() => buildBundle(tempDir), error);
    for (const file of outputs) {
      assert.equal(fs.readFileSync(join(tempDir, file), 'utf8'), file);
    }
  }

  // Per-module closure isolation: unexported private identifiers never collide across modules
  fs.writeFileSync(iconSource, `const SVG_NS = "private_local";\n${original}`);
  assert.doesNotThrow(() => buildBundle(tempDir));
});

test('Compaction liveActivity: detects in-progress & completed CHECKPOINT over pre-compaction tool operations across RPC and transcript.jsonl', async () => {
  const convId = '4432b724-3e1e-4421-a375-c6855a7b7b37';

  // Pre-compaction steps (matching real-world step 0..2: planner edit_file x2 + 2 completed tool results)
  const rpcPreCompactionSteps = [
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: '2026-11-11T02:18:21Z',
        finishedGeneratingAt: '2026-11-11T02:18:35Z',
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: '2918',
          cacheReadTokens: '252465',
          outputTokens: '814',
        },
      },
      plannerResponse: {
        toolCalls: [
          { name: 'edit_file', argumentsJson: JSON.stringify({ Path: 'f:/repo/backend-harness.mjs' }) },
          { name: 'edit_file', argumentsJson: JSON.stringify({ Path: 'f:/repo/04-post-fix-verify.mjs' }) },
        ],
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-11T02:18:35Z', completedAt: '2026-11-11T02:18:38Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-11T02:18:35Z', completedAt: '2026-11-11T02:18:40Z' },
    },
  ];

  // transcript.jsonl still ends at step_index 2 (since CHECKPOINT only flushes to transcript.jsonl when DONE)
  const transcriptPreFlush = [
    {
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-11T02:18:21Z',
      tool_calls: [
        { name: 'edit_file', args: { Path: '"f:\\\\repo\\\\backend-harness.mjs"' } },
        { name: 'edit_file', args: { Path: '"f:\\\\repo\\\\04-post-fix-verify.mjs"' } },
      ],
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-11T02:18:35Z',
      content: 'Created At: 2026-11-11T11:18:35+09:00\nCompleted At: 2026-11-11T11:18:38+09:00\nMade 1 replacement',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-11T02:18:35Z',
      content: 'Created At: 2026-11-11T11:18:35+09:00\nCompleted At: 2026-11-11T11:18:40+09:00\nMade 1 replacement',
    },
  ];

  // Phase 1: In-progress CORTEX_STEP_TYPE_CHECKPOINT in RPC WITHOUT metadata.createdAt yet + trailing MEMENTO
  const h = backendHarness({
    summaries: {
      [convId]: {
        stepCount: 4,
        lastModifiedTime: '2026-11-11T02:18:35Z',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        annotations: { title: 'Audit & Fix Session' },
      },
    },
    trajectories: {
      [convId]: {
        trajectory: {
          steps: [
            ...rpcPreCompactionSteps,
            {
              type: 'CORTEX_STEP_TYPE_CHECKPOINT',
              status: 'CORTEX_STEP_STATUS_RUNNING',
              metadata: {},
            },
            {
              type: 'CORTEX_STEP_TYPE_MEMENTO',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { createdAt: '2026-11-11T02:18:40Z' },
            },
          ],
        },
      },
    },
    transcripts: {
      [convId]: transcriptPreFlush,
    },
  });

  const pCompacting = await h.buildTelemetryPayloadInternal(convId);
  assert.equal(pCompacting.activeConversation.liveActivity.phase, 'compacting');
  assert.equal(pCompacting.activeConversation.liveActivity.label, '上下文压缩');
  assert.equal(
    pCompacting.activeConversation.liveActivity.startedAtMs,
    Date.parse('2026-11-11T02:18:40Z'),
    'uses previous tool completion timestamp when in-progress CHECKPOINT lacks createdAt'
  );
  assert.equal(pCompacting.runningConversations[0].mainActivity.phase, 'compacting');
  assert.equal(pCompacting.runningConversations[0].mainActivity.label, '上下文压缩');

  // Phase 2: CHECKPOINT finishes (status=DONE in both RPC & transcript.jsonl) while resuming before next PLANNER_RESPONSE
  h.state.trajectories[convId] = {
    trajectory: {
      steps: [
        ...rpcPreCompactionSteps,
        {
          type: 'CORTEX_STEP_TYPE_CHECKPOINT',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            createdAt: '2026-11-11T02:18:40Z',
            finishedGeneratingAt: '2026-11-11T02:19:33Z',
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M318',
              inputTokens: '3082',
              cacheReadTokens: '254224',
              outputTokens: '4627',
            },
          },
        },
      ],
    },
  };
  h.state.transcripts[convId] = [
    ...transcriptPreFlush,
    {
      step_index: 3,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      created_at: '2026-11-11T02:18:40Z',
      content: '# Resuming from a compaction\n...',
    },
  ];
  h.state.transcriptMtimeMs = 2;

  const pResuming = await h.buildTelemetryPayloadInternal(convId);
  assert.equal(pResuming.activeConversation.liveActivity.phase, 'compacting');
  assert.equal(pResuming.activeConversation.liveActivity.label, '上下文压缩');
  assert.equal(pResuming.activeConversation.liveActivity.detail, '已完成压缩，正在恢复推理');
  assert.equal(
    pResuming.activeConversation.liveActivity.startedAtMs,
    Date.parse('2026-11-11T02:19:33Z')
  );

  // Phase 3: Even when RPC fails/cools down and ONLY transcript.jsonl (with status="DONE" CHECKPOINT) is available,
  // it STILL detects compaction instead of regressing to pre-compaction "修改文件"
  h.state.trajectories[convId] = new Error('temporary RPC timeout');
  const pTranscriptOnly = await h.buildTelemetryPayloadInternal(convId, true);
  assert.equal(pTranscriptOnly.activeConversation.liveActivity.phase, 'compacting');
  assert.equal(pTranscriptOnly.activeConversation.liveActivity.label, '上下文压缩');
});

test('panel typography scales all view/table/chart CSS rules via --fs-* tokens without hardcoded px sizes', () => {
  const stylesDir = fileURLToPath(new URL('../src/styles', import.meta.url));
  const viewCssFiles = [
    'controls.css',
    'views-overview.css',
    'views-tables.css',
    'views-consumption.css',
    'views-settings.css',
  ];
  for (const file of viewCssFiles) {
    const css = fs.readFileSync(join(stylesDir, file), 'utf8');
    const rawFontLines = css
      .split(/\r?\n/)
      .filter((line) => /font-size\s*:/.test(line) && !/var\(--fs-/.test(line));
    assert.deepEqual(
      rawFontLines,
      [],
      `${file} must route every font-size declaration through scalable --fs-* tokens`
    );
  }
  const tokensCss = fs.readFileSync(join(stylesDir, 'tokens.css'), 'utf8');
  assert.match(tokensCss, /--font-sans\s*:[^;]+"SF Pro Text"/);
  assert.match(tokensCss, /--font-mono\s*:\s*ui-monospace,\s*SFMono-Regular,\s*"SF Mono"/);
  assert.match(tokensCss, /:host\(\[data-font-scale="xl"\]\)/);
  assert.match(tokensCss, /\[data-font-scale\]\s*\{[\s\S]*?--fs-base-sm:/);
  assert.doesNotMatch(tokensCss, /:root,\s*:host\s*\{[^}]*--ui-font-scale\s*:\s*1\s*;/);

  const panelRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const artifact of ['styles.css', 'app.js', 'index.html']) {
    const rawArtifact = fs.readFileSync(join(panelRoot, artifact), 'utf8');
    assert.equal(rawArtifact.includes('\r\n'), false, `${artifact} must normalize line endings to LF`);
  }
});

test('post-compaction context preserves static channels + checkpoint summary, capsule fits 100% without ellipsis, and .step-model-compact follows --accent-primary', async () => {
  const convId = '99999999-8888-4777-8666-555555555555';
  const preStep = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: '2026-11-18T03:00:00Z',
      finishedGeneratingAt: '2026-11-18T03:00:05Z',
      sourceTrajectoryStepInfo: { stepIndex: 10 },
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M429',
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '5400',
        cacheReadTokens: '270000',
        outputTokens: '1200',
      },
    },
  };
  const checkpointStep = {
    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: '2026-11-18T03:01:00Z',
      finishedGeneratingAt: '2026-11-18T03:01:06Z',
      sourceTrajectoryStepInfo: { stepIndex: 12 },
      modelUsage: {
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '5400',
        cacheReadTokens: '270000',
        outputTokens: '3800',
        thinkingOutputTokens: '800',
        responseOutputTokens: '3000',
      },
    },
  };
  const preGeneratorMetadata = [
    {
      stepIndices: [10],
      chatModel: {
        responseModel: 'gemini-4-carbon-high',
        modelDisplayName: 'Gemini 4 Carbon (High)',
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 275_400,
            maxContextTokens: 384_000,
            tokenBreakdown: {
              groups: [
                {
                  type: 'TOKEN_TYPE_SYSTEM_PROMPT',
                  numTokens: 16_000,
                  children: [
                    { name: 'identity', numTokens: 10_000 },
                    { name: 'skills', numTokens: 4_000 },
                    { name: 'user_rules', numTokens: 2_000 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_TOOLS',
                  numTokens: 10_000,
                  children: [
                    { name: 'run_command', numTokens: 8_000 },
                    { name: 'mcp_gradio_predict', numTokens: 2_000 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_CHAT_MESSAGES',
                  numTokens: 249_400,
                  children: [
                    { name: '1: USER_INPUT', numTokens: 49_400 },
                    { name: '2: PLANNER_RESPONSE', numTokens: 80_000 },
                    { name: '3: GENERIC', numTokens: 120_000 },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  ];

  const h = backendHarness({
    clock: () => Date.parse('2026-11-18T03:02:00Z'),
    summaries: {
      [convId]: {
        summary: 'Compaction test',
        stepCount: 2,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-18T03:01:06Z',
      },
    },
    trajectories: {
      [convId]: {
        numTotalSteps: 2,
        trajectory: {
          steps: [preStep, checkpointStep],
          generatorMetadata: preGeneratorMetadata,
        },
      },
    },
  });

  const payload = await h.buildTelemetryPayloadInternal(convId);
  const ctx = payload.activeConversation.context;

  // Static channels must survive compaction while old chat history resets and checkpoint summary is recorded
  assert.equal(ctx.systemPromptTokens, 10_000);
  assert.equal(ctx.skillsTokens, 4_000);
  assert.equal(ctx.userRulesTokens, 2_000);
  assert.equal(ctx.systemToolsTokens, 8_000);
  assert.equal(ctx.mcpToolsTokens, 2_000);
  assert.equal(ctx.checkpointTokens, 3_000, 'checkpoint summary uses responseTokens excluding thinkingTokens');
  assert.equal(ctx.userInputTokens, 0);
  assert.equal(ctx.assistantTokens, 0);
  assert.equal(ctx.toolResultsTokens, 0);
  assert.equal(ctx.subagentTokens, 0);
  assert.equal(ctx.totalTokens, 29_000, 'must not leak 275.4k pre-compaction input into post-compaction total');
  assert.equal(ctx.compactionLimitTokens, 384_000, 'inherits 384k custom context budget across compaction step');
  assert.equal(ctx.usedPct, 7.6);
  assert.equal(payload.conversations[0].contextUsedPct, 7.6, 'Multi-Session quick stats must also reflect post-compaction %');

  // Subsequent lightweight step without its own tokenBreakdown rolls forward cleanly on top of compacted baseline
  h.state.summaries[convId].stepCount = 3;
  h.state.summaries[convId].lastModifiedTime = '2026-11-18T03:02:10Z';
  h.state.trajectories[convId] = {
    numTotalSteps: 3,
    trajectory: {
      steps: [
        preStep,
        checkpointStep,
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            createdAt: '2026-11-18T03:02:05Z',
            finishedGeneratingAt: '2026-11-18T03:02:10Z',
            sourceTrajectoryStepInfo: { stepIndex: 14 },
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M429',
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              inputTokens: '1500',
              cacheReadTokens: '29000',
              outputTokens: '600',
            },
          },
        },
      ],
      generatorMetadata: preGeneratorMetadata,
    },
  };
  const payloadFollowup = await h.buildTelemetryPayloadInternal(convId, true);
  const ctx2 = payloadFollowup.activeConversation.context;
  assert.equal(ctx2.systemPromptTokens, 10_000);
  assert.equal(ctx2.checkpointTokens, 3_000);
  assert.equal(ctx2.userInputTokens, 1_500);
  assert.equal(ctx2.assistantTokens, 600);
  assert.equal(ctx2.totalTokens, 31_100);

  // Verify capsule 100% slot CSS, non-hardcoded compaction suffix color, and narrow-width top pill nav containment
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(stylesCss, /\.wm-ctx-seg\s*\{[^}]*width:\s*58px;/);
  assert.match(stylesCss, /\.wm-ctx-pct\s*\{[^}]*max-width:\s*none;[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;/s);
  assert.match(stylesCss, /\.step-model-compact\s*\{[^}]*color:\s*var\(--accent-primary\);/);
  assert.doesNotMatch(stylesCss, /\.step-model-compact\s*\{[^}]*--metric-info/);
  assert.match(stylesCss, /\.long-pill-nav\s*\{[^}]*container-type:\s*inline-size;[^}]*minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden;/s);
  assert.match(stylesCss, /\.pill-tab\s*\{[^}]*min-width:\s*0;/s);
  assert.match(stylesCss, /@container\s*\(max-width:\s*30em\)\s*\{[\s\S]*?\.pill-tab-badge\s*\{\s*display:\s*none\s*!important;/);
  assert.doesNotMatch(stylesCss, /\.structure-preview-canvas[^{]*\{[^}]*zoom:/, 'Structure preview must stay 1:1 without zoom distortion');
  assert.match(stylesCss, /\.preview-capsule-bar\s*\{[^}]*"Google Sans Flex"/s);
});

test('P0 audit fixes: main/bridge-daemon import isolation, standalone lsAddr, dual-window stepRevision LRU, CORTEX_STEP_TYPE_FIND, preview i18n, and header render purity', async () => {
  // 1. Static import isolation on main.mjs and bridge-daemon.mjs
  const mainSrc = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    mainSrc,
    /^import\s+[\s\S]*?from\s+['"]\.\/backend\/(?:api-actions|config)\.mjs['"]/m,
    'main.mjs must not statically import api-actions.mjs or config.mjs in the host parent process'
  );
  const daemonSrc = fs.readFileSync(new URL('../bridge-daemon.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    daemonSrc,
    /^import\s+[\s\S]*?from\s+['"]\.\/backend\/config\.mjs['"]/m,
    'bridge-daemon.mjs must not statically import config.mjs before --standalone env overrides'
  );

  // 2. Dual-window alternating stepDetails='display' stepRevision cache hit + rebuild invalidation
  const makeConv = (prompt) => ({
    trajectory: {
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_USER_INPUT',
          userInput: { userResponse: prompt },
          metadata: { createdAt: '2026-11-18T05:00:00Z' },
        },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: 'done' },
          metadata: {
            createdAt: '2026-11-18T05:00:01Z',
            completedAt: '2026-11-18T05:00:02Z',
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M65',
              inputTokens: '1200',
              outputTokens: '60',
            },
          },
        },
      ],
    },
  });
  const cidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const cidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const h = backendHarness({
    summaries: {
      [cidA]: { summary: 'A', stepCount: 2, lastModifiedTime: '2026-11-18T05:00:02Z' },
      [cidB]: { summary: 'B', stepCount: 2, lastModifiedTime: '2026-11-18T05:00:03Z' },
    },
    trajectories: {
      [cidA]: makeConv('Prompt A'),
      [cidB]: makeConv('Prompt B'),
    },
  });

  const firstA = JSON.parse(
    (await h.executeTelemetryAction({ conversationId: cidA, stepDetails: 'display', stepRevision: '' })).body
  );
  const firstB = JSON.parse(
    (await h.executeTelemetryAction({ conversationId: cidB, stepDetails: 'display', stepRevision: '' })).body
  );
  const secondA = JSON.parse(
    (await h.executeTelemetryAction({
      conversationId: cidA,
      stepDetails: 'display',
      stepRevision: firstA.stepRevision,
    })).body
  );
  const secondB = JSON.parse(
    (await h.executeTelemetryAction({
      conversationId: cidB,
      stepDetails: 'display',
      stepRevision: firstB.stepRevision,
    })).body
  );
  assert.equal(secondA.stepsUnchanged, true);
  assert.equal(secondB.stepsUnchanged, true);
  assert.equal(secondA.activeConversation.recentSteps, undefined);
  assert.equal(secondB.activeConversation.recentSteps, undefined);

  h.executeRebuildCacheAction();
  const afterRebuildA = JSON.parse(
    (await h.executeTelemetryAction({
      conversationId: cidA,
      stepDetails: 'display',
      stepRevision: firstA.stepRevision,
    })).body
  );
  assert.equal(afterRebuildA.stepsUnchanged, false);
  assert.equal(Array.isArray(afterRebuildA.activeConversation.recentSteps), true);

  // 3. CORTEX_STEP_TYPE_FIND live activity resolution
  const findAct = extractLiveActivity(
    [
      {
        type: 'CORTEX_STEP_TYPE_FIND',
        status: 'CORTEX_STEP_STATUS_RUNNING',
        metadata: { createdAt: '2026-11-18T05:00:00Z' },
      },
    ],
    true
  );
  assert.equal(findAct?.label, '查找文件');

  // 4. Preview i18n ('live.generating'), stepColumns maxItems: 14, SQLite busy helper reuse, and pure header render
  const { setI18nLanguage } = await import('../src/i18n/index.js');
  const { buildStructurePreviewTelemetry } = await import(
    '../src/components/settings/structurePreviewMock.js'
  );
  setI18nLanguage('zh-CN');
  assert.equal(
    buildStructurePreviewTelemetry().runningConversations[0].mainActivity.label,
    '生成中'
  );
  setI18nLanguage('en-US');
  assert.equal(
    buildStructurePreviewTelemetry().runningConversations[0].mainActivity.label,
    'Generating'
  );
  setI18nLanguage('zh-CN');

  const structureTabSrc = fs.readFileSync(
    new URL('../src/views/settings/SettingsStructureTab.js', import.meta.url),
    'utf8'
  );
  assert.match(structureTabSrc, /options:\s*getStepColumnOptions[\s\S]{0,120}?maxItems:\s*14\b/);

  const cliStatusSrc = fs.readFileSync(new URL('../cli-statusline.mjs', import.meta.url), 'utf8');
  assert.match(cliStatusSrc, /\bwithReadOnlySqliteDb\b/);
  assert.doesNotMatch(cliStatusSrc, /\bnew\s+DatabaseSync\s*\(/);

  const headerSrc = fs.readFileSync(
    new URL('../src/components/layout/TopSessionHeader.js', import.meta.url),
    'utf8'
  );
  const renderBody = headerSrc.slice(
    headerSrc.indexOf('function renderHeaderState()'),
    headerSrc.indexOf('const unsubTelemetry =')
  );
  assert.doesNotMatch(renderBody, /\buiStore\.setState\b/);
});

test('P1 audit fixes: shared third-party pool & route single-source, pure frozen resolveScopedConversation, mock schema alignment, and dead SettingsAccountTab exclusion', async () => {
  const { normalizeI18nLanguage } = await import('../src/i18n/index.js');
  const { resolveSpecificQuotaSlotSummary } = await import('../src/registries/metricRegistry.js');
  const { resolveScopedConversation, isEquivalentTelemetry } = await import(
    '../src/store/telemetryStore.js'
  );
  const { buildStructurePreviewTelemetry } = await import(
    '../src/components/settings/structurePreviewMock.js'
  );
  const { BRIDGE_API_ROUTE_DEFS } = await import('../shared/window-bridge-protocol.mjs');

  assert.equal(normalizeI18nLanguage('system'), 'auto');
  assert.equal(typeof isEquivalentTelemetry, 'function');
  assert.equal(BRIDGE_API_ROUTE_DEFS.length, 10);
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/bridge/relaunch'));

  // 1. Third-party pool parity across backend, CLI statusline, and frontend metricRegistry
  const h = backendHarness();
  const poolSample = 'Fable / OSS Third-Party Pool';
  assert.equal(h.classifyQuotaPoolIdentity({ groupName: poolSample }).poolKey, 'Claude & GPT');
  const quotasFixture = {
    pools: [
      {
        poolKey: poolSample,
        poolLabel: poolSample,
        family: poolSample,
        remainingPct: 37,
        weeklyRemainingPct: 68,
      },
    ],
  };
  assert.equal(resolveSpecificQuotaSlotSummary(quotasFixture, 'claude_5h')?.roundedPct, 37);
  assert.match(
    h.formatCliStatusLineCapsule({ quotas: quotasFixture }, { slots: ['claude_5h'], terminalWidth: 120 }),
    /37%/
  );
  const taggedQuotasFixture = {
    pools: [
      { poolKey: 'Gemini', poolLabel: 'Gemini', family: 'Gemini', remainingPct: 83, weeklyRemainingPct: 93 },
      { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', family: 'Claude & GPT', remainingPct: 100, weeklyRemainingPct: 49 },
      { poolKey: 'Argon', poolLabel: 'Gemini 4 Argon', family: 'Gemini', remainingPct: null, weeklyRemainingPct: 90 },
    ],
  };
  assert.equal(resolveSpecificQuotaSlotSummary(taggedQuotasFixture, 'gemini_weekly')?.shortText, 'G周 93%');
  assert.equal(resolveSpecificQuotaSlotSummary(taggedQuotasFixture, 'gemini_5h')?.shortText, 'G5h 83%');
  assert.equal(resolveSpecificQuotaSlotSummary(taggedQuotasFixture, 'claude_weekly')?.shortText, 'C周 49%');
  assert.equal(resolveSpecificQuotaSlotSummary(taggedQuotasFixture, 'claude_5h')?.shortText, 'C5h 100%');
  assert.equal(resolveSpecificQuotaSlotSummary(taggedQuotasFixture, 'argon_weekly')?.shortText, 'A周 90%');

  // 2. Pure resolveScopedConversation never mutates deeply frozen telemetry
  const deepFreeze = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
    return obj;
  };
  const frozenTelemetry = deepFreeze({
    activeConversation: {
      cascadeId: 'frozen-conv',
      hasSubagents: true,
      recentSteps: [{ stepIndex: 1, createdAtMs: 100 }],
      agents: [
        { agentId: 'main', isMain: true, index: 0 },
        { agentId: 'sub-1', isMain: false, index: 1, recentSteps: [{ stepIndex: 2, createdAtMs: 200 }] },
      ],
      aggregated: { activeAgentId: 'main' },
    },
  });
  const scoped = resolveScopedConversation(frozenTelemetry, 'all', 'auto', true);
  assert.equal(scoped.aggregated.recentSteps.length, 2);
  assert.equal(scoped.mainAgent.recentSteps.length, 1);

  // 3. structurePreviewMock schema completeness & dead SettingsAccountTab exclusion from app.js
  const mock = buildStructurePreviewTelemetry();
  assert.equal(typeof mock.activeConversation.context.compactionUsedTokens, 'number');
  assert.equal(mock.activeConversation.aggregated.agentId, 'all');
  assert.equal(Array.isArray(mock.activeConversation.agents[0].modelBreakdown), true);
  assert.equal(mock.quotas.meta.hasOfficialData, true);

  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.equal(appJs.includes('SettingsAccountTab.js'), false);
  assert.equal(appJs.includes('function renderQuotaRows('), false);
});

test('P2 audit fixes: standalone sqlite/proto-wire primitives, structured liveActivity/agent/media i18n, full en-US SVG charts, controlled LiveActivityWidget reuse, and shared Mock DOM', async () => {
  // 1. Standalone sqlite-client & proto-wire primitives (zero config/metrics imports)
  const sqliteClientSrc = fs.readFileSync(
    new URL('../backend/sqlite-client.mjs', import.meta.url),
    'utf8'
  );
  const protoWireSrc = fs.readFileSync(
    new URL('../backend/proto-wire.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(sqliteClientSrc, /config\.mjs|trajectory-metrics\.mjs/);
  assert.doesNotMatch(protoWireSrc, /config\.mjs|trajectory-metrics\.mjs/);

  const protoWire = await import('../backend/proto-wire.mjs');
  assert.equal(protoWire.unescapePbtxtString('\\344\\275\\240\\345\\245\\275'), '你好');
  const varState = { off: 0 };
  assert.equal(protoWire.readProtoVarint(new Uint8Array([0xac, 0x02]), varState), 300n);

  // 2. Bilingual dictionary 100% key parity
  const { I18N_MESSAGES_ZH_CN } = await import('../src/i18n/zh-CN.js');
  const { I18N_MESSAGES_EN_US } = await import('../src/i18n/en-US.js');
  const zhKeys = Object.keys(I18N_MESSAGES_ZH_CN).sort();
  const enKeys = Object.keys(I18N_MESSAGES_EN_US).sort();
  assert.deepEqual(enKeys, zhKeys);

  // 3. Structured liveActivity, agent badges/labels, turn media, and en-US SVG charts (zero Chinese leakage)
  const { createMockDom } = await import('./mock-dom.mjs');
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: mockDoc } = createMockDom();
  globalThis.document = mockDoc;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: mockDoc,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };

  try {
    const { setI18nLanguage } = await import('../src/i18n/index.js');
    const {
      formatAgentBadgeText,
      formatAgentLabel,
      formatLiveActivityDetail,
      formatLiveActivityLabel,
    } = await import('../src/core/formatters.js');
    const { formatTurnPromptText } = await import('../src/components/widgets/StepTableWidget.js');
    const { LiveActivityWidget } = await import('../src/components/widgets/LiveActivityWidget.js');
    const { buildCapsuleSlotContext } = await import('../src/components/widgets/CapsuleBarWidget.js');
    const { createModelFitChart, createSessionLineChart } = await import(
      '../src/components/charts/SessionStepCharts.js'
    );
    const { createTrendAreaChart } = await import('../src/components/charts/TrendAreaChart.js');

    const waitCmdAct = extractLiveActivity(
      [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: {
            toolCalls: [{ name: 'run_command', argumentsJson: '{"CommandLine":"npm test"}' }],
          },
        },
        { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_WAITING' },
      ],
      true
    );
    assert.equal(waitCmdAct?.actionKey, 'run_command');
    assert.equal(waitCmdAct?.waitingApproval, true);

    setI18nLanguage('en-US');
    assert.equal(formatLiveActivityLabel(waitCmdAct), 'Awaiting Approval · Run Command');
    assert.equal(
      formatLiveActivityDetail({ detailKey: 'compaction_resuming' }),
      'Compaction finished, resuming reasoning'
    );
    assert.equal(
      formatAgentBadgeText({ agentKind: 'side_question', agentOrdinal: 2 }),
      'Q2'
    );
    assert.equal(
      formatAgentLabel({ agentKind: 'subagent', agentOrdinal: 1, customRole: 'Auditor' }),
      'Subagent #1 · Auditor'
    );
    assert.equal(
      formatTurnPromptText('Check image', { hasMedia: true, mediaOnly: false }),
      'Check image [Media]'
    );
    assert.equal(formatTurnPromptText('', { hasMedia: true, mediaOnly: true }), '[Media Attachment]');

    // Controlled LiveActivityWidget auto-expands running subagents and renders session extras
    let selectedCid = '';
    const controlledLive = LiveActivityWidget({
      defaultExpandRunningSubs: true,
      showSessionExtras: true,
      onSelectSession: (cid) => {
        selectedCid = cid;
      },
    });
    controlledLive.refs.update({
      hostRouteConversationId: 'conv-en-ctrl',
      items: [
        {
          cascadeId: 'conv-en-ctrl',
          title: 'Controlled Multi Panel',
          isMainRunning: true,
          isRunning: true,
          latestTokPerSec: 82.4,
          contextUsedPct: 44,
          mainActivity: waitCmdAct,
          subagentCount: 1,
          runningSubagentCount: 1,
          subagents: [
            {
              cascadeId: 'sub-ctrl-1',
              index: 1,
              agentKind: 'subagent',
              agentOrdinal: 1,
              customRole: 'Verifier',
              isRunning: true,
              stepCount: 2,
              liveActivity: {
                phase: 'compacting',
                actionKey: 'compacting',
                detailKey: 'compaction_resuming',
                signature: 'cp:1',
              },
            },
          ],
        },
      ],
    });
    assert.equal(controlledLive.el.querySelector('.live-sub-list').hasAttribute('hidden'), false);
    assert.equal(controlledLive.el.querySelector('.wm-session-tag.is-here').hasAttribute('hidden'), false);
    assert.equal(controlledLive.el.querySelector('.wm-task-metrics').textContent, '82.4 t/s · 44%');
    assert.equal(/[\u4e00-\u9fff]/.test(controlledLive.el.textContent), false);
    controlledLive.el.querySelector('.live-task-title').onclick({});
    assert.equal(selectedCid, 'conv-en-ctrl');
    controlledLive.refs.stopLiveTicker();

    // SVG charts in en-US emit zero Chinese characters
    const sampleSteps = Array.from({ length: 6 }, (_, i) => ({
      stepIndex: i + 1,
      baseModelLabel: 'Gemini 4 Carbon',
      baseModelShort: 'carbon-4',
      tokPerSec: 70 + i * 4,
      ttftSec: 1.1,
      cacheHitPct: 88,
      inputTokens: 1000,
      cacheReadTokens: 8000,
      outputTokens: 300,
      contextTokens: 12000,
      costUsd: 0.01,
    }));
    const lineChart = createSessionLineChart();
    const lineRes = lineChart.update({ steps: sampleSteps, metric: 'tps' });
    assert.equal(/[\u4e00-\u9fff]/.test(lineRes.summaryBadge), false);
    assert.equal(/[\u4e00-\u9fff]/.test(lineChart.el.textContent), false);
    lineChart.destroy();

    const fitChart = createModelFitChart();
    const fitRes = fitChart.update({ steps: sampleSteps, metric: 'tps' });
    assert.equal(/[\u4e00-\u9fff]/.test(fitRes.summaryBadge), false);
    assert.equal(/[\u4e00-\u9fff]/.test(fitChart.el.textContent), false);
    fitChart.destroy();

    const trendChart = createTrendAreaChart();
    const hmSlots = Array.from({ length: 95 }, (_, i) => {
      const iso = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
      return { dateKey: iso, label: iso.slice(5), fullLabel: iso, tokens: (i + 1) * 500, calls: 2, costUsd: 0.02 };
    });
    trendChart.update(hmSlots);
    assert.equal(/[\u4e00-\u9fff]/.test(trendChart.el.textContent), false);
    trendChart.destroy();

    const slotCtx = buildCapsuleSlotContext(
      { activeConversation: { isRunning: true, stepCount: 2, latestTokPerSec: 64.5, context: { totalTokens: 64000, limitTokens: 256000 } } },
      {}
    );
    assert.equal(slotCtx.usedPct, 25);
    assert.equal(slotCtx.tps, 64.5);

    setI18nLanguage('zh-CN');
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
