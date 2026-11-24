/**
 * @fileoverview 对话流每轮回答底部内联用量摘要卡片 (TurnUsageCardWidget.js).
 *
 * 在宿主聊天滚动流 (`[data-testid="autoscroll-viewport"]`) 中每个已完成的 AI 回复块
 * (`[data-testid="agent-response"]`) 底部挂载三层紧凑卡片：
 * 1. 轮次与耗时：`#第12轮 · 完成于 00:48` | `共 5 步 · 总耗时 18.4s`
 * 2. 本轮模型明细：`[主控] Gemini 4 Argon (High) [Argon池] · 2次 · 185.2k (60%)`
 * 3. 本轮额度扣减与上下文净增长：`额度扣减 G5h -3.8% | G周 -0.6% | A周 -1.2%` | `上下文 本轮 +4.8%`
 *
 * 支持 Antigravity 2.33.0+ 聊天流虚拟滚动 (`trajectorySlice`)，通过读取 React Fiber
 * `container.steps[].metadata.createdAt` 时间戳与后端 `recentSteps` 精确对齐轮次，
 * 并在当前轮次流式生成期间 (`isRunning === true`) 自动抑制挂载，生成完毕后立即呈现。
 */

import { h } from '../../core/domPatch.js';
import { formatTokens, resolveModelDisplayInfo } from '../../core/formatters.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { resolveScopedConversation } from '../../store/telemetryStore.js';

const TURN_CARD_STYLE_ID = 'ag-usage-monitor-turn-styles';
const TURN_CARD_ATTR = 'data-ag-turn-usage';

const TURN_CARD_INLINE_STYLES = `
.wm-turn-usage-card {
  margin-top: 12px;
  margin-bottom: 4px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  background: rgba(128, 128, 128, 0.055);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.45;
  color: inherit;
  user-select: text;
  box-sizing: border-box;
  max-width: 100%;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}
.wm-turn-usage-card:hover {
  border-color: rgba(128, 128, 128, 0.32);
  background: rgba(128, 128, 128, 0.08);
}
.wm-turn-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.wm-turn-row + .wm-turn-row {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(128, 128, 128, 0.18);
}
.wm-turn-row-header {
  font-size: 11.5px;
  opacity: 0.86;
}
.wm-turn-title {
  font-weight: 600;
  white-space: nowrap;
}
.wm-turn-meta {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  white-space: nowrap;
}
.wm-turn-row-models {
  align-items: flex-start;
  justify-content: flex-start;
}
.wm-turn-sec-label {
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 500;
  opacity: 0.72;
  white-space: nowrap;
  min-width: 48px;
}
.wm-turn-models-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.wm-turn-model-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  font-variant-numeric: tabular-nums;
  min-width: 0;
}
.wm-turn-badge {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  height: 17px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  flex-shrink: 0;
}
.wm-turn-badge.role-main {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.3);
}
.wm-turn-badge.role-exec {
  background: rgba(16, 185, 129, 0.14);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.28);
}
.wm-turn-badge.role-sub {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.3);
}
.wm-turn-badge.role-compact {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.3);
}
.wm-turn-model-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}
.wm-turn-pool-tag {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  height: 16px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 500;
  opacity: 0.85;
  background: rgba(128, 128, 128, 0.14);
  border: 1px solid rgba(128, 128, 128, 0.22);
  white-space: nowrap;
  flex-shrink: 0;
}
.wm-turn-model-stats {
  opacity: 0.88;
  white-space: nowrap;
}
.wm-turn-row-footer {
  flex-wrap: wrap;
  row-gap: 4px;
}
.wm-turn-footer-left,
.wm-turn-footer-right {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.wm-turn-footer-left {
  flex-wrap: wrap;
}
.wm-turn-footer-right {
  margin-left: auto;
  white-space: nowrap;
}
.wm-turn-quota-items {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.wm-turn-quota-pill {
  font-weight: 600;
  white-space: nowrap;
}
.wm-turn-quota-sep {
  opacity: 0.38;
  user-select: none;
}
.wm-turn-ctx-val {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
`;

const ROLE_SORT_ORDER = Object.freeze({
  Main: 1,
  Exec: 2,
  Sub: 3,
  Compact: 4,
});

