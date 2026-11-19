import test from 'node:test';
import assert from 'node:assert/strict';
import { isEquivalentTelemetry } from '../src/store/telemetryStore.js';
import { extractModelSteps, normalizeCachedStep, MODEL_IDENTITY_VERSION } from '../trajectory-metrics.mjs';
import {
  formatUsd,
  mergeModelsByDisplayName,
  resolveModelDisplayInfo,
} from '../src/core/formatters.js';
import { backendHarness } from './backend-harness.mjs';

const FLASH = 'MODEL_PLACEHOLDER_M318', ARGON = 'MODEL_PLACEHOLDER_M418';
const PROMO_CLOCK_MS = Date.parse('2026-11-17T12:00:20Z');
const createdAtMs = PROMO_CLOCK_MS - 20_000;
function step(index, model, checkpoint = false) {
  return { type: checkpoint ? 'CORTEX_STEP_TYPE_CHECKPOINT' : 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE', metadata: {
      sourceTrajectoryStepInfo: { stepIndex: index },
      createdAt: new Date(createdAtMs).toISOString(), completedAt: new Date(createdAtMs + 10_000).toISOString(),
      modelUsage: { ...(model === undefined ? {} : { model }), apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '1000' },
    } };
}
async function payload(steps, options = {}) {
  return backendHarness({ clock: () => PROMO_CLOCK_MS, summaries: { test: { stepCount: steps.length } },
    trajectories: { test: { trajectory: { steps } } }, ...options }).buildTelemetryPayloadInternal('test');
}

test('missing checkpoint identity infers model and pricing from neighbouring steps', async () => {
  const rows = [step(209, FLASH), step(211, undefined, true), step(212, FLASH)];
  const raw = {
    trajectory: {
      steps: rows,
      generatorMetadata: [
        { stepIndices: [209], chatModel: { model: FLASH, responseModel: 'gemini-3.8-flash-n' } },
        { stepIndices: [212], chatModel: { model: FLASH, responseModel: 'gemini-3.8-flash-n' } },
      ],
    },
  };
  const p = await payload(rows, { trajectories: { test: raw } });
  const cp = p.activeConversation.recentSteps.find(s => s.stepIndex === 211);
  assert.equal(cp.modelKey, FLASH);
  assert.equal(cp.modelSource, 'inferred_compaction');
  assert.equal(cp.modelShort, 'flash-3.8-high·压缩');
  assert.equal(cp.responseModel, 'gemini-3.8-flash-n');
  assert.equal(cp.modelUpstream, 'gemini-3.8-flash-n·压缩');
  assert.equal(cp.costUsd, 0.0052);
  assert.equal(cp.inCostUsd, 0.0008);
  assert.equal(cp.contextTokens, 11000);
  assert.equal(cp.tokPerSec, 100);
  assert.equal(p.activeConversation.speedSummary.sampleCount, 2);
  assert.equal(p.consumption.account.totalTokens, 33000);
  assert.equal(p.consumption.account.unpricedCalls, 0);
  assert.equal(p.modelBreakdown.find(m => m.shortName === 'flash-3.8-high').calls, 3);
  assert(!p.modelBreakdown.some(m => /argon/i.test(m.label)));
});

test('isolated checkpoint without known neighbours stays unknown; its token totals survive', async () => {
  const rows = [step(211, undefined, true)];
  const p = await payload(rows);
  const cp = p.activeConversation.recentSteps.find(s => s.stepIndex === 211);
  assert.equal(cp.modelKey, 'unknown'); assert.equal(cp.modelShort, '模型未知·压缩');
  assert.equal(cp.costUsd, null); assert.equal(cp.inCostUsd, null);
  assert.equal(cp.contextTokens, 11000); assert.equal(cp.tokPerSec, 100);
  assert.equal(p.activeConversation.speedSummary.sampleCount, 0);
  assert.equal(p.consumption.account.totalTokens, 11000);
  assert.equal(p.consumption.account.unpricedCalls, 1);
  assert.equal(p.modelBreakdown.find(m => m.label === '模型未知').unpricedCalls, 1);
  assert.equal(p.consumption.trendSeries.reduce((n,s) => n+(s.unpricedCalls || 0),0), 1);
  assert.equal(p.consumption.sourcesBreakdown[0].unpricedCalls, 1);
  assert.equal(p.consumption.monthlySeries.reduce((n,s) => n+(s.unpricedCalls || 0),0), 1);
});

test('checkpoint can explicitly use a different model; no neighbour-based overwrite', async () => {
  const p = await payload([step(209, FLASH), step(211, ARGON, true), step(212, FLASH)]);
  const cp = p.activeConversation.recentSteps.find(s => s.stepIndex === 211);
  assert.equal(cp.modelShort, 'argon-4·压缩'); assert.equal(cp.modelSource, 'usage.model');
  assert.equal(cp.costUsd, 0.0129); assert.equal(p.consumption.account.unpricedCalls, 0);
});

test('ordinary calls with missing model are unknown too', () => {
  const [s] = extractModelSteps([step(1)]);
  assert.equal(s.modelKey, 'unknown'); assert.equal(s.modelSource, 'unavailable');
  assert.equal(s.totalTokPerSec, 100);
});

test('retry usage preserves its own model and counters', () => {
  const row = step(211, FLASH, true);
  row.metadata.retryInfos = [{ usage: row.metadata.modelUsage }]; delete row.metadata.modelUsage;
  const [s] = extractModelSteps([row]);
  assert.equal(s.modelKey, FLASH); assert.equal(s.inputTokens, 1000);
});

test('matching generator usage supplies model and wins over requested generator model', () => {
  const [s] = extractModelSteps([step(211)], [{stepIndices: [211], chatModel: {
    usage: { model: FLASH }, model: ARGON,
  }}]);
  assert.equal(s.modelKey, FLASH); assert.equal(s.modelSource, 'chat.usage.model');
});

test('unrelated generator metadata never supplies the missing model', () => {
  const [s] = extractModelSteps([step(211)], [{stepIndices: [0], chatModel: {model: FLASH}}]);
  assert.equal(s.modelKey, 'unknown');
});

test('unspecified enum values fall through to actual step model evidence', () => {
  for (const missing of ['', ' ', 'unknown', 'MODEL_UNSPECIFIED', 'MODEL_UNKNOWN', '0', 0, null]) {
    const row = step(211, missing); row.metadata.generatorModel = FLASH;
    const [s] = extractModelSteps([row]); assert.equal(s.modelKey, FLASH);
  }
});

test('response model and display name are preserved when enum model is absent', async () => {
  const row = step(211);
  const raw = {trajectory: { steps: [row], generatorMetadata: [{stepIndices:[211],chatModel:{
    responseModel:'gemini-3.8-flash-high',modelDisplayName:'Gemini 3.8 Flash (High)',
  }}]}};
  const p = await payload([], {trajectories: {test:raw}});
  assert.equal(p.activeConversation.activeModelShort,'flash-3.8-high');
});

test('upstream responseModel is preserved alongside placeholder modelKey for StepsDetailView', async () => {
  const row = step(211, FLASH);
  const raw = {trajectory: { steps: [row], generatorMetadata: [{stepIndices:[211],chatModel:{
    model: FLASH,
    responseModel: 'gemini-3.8-flash-n',
  }}]}};
  const p = await payload([], {trajectories: {test:raw}});
  const st = p.activeConversation.recentSteps[0];
  assert.equal(st.modelKey, FLASH);
  assert.equal(st.modelShort, 'flash-3.8-high');
  assert.equal(st.responseModel, 'gemini-3.8-flash-n');
  assert.equal(st.modelUpstream, 'gemini-3.8-flash-n');
  assert.equal(p.modelBreakdown[0].upstreamName, 'gemini-3.8-flash-n');
});

test('server model catalog overrides static placeholder mapping', () => {
  const {resolveModelInfo} = backendHarness({ clock: () => PROMO_CLOCK_MS });
  const result = resolveModelInfo(ARGON, new Map([[ARGON, {modelId:'gemini-3.8-flash-high', label:'Gemini 3.8 Flash (High)'}]]));
  assert.equal(result.shortName,'flash-3.8-high'); assert.equal(result.pricing.input,0.75);
});

test('uncatalogued model keeps identity and does not borrow another model price', async () => {
  const p = await payload([step(211, 'MODEL_PLACEHOLDER_M999')]);
  assert.equal(p.activeConversation.activeModelShort,'MODEL_PLACEHOLDER_M999');
  assert.equal(p.activeConversation.latestStepCostUsd,null);
  assert.equal(p.consumption.account.unpricedCalls,1);
});