function formatTurnClockHm(ms) {
  const n = Number(ms || 0);
  if (!(n > 0) || !Number.isFinite(n)) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTurnDurationText(sec) {
  const s = Number(sec || 0);
  if (!(s > 0) || !Number.isFinite(s)) return '';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remS = Math.round(s % 60);
  return `${m}m ${String(remS).padStart(2, '0')}s`;
}

/**
 * 识别单步调用的角色（主控 / 执行 / 子代理 / 压缩）与所属额度池（Gemini / Argon / Claude / Carbon）。
 *
 * @param {object} step
 * @param {object|null|undefined} quotas
 * @returns {{ roleKey: 'Main'|'Exec'|'Sub'|'Compact', roleBadgeClass: string, poolFamily: 'Gemini'|'Argon'|'Claude'|'Carbon' }}
 */
export function classifyTurnModelRoleAndPool(step, quotas = null) {
  const rawStr = [
    step?.modelKey,
    step?.activeBaseModelShort,
    step?.baseModelShort,
    step?.activeModelShort,
    step?.modelShort,
    step?.activeBaseModelLabel,
    step?.baseModelLabel,
    step?.activeModelLabel,
    step?.modelLabel,
    step?.baseModelUpstream,
    step?.activeModelUpstream,
    step?.modelUpstream,
    step?.responseModel,
  ]
    .filter(Boolean)
    .join(' ');

  let roleKey = 'Main';
  let roleBadgeClass = 'role-main';
  if (
    step?.isCompactionStep ||
    /·(?:压缩|compact)(?=\s|$)|\[自动压缩\]/iu.test(rawStr)
  ) {
    roleKey = 'Compact';
    roleBadgeClass = 'role-compact';
  } else if (step?.isSubagent) {
    roleKey = 'Sub';
    roleBadgeClass = 'role-sub';
  } else if (
    /\bMODEL_PLACEHOLDER_M669\b|\b[a-z0-9.-]*worker-agy\b|\bworker-agy-hydrogen\b|\bOrchestrator\s+Worker\b/i.test(
      rawStr
    )
  ) {
    roleKey = 'Exec';
    roleBadgeClass = 'role-exec';
  }

  const pools = Array.isArray(quotas?.pools) ? quotas.pools : [];
  const hasExplicitPools = pools.length > 0;
  const getPoolIdentityText = (p) =>
    `${p?.poolKey || ''} ${p?.family || ''} ${p?.poolLabel || ''} ${p?.poolName || ''} ${p?.id || ''} ${p?.label || ''}`;
  const hasValidPoolWindow = (p) =>
    Boolean(
      p?.hasWeekly ||
        p?.has5h ||
        p?.weeklyRemainingPct != null ||
        p?.remainingPct != null
    );
  const hasArgonPool =
    hasExplicitPools &&
    pools.some((p) => hasValidPoolWindow(p) && /\bargon\b/i.test(getPoolIdentityText(p)));
  const hasCarbonPool =
    hasExplicitPools &&
    pools.some((p) => hasValidPoolWindow(p) && /\bcarbon\b/i.test(getPoolIdentityText(p)));

  let poolFamily = 'Gemini';
  if (/\b(?:claude|anthropic|fable|gpt|openai|oss|sonnet|opus|haiku|o[134](?:-\w+)?)\b/i.test(rawStr)) {
    poolFamily = 'Claude';
  } else if (
    hasArgonPool &&
    /\b(?:argon|MODEL_PLACEHOLDER_M681|orch-argon)\b/i.test(rawStr)
  ) {
    poolFamily = 'Argon';
  } else if (
    hasCarbonPool &&
    /\b(?:carbon|MODEL_PLACEHOLDER_M667|orch-carbon)\b/i.test(rawStr)
  ) {
    poolFamily = 'Carbon';
  }

  return { roleKey, roleBadgeClass, poolFamily };
}

function findQuotaPool(pools, familyRegex) {
  if (!Array.isArray(pools)) return null;
  for (const p of pools) {
    const idAndLabel = `${p?.poolKey || ''} ${p?.family || ''} ${p?.poolLabel || ''} ${p?.poolName || ''} ${p?.id || ''} ${p?.label || ''}`;
    if (familyRegex.test(idAndLabel)) return p;
  }
  return null;
}

const FIVE_HOURS_MS = 5 * 3600 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

function estimateCycleDropPct(
  turnCostUsd,
  turnTokens,
  poolObj,
  cycleKey,
  usedPctField,
  remPctField,
  fallbackBudgetUsd,
  fallbackBudgetTokens,
  cycleCtx = null
) {
  const cost = Math.max(0, Number(turnCostUsd || 0));
  const tokens = Math.max(0, Number(turnTokens || 0));
  if (cost <= 0 && tokens <= 0) return 0;

  const rawRem = poolObj?.[remPctField] ?? poolObj?.remainingPct;
  const rawUsed =
    poolObj?.[usedPctField] ??
    (rawRem != null && Number.isFinite(Number(rawRem))
      ? Math.max(0, 100 - Number(rawRem))
      : null);
  const usedPct =
    rawUsed != null && Number.isFinite(Number(rawUsed)) ? Math.max(0, Number(rawUsed)) : 0;

  const cycleUsage =
    poolObj?.[cycleKey] ||
    (cycleKey === 'cycleWeekly' ? poolObj?.cycle7d : null) ||
    null;
  const cycleCost = Math.max(0, Number(cycleUsage?.costUsd || 0));
  const cycleTokens = Math.max(0, Number(cycleUsage?.tokens || 0));

  const resetTimeIso = cycleCtx?.resetTimeIso || '';
  const windowDurationMs = Number(cycleCtx?.windowDurationMs || 0);
  const turnMaxCreatedAtMs = Number(cycleCtx?.turnMaxCreatedAtMs || 0);
  const resetMs = resetTimeIso ? Date.parse(resetTimeIso) : 0;
  const cycleStartMs =
    Number.isFinite(resetMs) && resetMs > 0 && windowDurationMs > 0
      ? resetMs - windowDurationMs
      : 0;
  const inCurrentCycle = !(
    cycleStartMs > 0 &&
    turnMaxCreatedAtMs > 0 &&
    turnMaxCreatedAtMs < cycleStartMs - 60_000
  );

  if (inCurrentCycle && usedPct >= 0.5 && cycleCost > 0.001 && cost > 0) {
    const rawDrop = usedPct * (cost / cycleCost);
    return Math.min(usedPct, rawDrop);
  }
  if (inCurrentCycle && usedPct >= 0.5 && cycleTokens > 1000 && tokens > 0) {
    const rawDrop = usedPct * (tokens / cycleTokens);
    return Math.min(usedPct, rawDrop);
  }
  if (cost > 0 && fallbackBudgetUsd > 0) {
    return (cost / fallbackBudgetUsd) * 100;
  }
  if (tokens > 0 && fallbackBudgetTokens > 0) {
    return (tokens / fallbackBudgetTokens) * 100;
  }
  return 0;
}

function formatDropPctText(tag, dropPct) {
  const val = Math.max(0, Number(dropPct || 0));
  if (val < 0.05) {
    return `${tag} <-0.1%`;
  }
  const clamped = Math.min(100, val);
  return `${tag} -${clamped.toFixed(1)}%`;
}

/**
 * 计算本轮在各额度池上的扣减百分比明细（按 G5h | G周 | C5h | C周 | A周 顺序输出）。
 *
 * @param {Record<string, { calls: number, tokens: number, costUsd: number }>} poolStats
 * @param {object|null|undefined} quotas
 * @param {number} [turnMaxCreatedAtMs=0]
 * @returns {Array<{ tag: string, dropPct: number, text: string }>}
 */
export function computeTurnQuotaDeductions(poolStats, quotas = null, turnMaxCreatedAtMs = 0) {
  const pools = Array.isArray(quotas?.pools) ? quotas.pools : [];
  const geminiPool = findQuotaPool(pools, /^(?!.*\bargon\b).*\bgemini\b/i);
  const claudePool = findQuotaPool(pools, /\b(?:claude|gpt)\b/i);
  const argonPool = findQuotaPool(pools, /\bargon\b/i);

  const gStat = poolStats.Gemini || { calls: 0, tokens: 0, costUsd: 0 };
  const aStat = poolStats.Argon || { calls: 0, tokens: 0, costUsd: 0 };
  const cStat = poolStats.Claude || { calls: 0, tokens: 0, costUsd: 0 };

  const out = [];

  // Gemini 5h 与周限池 (G5h / G周)：仅当本轮实际调用了 Gemini 池模型时才计算并显示
  if (gStat.calls > 0) {
    const dropG5h = estimateCycleDropPct(
      gStat.costUsd,
      gStat.tokens,
      geminiPool,
      'cycle5h',
      'usedPct',
      'remainingPct',
      25.0,
      60_000_000,
      {
        resetTimeIso: geminiPool?.resetTime || '',
        windowDurationMs: FIVE_HOURS_MS,
        turnMaxCreatedAtMs,
      }
    );
    out.push({
      tag: 'G5h',
      dropPct: dropG5h,
      text: formatDropPctText('G5h', dropG5h),
    });

    const dropGWk = estimateCycleDropPct(
      gStat.costUsd,
      gStat.tokens,
      geminiPool,
      'cycleWeekly',
      'weeklyUsedPct',
      'weeklyRemainingPct',
      90.0,
      210_000_000,
      {
        resetTimeIso: geminiPool?.weeklyResetTime || '',
        windowDurationMs: SEVEN_DAYS_MS,
        turnMaxCreatedAtMs,
      }
    );
    out.push({
      tag: 'G周',
      dropPct: dropGWk,
      text: formatDropPctText('G周', dropGWk),
    });
  }

  // Claude & GPT 5h 与周限池 (C5h / C周)
  if (cStat.calls > 0) {
    const dropC5h = estimateCycleDropPct(
      cStat.costUsd,
      cStat.tokens,
      claudePool,
      'cycle5h',
      'usedPct',
      'remainingPct',
      4.5,
      3_200_000,
      {
        resetTimeIso: claudePool?.resetTime || '',
        windowDurationMs: FIVE_HOURS_MS,
        turnMaxCreatedAtMs,
      }
    );
    out.push({
      tag: 'C5h',
      dropPct: dropC5h,
      text: formatDropPctText('C5h', dropC5h),
    });

    const dropCWk = estimateCycleDropPct(
      cStat.costUsd,
      cStat.tokens,
      claudePool,
      'cycleWeekly',
      'weeklyUsedPct',
      'weeklyRemainingPct',
      4.5,
      3_200_000,
      {
        resetTimeIso: claudePool?.weeklyResetTime || '',
        windowDurationMs: SEVEN_DAYS_MS,
        turnMaxCreatedAtMs,
      }
    );
    out.push({
      tag: 'C周',
      dropPct: dropCWk,
      text: formatDropPctText('C周', dropCWk),
    });
  }

  // Argon 独立周限池 (A周)：仅当显式存在独立 Argon 池时才计算
  if (aStat.calls > 0) {
    const dropAWk = estimateCycleDropPct(
      aStat.costUsd,
      aStat.tokens,
      argonPool,
      'cycleWeekly',
      'weeklyUsedPct',
      'weeklyRemainingPct',
      13.8,
      48_000_000,
      {
        resetTimeIso: argonPool?.weeklyResetTime || '',
        windowDurationMs: SEVEN_DAYS_MS,
        turnMaxCreatedAtMs,
      }
    );
    out.push({
      tag: 'A周',
      dropPct: dropAWk,
      text: formatDropPctText('A周', dropAWk),
    });
  }

  return out;
}

/**
 * 将当前活跃会话的 `recentSteps` 按轮次 (`rootTurnIndex ?? turnIndex`) 聚合成每轮摘要列表。
 *
 * @param {object|null|undefined} telemetry
 * @returns {Array<{
 *   turnIndex: number,
 *   totalSteps: number,
 *   totalDurationSec: number,
 *   durationText: string,
 *   completedTimeText: string,
 *   minCreatedAtMs: number,
 *   maxCreatedAtMs: number,
 *   turnPrompt: string,
 *   models: Array<{
 *     key: string,
 *     roleKey: 'Main'|'Exec'|'Sub'|'Compact',
 *     roleBadgeClass: string,
 *     poolFamily: 'Gemini'|'Argon'|'Claude'|'Carbon',
 *     displayName: string,
 *     calls: number,
 *     totalTokens: number,
 *     sharePct: number
 *   }>,
 *   quotaDeductions: Array<{ tag: string, dropPct: number, text: string }>,
 *   contextDeltaTokens: number,
 *   contextDeltaPct: number,
 *   contextDeltaText: string
 * }>}
 */
export function buildTurnUsageSummaries(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return [];
  const { mainAgent, ctxAgent, aggregated } = resolveScopedConversation(
    telemetry,
    'all',
    'auto',
    true
  );
  const allSteps = Array.isArray(aggregated?.recentSteps)
    ? aggregated.recentSteps
    : Array.isArray(mainAgent?.recentSteps)
      ? mainAgent.recentSteps
      : [];
  if (allSteps.length === 0) return [];

  const displaySettings = telemetry.settings || {};
  const quotas = telemetry.quotas || null;
  const limitTokens = Math.max(
    1,
    Number(
      ctxAgent?.contextLimitTokens ||
        mainAgent?.contextLimitTokens ||
        telemetry.activeConversation?.contextLimitTokens ||
        1_000_000
    )
  );

  // 按时间 / stepIndex 正序排列后按 turnIndex 分组
  const orderedSteps = [...allSteps].sort((a, b) => {
    const ta = Number(a?.createdAtMs || 0);
    const tb = Number(b?.createdAtMs || 0);
    if (ta > 0 && tb > 0 && ta !== tb) return ta - tb;
    return Number(a?.stepIndex || 0) - Number(b?.stepIndex || 0);
  });

  const turnMap = new Map();
  for (const st of orderedSteps) {
    if (!st || typeof st !== 'object') continue;
    const tIdx = Number(st.rootTurnIndex ?? st.turnIndex ?? 0);
    if (!(tIdx > 0)) continue;
    let bucket = turnMap.get(tIdx);
    if (!bucket) {
      bucket = {
        turnIndex: tIdx,
        steps: [],
        turnPrompt: '',
      };
      turnMap.set(tIdx, bucket);
    }
    bucket.steps.push(st);
    if (!bucket.turnPrompt && st.turnPrompt) {
      bucket.turnPrompt = String(st.turnPrompt).trim();
    }
  }

  const sortedTurns = Array.from(turnMap.values()).sort(
    (a, b) => a.turnIndex - b.turnIndex
  );

  let prevTurnEndCtxTokens = null;
  const summaries = [];

  for (const bucket of sortedTurns) {
    const { turnIndex, steps } = bucket;
    let minCreatedAtMs = Infinity;
    let maxCreatedAtMs = 0;
    let summedDurationSec = 0;
    let turnTotalTokens = 0;
    let firstMainStep = null;
    let lastMainCtxTokens = null;

    const modelGroupMap = new Map();
    const poolStats = {
      Gemini: { calls: 0, tokens: 0, costUsd: 0 },
      Argon: { calls: 0, tokens: 0, costUsd: 0 },
      Claude: { calls: 0, tokens: 0, costUsd: 0 },
      Carbon: { calls: 0, tokens: 0, costUsd: 0 },
    };

    for (const st of steps) {
      const cMs = Number(st.createdAtMs || 0);
      if (cMs > 0) {
        if (cMs < minCreatedAtMs) minCreatedAtMs = cMs;
        if (cMs > maxCreatedAtMs) maxCreatedAtMs = cMs;
      }
      const dur = Number(st.totalDurationSec ?? st.streamDurationSec ?? 0);
      if (Number.isFinite(dur) && dur > 0) {
        summedDurationSec += dur;
      }

      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const ctxTok = Math.max(0, Number(st.contextTokens || 0));
      const stepTokens = inTok + cacheTok + outTok > 0 ? inTok + cacheTok + outTok : ctxTok;
      const stepCost = Number.isFinite(Number(st.costUsd)) ? Math.max(0, Number(st.costUsd)) : 0;

      turnTotalTokens += stepTokens;

      if (!st.isSubagent) {
        if (!firstMainStep) firstMainStep = st;
        if (ctxTok > 0) lastMainCtxTokens = ctxTok;
      }

      const { roleKey, roleBadgeClass, poolFamily } = classifyTurnModelRoleAndPool(st, quotas);
      const disp = resolveModelDisplayInfo(st, displaySettings, {
        preferLabelInShort: true,
        fallback: 'Unknown Model',
      });
      const displayName = disp.baseText || disp.text || 'Unknown Model';
      const groupKey = `${roleKey}:${displayName}:${poolFamily}`;

      let mEntry = modelGroupMap.get(groupKey);
      if (!mEntry) {
        mEntry = {
          key: groupKey,
          roleKey,
          roleBadgeClass,
          poolFamily,
          displayName,
          calls: 0,
          totalTokens: 0,
          sharePct: 0,
        };
        modelGroupMap.set(groupKey, mEntry);
      }
      mEntry.calls += 1;
      mEntry.totalTokens += stepTokens;

      const pBucket = poolStats[poolFamily] || poolStats.Gemini;
      pBucket.calls += 1;
      pBucket.tokens += stepTokens;
      pBucket.costUsd += stepCost;
    }

    if (!Number.isFinite(minCreatedAtMs)) minCreatedAtMs = 0;
    if (
      summedDurationSec <= 0 &&
      maxCreatedAtMs > minCreatedAtMs &&
      maxCreatedAtMs - minCreatedAtMs < 3600_000
    ) {
      summedDurationSec = (maxCreatedAtMs - minCreatedAtMs) / 1000;
    }

    const models = Array.from(modelGroupMap.values()).sort((a, b) => {
      if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
      const ra = ROLE_SORT_ORDER[a.roleKey] || 99;
      const rb = ROLE_SORT_ORDER[b.roleKey] || 99;
      return ra - rb;
    });

    for (const m of models) {
      m.sharePct =
        turnTotalTokens > 0
          ? Math.max(1, Math.min(100, Math.round((m.totalTokens / turnTotalTokens) * 100)))
          : 0;
    }

    // 计算本轮主对话上下文净增长（兼容长对话 recentSteps 切片首轮基线估算）
    let baselineCtxTokens = prevTurnEndCtxTokens;
    if (baselineCtxTokens == null) {
      if (turnIndex <= 1) {
        baselineCtxTokens = 0;
      } else if (firstMainStep) {
        const fCtx = Math.max(0, Number(firstMainStep.contextTokens || 0));
        const fIn = Math.max(0, Number(firstMainStep.inputTokens || 0));
        const fOut = Math.max(0, Number(firstMainStep.outputTokens || 0));
        const fCache = Math.max(0, Number(firstMainStep.cacheReadTokens || 0));
        baselineCtxTokens =
          fCache > 0 ? fCache : Math.max(0, fCtx - fIn - fOut);
      } else {
        baselineCtxTokens = 0;
      }
    }

    const endCtxTokens =
      lastMainCtxTokens != null ? lastMainCtxTokens : baselineCtxTokens;
    const contextDeltaTokens = endCtxTokens - baselineCtxTokens;
    prevTurnEndCtxTokens = endCtxTokens;

    const rawDeltaPct = (contextDeltaTokens / limitTokens) * 100;
    const sign = rawDeltaPct >= 0 ? '+' : '';
    const absPct = Math.abs(rawDeltaPct);
    const contextDeltaText =
      absPct > 0 && absPct < 0.1
        ? `${rawDeltaPct >= 0 ? '+' : '-'}0.1%`
        : `${sign}${rawDeltaPct.toFixed(1)}%`;

    const quotaDeductions = computeTurnQuotaDeductions(poolStats, quotas, maxCreatedAtMs);

    summaries.push({
      turnIndex,
      totalSteps: steps.length,
      totalDurationSec: summedDurationSec,
      durationText: formatTurnDurationText(summedDurationSec),
      completedTimeText: formatTurnClockHm(maxCreatedAtMs),
      minCreatedAtMs,
      maxCreatedAtMs,
      turnPrompt: bucket.turnPrompt,
      models,
      quotaDeductions,
      contextDeltaTokens,
      contextDeltaPct: rawDeltaPct,
      contextDeltaText,
    });
  }

  return summaries;
}

function parseProtoTimestampMs(ts) {
  if (!ts || typeof ts !== 'object') return 0;
  try {
    const sec = Number(ts.seconds ?? 0);
    const nanos = Number(ts.nanos ?? 0);
    if (!Number.isFinite(sec) || sec <= 0) return 0;
    return sec * 1000 + Math.round((Number.isFinite(nanos) ? nanos : 0) / 1e6);
  } catch {
    return 0;
  }
}

/**
 * 从宿主 `[data-testid="agent-response"]` 节点及其祖先的 React Fiber 树中提取当前轮次容器
 * (`memoizedProps.container.steps` 与 `memoizedProps.isRunning`) 的时间戳区间与运行状态。
 *
 * @param {Element} respEl
 * @returns {{ hasFiber: boolean, isRunning: boolean, minMs: number, maxMs: number, stepCount: number }}
 */
export function extractDomResponseFiberMeta(respEl) {
  const empty = { hasFiber: false, isRunning: false, minMs: 0, maxMs: 0, stepCount: 0 };
  if (!respEl || typeof respEl !== 'object') return empty;

  let curEl = respEl;
  for (let depth = 0; depth < 7 && curEl; depth += 1) {
    let fiberKey = '';
    try {
      const keys = Object.keys(curEl);
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
          fiberKey = k;
          break;
        }
      }
    } catch {
      fiberKey = '';
    }

    if (fiberKey) {
      let f = curEl[fiberKey];
      let matchedSteps = null;
      let isLatestContainer = false;
      let explicitTurnRunning = false;
      let trajectoryRunning = false;

      for (let up = 0; up < 14 && f; up += 1) {
        const mp = f.memoizedProps;
        if (mp && typeof mp === 'object') {
          if (!matchedSteps && Array.isArray(mp.container?.steps) && mp.container.steps.length > 0) {
            matchedSteps = mp.container.steps;
            isLatestContainer = Boolean(mp.container.isLatest);
            if (typeof mp.isRunning === 'boolean' && !('trajectorySteps' in mp)) {
              explicitTurnRunning = mp.isRunning;
            }
          }
          if (typeof mp.isRunning === 'boolean' && ('trajectorySteps' in mp || 'isSubtrajectory' in mp)) {
            trajectoryRunning = mp.isRunning;
          } else if (typeof mp.isRunning === 'boolean' && matchedSteps && up <= 4) {
            explicitTurnRunning = mp.isRunning;
          }
        }
        f = f.return;
      }

      if (matchedSteps) {
        let minMs = Infinity;
        let maxMs = 0;
        let hasActiveStepStatus = false;
        const stepMsList = [];
        for (let i = 0; i < matchedSteps.length; i += 1) {
          const stObj = matchedSteps[i];
          const ms = parseProtoTimestampMs(stObj?.metadata?.createdAt);
          if (ms > 0) {
            if (ms < minMs) minMs = ms;
            if (ms > maxMs) maxMs = ms;
            stepMsList.push(ms);
          }
          const stStatus = Number(stObj?.status || 0);
          // CORTEX_STEP_STATUS_PENDING = 1, CORTEX_STEP_STATUS_RUNNING = 2, WAITING = 5
          if (stStatus === 1 || stStatus === 2 || stStatus === 5) {
            hasActiveStepStatus = true;
          }
        }
        const isRunning = Boolean(
          explicitTurnRunning ||
            hasActiveStepStatus ||
            (trajectoryRunning && isLatestContainer)
        );
        return {
          hasFiber: true,
          isRunning,
          isLatestContainer,
          minMs: Number.isFinite(minMs) ? minMs : 0,
          maxMs,
          stepMsList,
          stepCount: matchedSteps.length,
        };
      }
    }
    curEl = curEl.parentElement || curEl.parentNode;
  }

  return empty;
}