test('old ambiguous Argon cache is persisted as unresolved while retaining modern measurements', async () => {
  const original = extractModelSteps([step(211, ARGON, true)])[0];
  delete original.modelIdentityVersion; delete original.modelSource;
  const old = {signature:'v9-unified-throughput:old',steps:[original]};
  const h = backendHarness({cache:{test:old},trajectories:{test:new Error('offline')}});
  const p = await h.buildTelemetryPayloadInternal('test');
  const s = p.activeConversation.recentSteps[0];
  assert.equal(s.modelKey,'unknown'); assert.equal(s.legacyModelKey,ARGON);
  assert.equal(s.modelSource,'legacy_unverified'); assert.equal(s.totalTokPerSec,100);
  assert.equal(p.consumption.account.totalTokens,11000);
  assert.equal(p.consumption.account.unpricedCalls,1);
  assert.equal(h.state.saves.length,1);
  await h.buildTelemetryPayloadInternal('test');
  assert.equal(h.state.saves.length,1,'do not rewrite identical migrated cache every poll');
  h.state.trajectories.test = {trajectory:{steps:[step(211,FLASH,true)]}};
  const restored = await h.buildTelemetryPayloadInternal('test', true);
  assert.equal(restored.activeConversation.activeModelShort,'flash-3.8-high·压缩');
  assert.equal(restored.consumption.account.unpricedCalls,0);
});

test('explicit historical models and verified real Argon identities survive cache load', () => {
  const known = extractModelSteps([step(211, ARGON)])[0];
  assert.equal(normalizeCachedStep(known).modelKey,ARGON);
  const flash = {...known,modelKey:FLASH}; delete flash.modelIdentityVersion;
  assert.equal(normalizeCachedStep(flash).modelKey,FLASH);
  assert.equal(normalizeCachedStep(flash).modelIdentityVersion, MODEL_IDENTITY_VERSION);
});

test('empty session does not invent an Argon model or a model quota pool', async () => {
  const p = await backendHarness().buildTelemetryPayloadInternal('test');
  assert.equal(p.activeConversation.activeModelShort,'模型未知');
  assert.equal(p.quotas.activePool.isAvailable,false); assert.equal(p.quotas.activePool.family,'Unknown');
});

test('unknown single-step cost renders as pending while aggregate subtotals omit pending suffix', () => {
  assert.equal(formatUsd(null),'待定'); assert.equal(formatUsd(0),'$0.00');
  assert.equal(formatUsd(0.1,{unpricedCalls:1}),'$0.10');
});

test('custom cost budget cannot claim a complete remaining percentage when prices are missing', async () => {
  const p = await payload([step(211)], {settings:{weeklyLimitMode:'custom_cost'}});
  assert.equal(p.quotas.weekly.usedPct,null); assert.equal(p.quotas.weekly.remainingPct,null);
});

test('frontend considers a model-only correction a real telemetry update', () => {
  const a={activeConversation:{recentSteps:[{modelKey:'unknown',modelShort:'模型未知',costUsd:null}]}};
  const b=structuredClone(a); b.activeConversation.recentSteps[0].modelShort='new-model';
  assert.equal(isEquivalentTelemetry(a,b),false); assert.equal(isEquivalentTelemetry(a,structuredClone(a)),true);
});

const ORCH_CARBON = 'MODEL_PLACEHOLDER_M667';
const ORCH_ARGON = 'MODEL_PLACEHOLDER_M681';
const ORCH_EXEC_HYDROGEN = 'MODEL_PLACEHOLDER_M669';

test('Orchestrator (Carbon) direct/planning and inferred compaction steps resolve to orch-carbon and annotate upstream ID', async () => {
  const rows = [step(1, ORCH_CARBON), step(2, undefined, true), step(3, ORCH_CARBON)];
  const raw = {
    trajectory: {
      steps: rows,
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            model: ORCH_CARBON,
            responseModel: 'gemini-pro-orchestrator',
            modelDisplayName: 'Orchestrator (Carbon)',
          },
          plannerConfig: {
            planModel: ORCH_CARBON,
            modelName: 'gemini-pro-orchestrator',
            planExecuteConfig: { executionModel: ORCH_EXEC_HYDROGEN },
          },
        },
        {
          stepIndices: [3],
          chatModel: {
            model: ORCH_CARBON,
            responseModel: 'gemini-pro-orchestrator',
            modelDisplayName: 'Orchestrator (Carbon)',
          },
        },
      ],
    },
  };
  const p = await payload(rows, { trajectories: { test: raw } });
  const s1 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 1);
  const cp = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);

  assert.equal(s1.modelShort, 'orch-carbon');
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(s1.costUsd, 0.0129);
  assert.equal(cp.modelKey, ORCH_CARBON);
  assert.equal(cp.modelSource, 'inferred_compaction');
  assert.equal(cp.modelShort, 'orch-carbon·压缩');
  assert.equal(cp.modelUpstream, 'gemini-pro-orchestrator (carbon-4)·压缩');
  assert.equal(p.activeConversation.activeModelShort, 'orch-carbon');
  assert.equal(p.activeConversation.activeModelUpstream, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(p.consumption.account.unpricedCalls, 0);
  assert.equal(p.modelBreakdown.length, 1);
  assert.equal(p.modelBreakdown[0].label, 'Orchestrator (Carbon)');
  assert.equal(p.modelBreakdown[0].upstreamName, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(p.modelBreakdown[0].calls, 3);
});

test('Orchestrator (Argon) resolves to orch-argon, annotates upstream ID, and is not misclassified as Carbon', async () => {
  const h = backendHarness({
    clock: () => PROMO_CLOCK_MS,
    summaries: { test: { stepCount: 1 } },
    trajectories: {
      test: {
        trajectory: {
          steps: [step(1, ORCH_ARGON)],
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                model: ORCH_ARGON,
                responseModel: 'gemini-pro-orchestrator-argon',
                modelDisplayName: 'Orchestrator (Argon)',
              },
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('test');
  const s1 = p.activeConversation.recentSteps[0];
  assert.equal(s1.modelShort, 'orch-argon');
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator-argon (argon-4)');
  assert.equal(s1.costUsd, 0.0129);
  assert.equal(p.modelBreakdown[0].label, 'Orchestrator (Argon)');
  assert.equal(p.modelBreakdown[0].upstreamName, 'gemini-pro-orchestrator-argon (argon-4)');
  assert.equal(h.isArgonModelIdentifier(ORCH_ARGON, 'gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'), true);
  assert.equal(h.isCarbonModelIdentifier(ORCH_ARGON, 'gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'), false);
  assert.equal(h.isNeonModelIdentifier('MODEL_PLACEHOLDER_M537', 'gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'), true);
  assert.equal(h.isCarbonModelIdentifier('MODEL_PLACEHOLDER_M537', 'gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'), false);
  assert.equal(h.isCarbonModelIdentifier('', 'gemini-pro-orchestrator-g1-pro', ''), false);
  assert.equal(
    h.formatUpstreamModelId('gemini-pro-orchestrator-neon', {
      rawModel: 'MODEL_PLACEHOLDER_M537',
      modelId: 'gemini-pro-orchestrator-neon',
    }),
    'gemini-pro-orchestrator-neon (neon-4)'
  );
});

test('real-world M669 worker steps (responseModel gemini-flash-worker-agy, displayName Gemini Flash) and uncatalogued executionModel resolve to Hydrogen', async () => {
  const FUTURE_EXEC_PH = 'MODEL_PLACEHOLDER_M799';
  const rows = [step(1, ORCH_CARBON), step(2, ORCH_EXEC_HYDROGEN), step(3, FUTURE_EXEC_PH)];
  const raw = {
    trajectory: {
      steps: rows,
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            model: ORCH_CARBON,
            responseModel: 'gemini-pro-orchestrator',
            modelDisplayName: 'Orchestrator (Carbon)',
          },
          plannerConfig: {
            planModel: ORCH_CARBON,
            modelName: 'gemini-pro-orchestrator',
            planExecuteConfig: { executionModel: FUTURE_EXEC_PH },
          },
        },
        {
          stepIndices: [2],
          chatModel: {
            model: ORCH_EXEC_HYDROGEN,
            responseModel: 'gemini-flash-worker-agy',
            modelDisplayName: 'Gemini Flash',
          },
        },
        {
          stepIndices: [3],
          chatModel: {
            model: FUTURE_EXEC_PH,
            responseModel: 'gemini-flash-worker-agy',
            modelDisplayName: 'Gemini Flash',
          },
        },
      ],
    },
  };

  const p = await payload(rows, { trajectories: { test: raw } });
  const s1 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 1);
  const s2 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);
  const s3 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 3);

  assert.equal(s1.modelShort, 'orch-carbon');
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(s1.costUsd, 0.0129);

  assert.equal(s2.modelShort, 'hydrogen-4');
  assert.equal(s2.modelLabel, 'Orchestrator Worker (Hydrogen)');
  assert.equal(s2.modelUpstream, 'gemini-flash-worker-agy (hydrogen-4)');
  assert.equal(s2.costUsd, 0.0097);

  assert.equal(s3.modelShort, 'hydrogen-4');
  assert.equal(s3.modelLabel, 'Orchestrator Worker (Hydrogen)');
  assert.equal(s3.modelUpstream, 'gemini-flash-worker-agy (hydrogen-4)');
  assert.equal(s3.costUsd, 0.0097);

  assert.equal(p.consumption.account.unpricedCalls, 0);
  const orchRow = p.modelBreakdown.find((m) => m.label === 'Orchestrator (Carbon)');
  const hydroRow = p.modelBreakdown.find((m) => m.label === 'Orchestrator Worker (Hydrogen)');
  assert.ok(orchRow && hydroRow, 'modelBreakdown keeps orchestrator planning separate from Hydrogen worker');
  assert.equal(p.modelBreakdown.some((m) => m.label === 'Gemini Flash'), false);
  assert.equal(orchRow.calls, 1);
  assert.equal(hydroRow.calls, 2);
  assert.equal(hydroRow.upstreamName, 'gemini-flash-worker-agy (hydrogen-4)');

  // Also verify already-cached M669 worker steps carrying vague "Gemini Flash" or transitional "Gemini 4 Hydrogen" resolve cleanly
  const cachedStep = {
    ...extractModelSteps([step(10, ORCH_EXEC_HYDROGEN)])[0],
    responseModel: 'gemini-flash-worker-agy',
    modelDisplayName: 'Gemini Flash',
  };
  const cachedTransitionalDirect = {
    ...extractModelSteps([step(11, 'MODEL_PLACEHOLDER_M528')])[0],
    modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
  };
  const hCached = backendHarness({
    cache: { test: { signature: 'v13-clean:2:', steps: [cachedStep, cachedTransitionalDirect] } },
    trajectories: { test: new Error('offline') },
  });
  const pCached = await hCached.buildTelemetryPayloadInternal('test');
  assert.equal(pCached.activeConversation.activeModelShort, 'hydrogen-4-xhigh');
  assert.equal(
    pCached.modelBreakdown.find((m) => m.label === 'Orchestrator Worker (Hydrogen)')?.upstreamName,
    'gemini-flash-worker-agy (hydrogen-4)'
  );
  assert.ok(
    pCached.modelBreakdown.find((m) => m.label === 'Gemini 4 Hydrogen'),
    'direct Gemini 4 Hydrogen remains in its own breakdown bucket separate from worker-agy'
  );
});