function ensureTurnCardStylesInjected(rootDoc) {
  if (!rootDoc || typeof rootDoc.getElementById !== 'function') return;
  if (rootDoc.getElementById(TURN_CARD_STYLE_ID)) return;
  const headOrBody = rootDoc.head || rootDoc.body || rootDoc.documentElement;
  if (!headOrBody || typeof rootDoc.createElement !== 'function') return;
  const styleEl = rootDoc.createElement('style');
  styleEl.id = TURN_CARD_STYLE_ID;
  styleEl.textContent = TURN_CARD_INLINE_STYLES;
  headOrBody.appendChild(styleEl);
}

function resolveRoleLabel(roleKey) {
  if (roleKey === 'Exec') return t('turnCard.roleExec');
  if (roleKey === 'Sub') return t('turnCard.roleSub');
  if (roleKey === 'Compact') return t('turnCard.roleCompact');
  return t('turnCard.roleMain');
}

function resolvePoolLabel(poolFamily) {
  if (poolFamily === 'Argon') return t('turnCard.poolArgon');
  if (poolFamily === 'Claude') return t('turnCard.poolClaude');
  if (poolFamily === 'Carbon') return t('turnCard.poolCarbon');
  return t('turnCard.poolGemini');
}

function buildTurnCardSignature(summary, locale) {
  const modelsPart = summary.models
    .map(
      (m) =>
        `${m.roleKey}:${m.displayName}:${m.poolFamily}:${m.calls}:${formatTokens(m.totalTokens)}:${m.sharePct}`
    )
    .join('|');
  const quotaPart = summary.quotaDeductions.map((q) => q.text).join('|');
  return `${locale}#${summary.turnIndex}#${summary.completedTimeText}#${summary.totalSteps}#${summary.durationText}#${modelsPart}#${quotaPart}#${summary.contextDeltaText}`;
}