test('new Carbon (M427/M437/M438) and Hydrogen XHigh/High/Medium/Low (M525-M528) placeholders resolve and group cleanly', () => {
  const { resolveModelInfo, getBaseModelLabel } = backendHarness();

  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M427').shortName, 'carbon-4-high');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M437').shortName, 'carbon-4');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M438').shortName, 'carbon-4-low');

  const xhigh = resolveModelInfo('MODEL_PLACEHOLDER_M528');
  assert.equal(xhigh.shortName, 'hydrogen-4-xhigh');
  assert.equal(xhigh.baseLabel, 'Gemini 4 Hydrogen');
  assert.equal(xhigh.pricing.input, 1.5);
  assert.equal(xhigh.pricing.cache, 0.075);
  assert.equal(xhigh.pricing.output, 7.5);
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M525').shortName, 'hydrogen-4-high');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M526').shortName, 'hydrogen-4');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M527').shortName, 'hydrogen-4-low');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M527').pricing.input, 1.5);
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M527').pricing.output, 7.5);

  assert.equal(getBaseModelLabel('Orchestrator (Carbon)'), 'Orchestrator (Carbon)');
  assert.equal(getBaseModelLabel('Orchestrator (Argon)'), 'Orchestrator (Argon)');
  assert.equal(getBaseModelLabel('Orchestrator Worker (Hydrogen)'), 'Orchestrator Worker (Hydrogen)');
});