function createOrUpdateTurnCardDom(respEl, summary, sig) {
  let cardEl = null;
  const children = respEl.children || [];
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const ch = children[i];
    if (ch?.getAttribute?.(TURN_CARD_ATTR) === 'true') {
      cardEl = ch;
      break;
    }
  }

  if (cardEl && cardEl.getAttribute('data-sig') === sig) {
    return cardEl;
  }

  const titleText = summary.completedTimeText
    ? t('turnCard.turnTitle', {
        turn: summary.turnIndex,
        time: summary.completedTimeText,
      })
    : t('turnCard.turnTitleNoTime', { turn: summary.turnIndex });

  const stepsMetaText = summary.durationText
    ? t('turnCard.stepsAndDuration', {
        steps: summary.totalSteps,
        duration: summary.durationText,
      })
    : t('turnCard.stepsOnly', { steps: summary.totalSteps });

  const headerRow = h('div', { className: 'wm-turn-row wm-turn-row-header' }, [
    h('span', { className: 'wm-turn-title', text: titleText }),
    h('span', { className: 'wm-turn-meta', text: stepsMetaText }),
  ]);

  const modelItemNodes = summary.models.map((m) => {
    const roleText = `[${resolveRoleLabel(m.roleKey)}]`;
    const poolText = `[${resolvePoolLabel(m.poolFamily)}]`;
    const statsText = `· ${t('turnCard.callsCount', { count: m.calls })} · ${formatTokens(m.totalTokens)} (${m.sharePct}%)`;
    return h('div', { className: 'wm-turn-model-item' }, [
      h('span', {
        className: `wm-turn-badge ${m.roleBadgeClass}`,
        text: roleText,
      }),
      h('span', {
        className: 'wm-turn-model-name',
        text: m.displayName,
        title: m.displayName,
      }),
      h('span', {
        className: 'wm-turn-pool-tag',
        text: poolText,
      }),
      h('span', {
        className: 'wm-turn-model-stats',
        text: statsText,
      }),
    ]);
  });

  const modelsRow = h('div', { className: 'wm-turn-row wm-turn-row-models' }, [
    h('span', { className: 'wm-turn-sec-label', text: t('turnCard.rowModels') }),
    h('div', { className: 'wm-turn-models-list' }, modelItemNodes),
  ]);

  const quotaChildren = [];
  if (summary.quotaDeductions.length === 0) {
    quotaChildren.push(
      h('span', { className: 'wm-turn-quota-pill', text: t('turnCard.quotaNone') })
    );
  } else {
    summary.quotaDeductions.forEach((q, idx) => {
      if (idx > 0) {
        quotaChildren.push(h('span', { className: 'wm-turn-quota-sep', text: '|' }));
      }
      quotaChildren.push(
        h('span', { className: 'wm-turn-quota-pill', text: q.text })
      );
    });
  }

  const footerRow = h('div', { className: 'wm-turn-row wm-turn-row-footer' }, [
    h('div', { className: 'wm-turn-footer-left' }, [
      h('span', { className: 'wm-turn-sec-label', text: t('turnCard.rowQuota') }),
      h('div', { className: 'wm-turn-quota-items' }, quotaChildren),
    ]),
    h('div', { className: 'wm-turn-footer-right' }, [
      h('span', { className: 'wm-turn-sec-label', text: t('turnCard.rowContext') }),
      h('span', {
        className: 'wm-turn-ctx-val',
        text: t('turnCard.ctxDelta', { delta: summary.contextDeltaText }),
      }),
    ]),
  ]);

  const nextCard = h(
    'div',
    {
      className: 'wm-turn-usage-card',
      [TURN_CARD_ATTR]: 'true',
      'data-turn-index': String(summary.turnIndex),
      'data-sig': sig,
    },
    [headerRow, modelsRow, footerRow]
  );

  if (cardEl && cardEl.parentNode === respEl) {
    respEl.replaceChild(nextCard, cardEl);
  } else {
    respEl.appendChild(nextCard);
  }
  return nextCard;
}