test('orchestratorIdMode defaults to compact, persists via settings action, and controls Orchestrator series independently of showUpstreamModel', () => {
  const h = backendHarness();
  assert.equal(h.loadSettings().orchestratorIdMode, 'compact');

  const resFull = h.executeSettingsAction({ orchestratorIdMode: 'full' });
  assert.equal(resFull.ok, true);
  assert.equal(resFull.updated.orchestratorIdMode, 'full');

  const resInvalid = h.executeSettingsAction({ orchestratorIdMode: 'unexpected' });
  assert.equal(resInvalid.updated.orchestratorIdMode, 'compact');

  const orchCarbon = {
    modelKey: ORCH_CARBON,
    modelShort: 'orch-carbon',
    modelLabel: 'Orchestrator (Carbon)',
    modelUpstream: 'gemini-pro-orchestrator (carbon-4)',
    responseModel: 'gemini-pro-orchestrator',
  };
  const orchArgon = {
    modelKey: ORCH_ARGON,
    modelShort: 'orch-argon',
    modelLabel: 'Orchestrator (Argon)',
    modelUpstream: 'gemini-pro-orchestrator-argon (argon-4)',
    responseModel: 'gemini-pro-orchestrator-argon',
  };
  const orchWorkerCompaction = {
    modelKey: ORCH_EXEC_HYDROGEN,
    modelShort: 'hydrogen-4·压缩',
    modelLabel: 'Orchestrator Worker (Hydrogen) [自动压缩]',
    modelUpstream: 'gemini-flash-worker-agy (hydrogen-4)·压缩',
    responseModel: 'gemini-flash-worker-agy',
    isCompactionStep: true,
  };
  const directHydrogen = {
    modelKey: 'MODEL_PLACEHOLDER_M528',
    modelShort: 'hydrogen-4-xhigh',
    modelLabel: 'Gemini 4 Hydrogen (XHigh)',
    modelUpstream: 'gemini-4-hydrogen-xhigh',
  };

  for (const showUpstreamModel of [false, true]) {
    assert.equal(
      resolveModelDisplayInfo(orchCarbon, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'orchestrator-carbon'
    );
    assert.equal(
      resolveModelDisplayInfo(orchArgon, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'orchestrator-argon'
    );
    assert.equal(
      resolveModelDisplayInfo(orchWorkerCompaction, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'worker-agy-hydrogen·压缩'
    );
    assert.equal(
      resolveModelDisplayInfo(orchCarbon, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-pro-orchestrator (carbon-4)'
    );
    assert.equal(
      resolveModelDisplayInfo(orchArgon, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-pro-orchestrator-argon (argon-4)'
    );
    assert.equal(
      resolveModelDisplayInfo(orchWorkerCompaction, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-flash-worker-agy (hydrogen-4)·压缩'
    );
  }

  const orchNeon = {
    modelKey: 'MODEL_PLACEHOLDER_M537',
    responseModel: 'gemini-pro-orchestrator-neon',
  };
  assert.equal(
    resolveModelDisplayInfo(orchNeon, { orchestratorIdMode: 'compact' }).text,
    'orchestrator-neon'
  );
  assert.equal(
    resolveModelDisplayInfo(orchNeon, { orchestratorIdMode: 'full' }).text,
    'gemini-pro-orchestrator-neon (neon-4)'
  );
  assert.equal(
    resolveModelDisplayInfo({ responseModel: 'gemini-pro-orchestrator-g1-pro' }, { orchestratorIdMode: 'compact' }).text,
    'orchestrator-g1-pro'
  );

  // Non-Orchestrator direct Hydrogen still follows showUpstreamModel regardless of orchestratorIdMode
  assert.equal(
    resolveModelDisplayInfo(directHydrogen, { showUpstreamModel: false, orchestratorIdMode: 'compact' }).text,
    'hydrogen-4-xhigh'
  );
  assert.equal(
    resolveModelDisplayInfo(directHydrogen, { showUpstreamModel: true, orchestratorIdMode: 'compact' }).text,
    'gemini-4-hydrogen-xhigh'
  );
  assert.equal(
    resolveModelDisplayInfo(directHydrogen, { showUpstreamModel: false, orchestratorIdMode: 'full' }, { preferLabelInShort: true }).text,
    'Gemini 4 Hydrogen (XHigh)'
  );
});

test('historical placeholders (M15/M16/M47/M84/M132/M133/M264/M330) and verified internal routing slugs resolve and price accurately without wildcarding unknown slugs', () => {
  const { resolveModelInfo } = backendHarness({ clock: () => PROMO_CLOCK_MS });

  const expectedPlaceholders = [
    ['MODEL_PLACEHOLDER_M84', 'flash-3.5-high', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M15', 'flash-3.5-high', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M132', 'flash-3.5-high', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M133', 'flash-3.5', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M47', 'flash-3', 0.5, 3.0],
    ['MODEL_PLACEHOLDER_M16', 'pro-3.1-high', 2.0, 12.0],
    ['MODEL_PLACEHOLDER_M264', 'flash-3.6-high', 0.75, 3.75],
    ['MODEL_PLACEHOLDER_M330', 'flash-2.5-lite', 0.1, 0.4],
  ];
  for (const [ph, shortName, inputPrice, outputPrice] of expectedPlaceholders) {
    const info = resolveModelInfo(ph);
    assert.equal(info.shortName, shortName, `${ph} shortName`);
    assert.ok(info.pricing, `${ph} should have pricing`);
    assert.equal(info.pricing.input, inputPrice, `${ph} input price`);
    assert.equal(info.pricing.output, outputPrice, `${ph} output price`);
  }

  const expectedSlugs = [
    ['gemini-3-flash-a', 'flash-3.5', 1.5, 9.0],
    ['gemini-3-flash-b', 'flash-3.5', 1.5, 9.0],
    ['gemini-3-flash-c', 'flash-3', 0.5, 3.0],
    ['gemini-3-flash-d', 'flash-3.5', 1.5, 9.0],
    ['gemini-3-flash-agent', 'flash-3.5', 1.5, 9.0],
    ['gemini-pro-default', 'pro-3.1', 2.0, 12.0],
    ['gemini-pro-agent', 'pro-3.1', 2.0, 12.0],
    ['gemini-pro-b', 'pro-3.1', 2.0, 12.0],
    ['gemini-3.7-flash-safety-le', 'flash-3.7', 0.75, 3.75],
    ['gemini-3.8-flash-n', 'flash-3.8', 0.75, 3.75],
    ['gemini-4-argon-f', 'argon-4', 2.0, 10.0],
    ['gemini-4-argon-disabled', 'argon-4', 2.0, 10.0],
  ];
  for (const [slug, shortName, inputPrice, outputPrice] of expectedSlugs) {
    const info = resolveModelInfo(slug);
    assert.equal(info.shortName, shortName, `${slug} shortName`);
    assert.ok(info.pricing, `${slug} should have pricing`);
    assert.equal(info.pricing.input, inputPrice, `${slug} input price`);
    assert.equal(info.pricing.output, outputPrice, `${slug} output price`);
  }

  // Unverified future variant must still remain unpriced (no reckless prefix fallback)
  const unknownVariant = resolveModelInfo('gemini-3.1-pro-ultra-v2');
  assert.equal(unknownVariant.pricing, null);
});

test('deep_stats session-display mislabeling is ignored when step-intrinsic model differs, and micro-costs preserve 6-decimal precision', async () => {
  const nowIso = new Date(Date.now() - 5_000).toISOString();
  const h = backendHarness({
    summaries: {
      ide_convo: { stepCount: 1 },
    },
    trajectories: {
      ide_convo: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                sourceTrajectoryStepInfo: { stepIndex: 1 },
                createdAt: nowIso,
                completedAt: new Date(Date.now() - 4_000).toISOString(),
                modelUsage: {
                  model: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  inputTokens: '1900',
                  cacheReadTokens: '0',
                  outputTokens: '107',
                },
              },
            },
          ],
        },
      },
    },
    deepStats: {
      perConvo: {
        'standalone:11111111-2222-3333-4444-555555555555': {
          appSource: 'standalone',
          entries: [
            {
              ts: nowIso,
              model: 'gemini-2.5-flash-lite',
              modelCanonicalId: 'gemini-2.5-flash-lite',
              modelAggregationId: 'session-display:gemini-3-5-flash-lite',
              modelDisplayName: 'Gemini 3.5 Flash Lite',
              provider: 'API_PROVIDER_GOOGLE_GEMINI',
              inp: 12300,
              cache: 0,
              out: 154,
              reasoning: 0,
            },
            {
              ts: nowIso,
              model: 'gemini-3-flash-a',
              modelCanonicalId: 'gemini-3-flash-a',
              modelAggregationId: 'session:gemini-3-flash-a',
              provider: 'API_PROVIDER_GOOGLE_GEMINI',
              inp: 3320000,
              cache: 32730000,
              out: 120000,
              reasoning: 195500,
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('ide_convo');
  const consumptionModels = p.modelBreakdown;

  // Both gemini-2.5-flash-lite calls (IDE + standalone with session-display:gemini-3-5-flash-lite) merge into one Gemini 2.5 Flash Lite bucket!
  const flash25Rows = consumptionModels.filter((m) => /2\.5 Flash Lite/i.test(m.label));
  assert.equal(flash25Rows.length, 1);
  assert.equal(
    consumptionModels.some((m) => /3\.5 Flash Lite/i.test(m.label)),
    false,
    'mismatched session-display:gemini-3-5-flash-lite should not create a bogus Gemini 3.5 Flash Lite bucket'
  );
  assert.equal(flash25Rows[0].calls, 2);
  assert.equal(flash25Rows[0].unpricedCalls, 0);
  // 14,200 input * $0.10/M + 261 output * $0.40/M = $0.0015244 -> 0.001524 (> 0, not truncated to 0!)
  assert.equal(flash25Rows[0].costUsd, 0.001524);

  // Also check single-step micro-cost (< $0.001) on activeConversation.modelBreakdown
  const sessionFlash25 = p.activeConversation.modelBreakdown.find((m) => /2\.5 Flash Lite/i.test(m.label));
  assert.ok(sessionFlash25);
  // 1,900 * $0.10/M + 107 * $0.40/M = $0.0002328 -> 0.000233
  assert.equal(sessionFlash25.costUsd, 0.000233);
  assert.equal(formatUsd(sessionFlash25.costUsd, { precise: true }), '<$0.001');
  assert.equal(formatUsd(flash25Rows[0].costUsd, { precise: true }), '$0.002');

  // Standalone session:gemini-3-flash-a entry preserves responseModel & prices cleanly
  const flash35Row = consumptionModels.find((m) => m.label === 'Gemini 3.5 Flash');
  assert.ok(flash35Row);
  assert.equal(flash35Row.upstreamName, 'gemini-3-flash-a');
  assert.equal(flash35Row.unpricedCalls, 0);
  assert.ok(flash35Row.costUsd > 12);
});

test('mergeModelsByDisplayName collapses distinct backend buckets that share the same rendered display text', () => {
  const rawModels = [
    {
      label: 'Gemini 3.8 Flash',
      shortName: 'flash-3.8',
      upstreamName: 'gemini-3-flash-a',
      upstreamModels: ['gemini-3-flash-a', 'gemini-3.8-flash'],
      calls: 7063,
      inputTokens: 91_800_000,
      cacheReadTokens: 674_810_000,
      outputTokens: 5_510_000,
      thinkingTokens: 3_130_000,
      responseTokens: 2_380_000,
      totalTokens: 772_120_000,
      costUsd: 286.2,
      unpricedCalls: 0,
      avgTokPerSec: 120,
      speedSummary: { sampleCount: 100, excludedCount: 5, avgTokPerSec: 120 },
      avgTtftSec: 2.0,
      ttftSampleCount: 100,
    },
    {
      label: 'Gemini 3.5 Flash',
      shortName: 'flash-3.5',
      upstreamName: 'gemini-3-flash-a',
      upstreamModels: ['gemini-3-flash-a'],
      calls: 449,
      inputTokens: 3_320_000,
      cacheReadTokens: 32_730_000,
      outputTokens: 315_500,
      thinkingTokens: 195_500,
      responseTokens: 120_000,
      totalTokens: 36_365_500,
      costUsd: 12.73,
      unpricedCalls: 0,
      avgTokPerSec: 80,
      speedSummary: { sampleCount: 100, excludedCount: 2, avgTokPerSec: 80 },
      avgTtftSec: 4.0,
      ttftSampleCount: 100,
    },
  ];

  // In upstream mode, both resolve to 'gemini-3-flash-a' -> merged into 1 row!
  const mergedUpstream = mergeModelsByDisplayName(
    rawModels,
    { showUpstreamModel: true },
    { preferLabelInShort: true }
  );
  assert.equal(mergedUpstream.length, 1);
  assert.equal(mergedUpstream[0].displayText, 'gemini-3-flash-a');
  assert.equal(mergedUpstream[0].calls, 7512);
  assert.equal(mergedUpstream[0].totalTokens, 808_485_500);
  assert.equal(mergedUpstream[0].costUsd, 298.93);
  assert.equal(mergedUpstream[0].avgTokPerSec, 100);
  assert.equal(mergedUpstream[0].avgTtftSec, 3);
  assert.deepEqual(mergedUpstream[0].sourceLabels, ['Gemini 3.8 Flash', 'Gemini 3.5 Flash']);

  // In friendly label mode, 'Gemini 3.8 Flash' and 'Gemini 3.5 Flash' stay distinct!
  const mergedShort = mergeModelsByDisplayName(
    rawModels,
    { showUpstreamModel: false },
    { preferLabelInShort: true }
  );
  assert.equal(mergedShort.length, 2);
});