function removeTurnCardFromResponse(respEl) {
  if (!respEl?.children) return;
  const children = Array.from(respEl.children);
  for (const ch of children) {
    if (ch?.getAttribute?.(TURN_CARD_ATTR) === 'true') {
      ch.remove?.();
    }
  }
}

/**
 * 扫描宿主当前聊天视图中的 `[data-testid="agent-response"]` 节点，
 * 精确匹配各自所属轮次并挂载/更新三层内联用量摘要卡。
 *
 * @param {{ rootDoc?: Document, telemetry?: object|null }} [options]
 * @returns {number} 当前已挂载的轮次卡片数量
 */
export function syncTurnUsageCardsInViewport({ rootDoc = document, telemetry = null } = {}) {
  if (!rootDoc || typeof rootDoc.querySelectorAll !== 'function') return 0;
  if (!telemetry) return 0;

  let respNodes = [];
  try {
    respNodes = Array.from(rootDoc.querySelectorAll('[data-testid="agent-response"]'));
  } catch {
    respNodes = [];
  }
  if (respNodes.length === 0) return 0;

  const summaries = buildTurnUsageSummaries(telemetry);
  if (summaries.length === 0) {
    for (const node of respNodes) {
      removeTurnCardFromResponse(node);
    }
    return 0;
  }

  ensureTurnCardStylesInjected(rootDoc);

  const summaryByTurn = new Map();
  let maxTurnIndex = 0;
  for (const s of summaries) {
    summaryByTurn.set(s.turnIndex, s);
    if (s.turnIndex > maxTurnIndex) maxTurnIndex = s.turnIndex;
  }

  const isConvRunning = Boolean(
    telemetry?.activeConversation?.isRunning ||
      telemetry?.activeConversation?.liveActivity?.status === 'running'
  );

  // 第一阶段：收集每个 DOM 节点的 Fiber 元信息并尝试精确匹配（显式属性 / Fiber 时间戳重叠）
  const nodeEntries = respNodes.map((el, domIdx) => {
    const fiberMeta = extractDomResponseFiberMeta(el);
    let explicitTurn = Number(
      el.getAttribute?.('data-turn-index') ||
        el.parentElement?.getAttribute?.('data-turn-index') ||
        0
    );
    let matchedSummary = explicitTurn > 0 ? summaryByTurn.get(explicitTurn) || null : null;

    if (!matchedSummary && fiberMeta.minMs > 0) {
      let bestCandidate = null;
      let bestScore = Infinity;
      const fMin = fiberMeta.minMs;
      const fMax = fiberMeta.maxMs || fMin;
      const fMid = (fMin + fMax) / 2;

      for (const s of summaries) {
        if (!(s.minCreatedAtMs > 0)) continue;
        const sMin = s.minCreatedAtMs - 2500;
        const sMax = (s.maxCreatedAtMs || s.minCreatedAtMs) + 2500;
        const overlaps = fMin <= sMax && fMax >= sMin;
        const sMid = (s.minCreatedAtMs + (s.maxCreatedAtMs || s.minCreatedAtMs)) / 2;
        const dist = Math.abs(fMid - sMid);
        if (overlaps && dist < bestScore) {
          bestScore = dist;
          bestCandidate = s;
        } else if (!bestCandidate && dist <= 15_000 && dist < bestScore) {
          bestScore = dist;
          bestCandidate = s;
        }
      }
      matchedSummary = bestCandidate;
    }

    return {
      el,
      domIdx,
      fiberMeta,
      matchedSummary,
    };
  });

  // 第二阶段：仅对无 React Fiber 的节点（如纯静态 DOM 或轻量单元测试环境）按尾部已完成轮次顺序回退对齐；
  // 带有真实 React Fiber 但尚未在后端 summaries 中匹配到时间戳的新轮次节点严禁回退借用旧轮次（防止刚发送 1s 内闪现旧轮次卡片）
  const usedTurns = new Set();
  for (const entry of nodeEntries) {
    if (entry.matchedSummary) {
      usedTurns.add(entry.matchedSummary.turnIndex);
    }
  }

  const unmatchedEntries = nodeEntries.filter(
    (e) => !e.matchedSummary && !e.fiberMeta.hasFiber && !e.fiberMeta.isRunning
  );
  if (unmatchedEntries.length > 0) {
    const availableSummaries = summaries.filter((s) => {
      if (usedTurns.has(s.turnIndex)) return false;
      if (isConvRunning && s.turnIndex === maxTurnIndex) {
        return false;
      }
      return true;
    });
    const offset = Math.max(0, availableSummaries.length - unmatchedEntries.length);
    for (let i = 0; i < unmatchedEntries.length; i += 1) {
      const candidate = availableSummaries[offset + i];
      if (candidate) {
        unmatchedEntries[i].matchedSummary = candidate;
        usedTurns.add(candidate.turnIndex);
      }
    }
  }

  // 第三阶段：挂载或原位更新卡片（跳过正在流式输出或刚发送尚未完成的最新轮次）
  const locale = getEffectiveLocale();
  let mountedCount = 0;

  for (let i = 0; i < nodeEntries.length; i += 1) {
    const { el, fiberMeta, matchedSummary } = nodeEntries[i];
    const isLastNode = i === nodeEntries.length - 1;
    const isStreamingTurn = Boolean(
      fiberMeta.isRunning ||
        (isConvRunning &&
          (isLastNode ||
            fiberMeta.isLatestContainer ||
            matchedSummary?.turnIndex === maxTurnIndex))
    );

    if (!matchedSummary || isStreamingTurn) {
      removeTurnCardFromResponse(el);
      continue;
    }

    const sig = buildTurnCardSignature(matchedSummary, locale);
    createOrUpdateTurnCardDom(el, matchedSummary, sig);
    mountedCount += 1;
  }

  return mountedCount;
}

/**
 * 卸载宿主文档中所有已挂载的轮次内联用量卡片与注入样式。
 *
 * @param {Document} [rootDoc=document]
 */
export function disposeTurnUsageCardsInViewport(rootDoc = document) {
  if (!rootDoc || typeof rootDoc.querySelectorAll !== 'function') return;
  try {
    const cards = rootDoc.querySelectorAll(`[${TURN_CARD_ATTR}="true"]`);
    for (const card of cards) {
      card.remove?.();
    }
  } catch {
    // 忽略清理异常
  }
  try {
    const styleEl = rootDoc.getElementById?.(TURN_CARD_STYLE_ID);
    styleEl?.remove?.();
  } catch {
    // 忽略样式移除异常
  }
}
