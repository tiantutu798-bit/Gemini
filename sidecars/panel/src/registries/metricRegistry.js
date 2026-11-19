/**
 * @fileoverview Decoupled Metric Registry (`metricRegistry.js`).
 * Centralizes presentation & option metadata for:
 * 1. Topbar / Composer Capsule Slots (1..5 items out of 13 metrics)
 * 2. Live Overview / Hover First-Row Metric Matrix (1..4 items out of 9 metrics)
 */

import {
  formatAgentBadgeText,
  formatCachePct,
  formatMetric,
  formatTokens,
  formatUsd,
  getCacheToneClass,
  getSpeedToneClass,
  getStepCostToneClass,
  getTtftToneClass,
  resolveModelDisplayInfo,
  resolveQuotaRemainingColor,
  sampleSummary,
  speedReasonText,
} from '../core/formatters.js';
import { isEnglishLocale, t } from '../i18n/index.js';
import { OVERVIEW_METRIC_KEYS, TOPBAR_SLOT_KEYS } from '../../shared/settings-normalization.mjs';
import {
  formatCompactCapsuleCost,
  formatCompactCapsuleTtft,
  resolveCapsuleQuotaSlotPct,
} from '../../shared/telemetry-display-rules.mjs';

export { OVERVIEW_METRIC_KEYS, formatCompactCapsuleCost, formatCompactCapsuleTtft };
export const CAPSULE_METRIC_KEYS = TOPBAR_SLOT_KEYS;

export function getCapsuleMetricOptions() {
  return CAPSULE_METRIC_KEYS.map((key) => ({
    value: key,
    label: t(`capMetric.${key}`),
  }));
}

export function getOverviewMetricOptions() {
  return OVERVIEW_METRIC_KEYS.map((key) => ({
    value: key,
    label: t(`ovMetric.${key}`),
  }));
}

export function resolveQuotaCapsuleSummary(quotas) {
  if (!quotas) return null;
  const activePool = quotas.activePool;
  const weekly = quotas.weekly;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const candidates = [];
  const defaultPoolName = isEnglishLocale() ? 'Active Pool' : '当前池';
  const wkTag = isEnglishLocale() ? 'Wk' : '周';

  if (activePool && Number.isFinite(Number(activePool.remainingPct))) {
    candidates.push({
      pct: Number(activePool.remainingPct),
      label: activePool.poolLabel || activePool.family || defaultPoolName,
      windowTag: '5h',
    });
  }
  if (activePool && Number.isFinite(Number(activePool.weeklyRemainingPct))) {
    candidates.push({
      pct: Number(activePool.weeklyRemainingPct),
      label: activePool.poolLabel || activePool.family || defaultPoolName,
      windowTag: wkTag,
    });
  }
  if (!candidates.length && weekly && Number.isFinite(Number(weekly.remainingPct))) {
    candidates.push({
      pct: Number(weekly.remainingPct),
      label: weekly.poolFamily || (isEnglishLocale() ? 'Weekly' : '周限额'),
      windowTag: wkTag,
    });
  }
  if (!candidates.length && pools.length > 0) {
    for (const p of pools) {
      const pLabel = p?.poolLabel || p?.family || defaultPoolName;
      if (p && Number.isFinite(Number(p.remainingPct))) {
        candidates.push({ pct: Number(p.remainingPct), label: pLabel, windowTag: '5h' });
      }
      if (p && Number.isFinite(Number(p.weeklyRemainingPct))) {
        candidates.push({ pct: Number(p.weeklyRemainingPct), label: pLabel, windowTag: wkTag });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.pct - b.pct);
  const tightest = candidates[0];
  const runnerUp = candidates.length > 1 ? candidates[1] : null;
  const rounded = Math.max(0, Math.min(100, Math.round(tightest.pct)));
  const runnerPct = runnerUp ? Math.max(0, Math.min(100, Math.round(runnerUp.pct))) : null;
  const subLabelText = runnerUp
    ? runnerUp.label === tightest.label
      ? `${tightest.label} ${tightest.windowTag} · ${runnerUp.windowTag} ${runnerPct}%`
      : `${tightest.label} ${tightest.windowTag} · ${runnerUp.label} ${runnerUp.windowTag} ${runnerPct}%`
    : `${tightest.label} · ${tightest.windowTag}`;
  return {
    roundedPct: rounded,
    shortText: t('capsule.quotaLeft', { pct: rounded }),
    subLabelText,
    detailText: candidates
      .map((c) => {
        const cPct = Math.max(0, Math.min(100, Math.round(c.pct)));
        return `${c.label} ${c.windowTag} ${t('capsule.quotaLeft', { pct: cPct })}`;
      })
      .join(' · '),
  };
}

const TAGGED_QUOTA_SLOT_KEYS = new Set([
  'gemini_weekly',
  'gemini_5h',
  'claude_weekly',
  'claude_5h',
  'argon_weekly',
]);

/**
 * 解析指定模型池（Gemini / Argon / Claude & GPT）与指定时间窗口（5h 或周额度）的剩余百分比摘要。
 *
 * @param {object|null|undefined} quotas
 * @param {'gemini_5h'|'gemini_weekly'|'claude_5h'|'claude_weekly'|'argon_weekly'} slotKey
 * @returns {{ roundedPct: number, shortText: string } | null}
 */
export function resolveSpecificQuotaSlotSummary(quotas, slotKey) {
  const rounded = resolveCapsuleQuotaSlotPct(quotas, slotKey);
  if (rounded == null) return null;
  const tagText = TAGGED_QUOTA_SLOT_KEYS.has(slotKey)
    ? t(`capsule.quotaLabel.${slotKey}`)
    : '';
  return {
    roundedPct: rounded,
    tagText,
    pctText: `${rounded}%`,
    shortText: tagText
      ? t(`capsule.quotaTag.${slotKey}`, { pct: rounded })
      : t('capsule.quotaLeft', { pct: rounded }),
  };
}

/**
 * 解析顶栏/输入框精简胶囊单槽位展示结构。
 *
 * @param {string} metricKey
 * @param {object} slotCtx
 * @param {number} ringCircumference
 */
export function resolveCapsuleMetricPresentation(metricKey, slotCtx, ringCircumference) {
  if (!metricKey || metricKey === 'none') {
    return {
      hidden: true,
      metric: 'none',
      segClass: 'wm-cap-slot',
      textClass: 'wm-slot-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: '',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  if (metricKey === 'context') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'context',
        segClass: 'wm-cap-slot wm-ctx-seg',
        textClass: 'wm-slot-text wm-ctx-pct',
        showRing: true,
        dashOffset: ringCircumference,
        text: '--%',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const isDanger = slotCtx.usedPct >= 88;
    const isWarn = !isDanger && slotCtx.usedPct >= 70;
    const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
    return {
      hidden: false,
      metric: 'context',
      segClass: 'wm-cap-slot wm-ctx-seg',
      textClass: 'wm-slot-text wm-ctx-pct',
      showRing: true,
      dashOffset: slotCtx.dashOffset,
      text: `${Math.round(slotCtx.usedPct)}%`,
      toneClass,
      running: false,
      warn: isWarn,
      danger: isDanger,
    };
  }

  if (metricKey === 'tps') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'tps',
        segClass: 'wm-cap-slot wm-seg-speed',
        textClass: 'wm-slot-text wm-speed-text',
        showRing: false,
        dashOffset: ringCircumference,
        text: '-- t/s',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const hasValidTps = Number.isFinite(slotCtx.tps) && slotCtx.tps > 0;
    const toneClass = hasValidTps ? getSpeedToneClass(slotCtx.tps) : '';
    const tpsText = hasValidTps
      ? `${slotCtx.tps >= 100 ? Math.round(slotCtx.tps) : slotCtx.tps.toFixed(1)} t/s`
      : slotCtx.isRunning
        ? t('capsule.tpsRunning')
        : t('capsule.tpsIdle');
    return {
      hidden: false,
      metric: 'tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: tpsText,
      toneClass,
      running: Boolean(slotCtx.isRunning),
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'avg_tps') {
    const avgVal = slotCtx.hasTelemetry ? slotCtx.avgTps : null;
    const valid = Number.isFinite(avgVal) && avgVal > 0;
    const toneClass = valid ? getSpeedToneClass(avgVal) : '';
    return {
      hidden: false,
      metric: 'avg_tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? `${avgVal >= 100 ? Math.round(avgVal) : avgVal.toFixed(1)} t/s` : '-- t/s',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'ttft') {
    const val = slotCtx.hasTelemetry ? slotCtx.ttft : null;
    const valid = val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
    const numVal = valid ? Number(val) : 0;
    const toneClass = valid ? getTtftToneClass(numVal) : '';
    return {
      hidden: false,
      metric: 'ttft',
      segClass: 'wm-cap-slot wm-seg-ttft',
      textClass: 'wm-slot-text wm-ttft-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatCompactCapsuleTtft(numVal) : '--s',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cost' || metricKey === 'session_cost') {
    const costVal = !slotCtx.hasTelemetry
      ? null
      : metricKey === 'session_cost'
        ? slotCtx.sessionCost
        : slotCtx.stepCost;
    const toneClass =
      metricKey === 'cost' && slotCtx.hasTelemetry && costVal != null
        ? getStepCostToneClass(costVal)
        : '';
    return {
      hidden: false,
      metric: metricKey,
      segClass: 'wm-cap-slot wm-seg-cost',
      textClass: 'wm-slot-text wm-cost-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: slotCtx.hasTelemetry ? formatCompactCapsuleCost(costVal) : '--',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cache_hit') {
    const cachePct = slotCtx.hasTelemetry ? slotCtx.cacheHitPct : null;
    const valid = cachePct != null && Number.isFinite(Number(cachePct));
    const numVal = valid ? Number(cachePct) : 0;
    const toneClass = valid ? getCacheToneClass(numVal, slotCtx.latestPromptTokens) : '';
    return {
      hidden: false,
      metric: 'cache_hit',
      segClass: 'wm-cap-slot wm-seg-cache',
      textClass: 'wm-slot-text wm-cache-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? `${Math.round(numVal)}%` : '--%',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'session_tokens') {
    const tokVal = slotCtx.hasTelemetry ? slotCtx.sessionTokens : null;
    const valid = tokVal != null && Number.isFinite(Number(tokVal)) && Number(tokVal) >= 0;
    return {
      hidden: false,
      metric: 'session_tokens',
      segClass: 'wm-cap-slot wm-seg-tokens',
      textClass: 'wm-slot-text wm-tokens-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatTokens(Number(tokVal)) : '--',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  const quotaSum = !slotCtx.hasTelemetry
    ? null
    : metricKey === 'quota_auto'
      ? resolveQuotaCapsuleSummary(slotCtx.quotas)
      : resolveSpecificQuotaSlotSummary(slotCtx.quotas, metricKey);
  const isDanger = Boolean(quotaSum && quotaSum.roundedPct <= 15);
  const isWarn = Boolean(quotaSum && !isDanger && quotaSum.roundedPct <= 30);
  const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
  if (TAGGED_QUOTA_SLOT_KEYS.has(metricKey)) {
    const pctNum = quotaSum ? Math.max(0, Math.min(100, quotaSum.roundedPct)) : 0;
    const dashOffset = quotaSum
      ? +(ringCircumference * (1 - pctNum / 100)).toFixed(2)
      : ringCircumference;
    return {
      hidden: false,
      metric: metricKey,
      segClass: 'wm-cap-slot wm-seg-quota wm-seg-quota-ring',
      textClass: 'wm-slot-text wm-quota-pct',
      tagText: t(`capsule.quotaLabel.${metricKey}`),
      showRing: true,
      dashOffset,
      ringColor: quotaSum ? resolveQuotaRemainingColor(pctNum) : '',
      text: quotaSum ? quotaSum.pctText : '--%',
      toneClass,
      running: false,
      warn: isWarn,
      danger: isDanger,
    };
  }
  return {
    hidden: false,
    metric: metricKey,
    segClass: 'wm-cap-slot wm-seg-quota',
    textClass: 'wm-slot-text wm-quota-text',
    tagText: '',
    showRing: false,
    dashOffset: ringCircumference,
    text: quotaSum ? quotaSum.shortText : t('capsule.quotaUnknown'),
    toneClass,
    running: false,
    warn: isWarn,
    danger: isDanger,
  };
}

function resolveActiveBadgeText(active) {
  if (!active?.activeAgentBadge && !active?.activeAgentKind) return '';
  return formatAgentBadgeText({
    agentKind:
      active.activeAgentKind ||
      (!active.activeAgentId || active.activeAgentId === 'main' ? 'main' : 'subagent'),
    agentOrdinal: Number(active.activeAgentOrdinal || 0),
    isMain: !active.activeAgentId || active.activeAgentId === 'main',
    badgeText: active.activeAgentBadge,
  });
}

/**
 * 解析实时监控第一行矩阵单个单元格的展示数据。
 *
 * @param {string} metricKey
 * @param {{ active?: object, ctx?: object, quotas?: object, settings?: object, hasSubagents?: boolean }} cellCtx
 */
export function resolveOverviewMetricCell(metricKey, cellCtx = {}) {
  const active = cellCtx.active || {};
  const ctx = cellCtx.ctx || active.context || {};
  const quotas = cellCtx.quotas || {};
  const settings = cellCtx.settings || {};
  const hasSubagents = Boolean(cellCtx.hasSubagents);
  const hasAnySteps = Number(active.stepCount || 0) > 0;

  if (metricKey === 'tps') {
    const activeModelDisplay = resolveModelDisplayInfo(active, settings, {
      fallback: t('fmt.unknownModel'),
    }).text;
    const reason = speedReasonText(active.latestSpeedReason);
    const badgeStr = resolveActiveBadgeText(active);
    const modelAndAgent =
      hasSubagents && badgeStr ? `[${badgeStr}] ${activeModelDisplay}` : activeModelDisplay;
    const hasSpeed = Number.isFinite(active.latestTokPerSec) && Number(active.latestTokPerSec) > 0;
    const speedTone = hasAnySteps && hasSpeed ? getSpeedToneClass(active.latestTokPerSec) : '';
    return {
      key: 'tps',
      label: t('ovMetric.tps'),
      icon: 'dot',
      iconSize: 10,
      isPulsing: Boolean(active.isRunning),
      valueText: formatMetric(active.latestTokPerSec, ' tok/s'),
      valueClass: speedTone ? `cell-value ${speedTone}` : 'cell-value',
      subText: reason
        ? !hasSpeed
          ? `${reason} · ${modelAndAgent}`
          : `${modelAndAgent} · ${reason}`
        : modelAndAgent,
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'ttft') {
    const ttftTone = hasAnySteps ? getTtftToneClass(active.latestTtftSec) : '';
    return {
      key: 'ttft',
      label: t('ovMetric.ttft'),
      icon: 'clock',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.latestTtftSec, 's'),
      valueClass: ttftTone ? `cell-value ${ttftTone}` : 'cell-value',
      subText: t('ovMetric.subAvgTtft', {
        val: formatMetric(active.ttftSummary?.avgSec, 's'),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'avg_tps') {
    const hasAvgSpeed = Number.isFinite(active.avgTokPerSec) && Number(active.avgTokPerSec) > 0;
    const avgSpeedTone = hasAnySteps && hasAvgSpeed ? getSpeedToneClass(active.avgTokPerSec) : '';
    return {
      key: 'avg_tps',
      label: t('ovMetric.avg_tps'),
      icon: 'pulse',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.avgTokPerSec, ' tok/s'),
      valueClass: avgSpeedTone ? `cell-value ${avgSpeedTone}` : 'cell-value',
      subText: t('ovMetric.subValidSamples', {
        samples: sampleSummary(active.speedSummary),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'step_cost' || metricKey === 'session_cost') {
    const stepCost = active.latestStepCostUsd;
    const sessCost = Number(active.sessionCostUsd || 0);
    const stepCnt = Number(active.stepCount || 0);
    const isAllUnpriced =
      stepCnt > 0 && Number(active.sessionUnpricedCalls || 0) >= stepCnt && !(sessCost > 0);
    const stepCostText =
      !hasAnySteps && stepCost == null ? '—' : formatUsd(stepCost, { precise: true });
    const totalCostText =
      !hasAnySteps && active.sessionCostUsd == null
        ? '—'
        : formatUsd(isAllUnpriced ? null : sessCost, {
            precise: sessCost > 0 && sessCost < 0.1,
          });

    if (metricKey === 'step_cost') {
      const costTone = hasAnySteps ? getStepCostToneClass(stepCost) : '';
      return {
        key: 'step_cost',
        label: t('ovMetric.step_cost'),
        icon: 'bolt',
        iconSize: 11,
        isPulsing: false,
        valueText: stepCostText,
        valueClass: costTone ? `cell-value ${costTone}` : 'cell-value',
        subText: t('ovMetric.subTotalCost', { cost: totalCostText }),
        subClass: 'cell-sub',
      };
    }

    return {
      key: 'session_cost',
      label: t('ovMetric.session_cost'),
      icon: 'bolt',
      iconSize: 11,
      isPulsing: false,
      valueText: totalCostText,
      valueClass: 'cell-value',
      subText: t('ovMetric.subStepCost', { cost: stepCostText }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'cache_hit') {
    const latestCache = active.latestCacheHitPct;
    const avgCache = active.sessionCacheHitPct ?? active.latestCacheHitPct;
    const hasLatest = hasAnySteps && latestCache != null && Number.isFinite(Number(latestCache));
    const hasAvg = hasAnySteps && avgCache != null && Number.isFinite(Number(avgCache));
    const cacheTone = hasLatest ? getCacheToneClass(latestCache, active.latestPromptTokens) : '';
    return {
      key: 'cache_hit',
      label: t('ovMetric.cache_hit'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: hasLatest ? formatCachePct(latestCache) : '—',
      valueClass: cacheTone ? `cell-value ${cacheTone}` : 'cell-value',
      subText: t('ovMetric.subAvgCache', {
        val: hasAvg ? formatCachePct(avgCache) : '—',
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'session_tokens') {
    const inTok = Math.max(0, Number(active.inputTokens || 0));
    const cacheTok = Math.max(0, Number(active.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(active.outputTokens || 0));
    const totalTok = Math.max(0, Number(active.totalTokens ?? inTok + cacheTok + outTok));
    return {
      key: 'session_tokens',
      label: t('ovMetric.session_tokens'),
      icon: 'chart-bar',
      iconSize: 11,
      isPulsing: false,
      valueText: !hasAnySteps && !totalTok ? '—' : formatTokens(totalTok),
      valueClass: 'cell-value',
      subText: t('ovMetric.subInOutTokens', {
        inTok: formatTokens(inTok + cacheTok),
        outTok: formatTokens(outTok),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'context_usage') {
    const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
    const totalTokens = Number(ctx.totalTokens || 0);
    const usedPct =
      limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
    const toneCls =
      usedPct >= 88
        ? 'cell-value tone-danger'
        : usedPct >= 70
          ? 'cell-value tone-warn'
          : 'cell-value';
    return {
      key: 'context_usage',
      label: t('ovMetric.context_usage'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: `${usedPct}%`,
      valueClass: toneCls,
      subText: t('ovMetric.subCtxRatio', {
        used: formatTokens(totalTokens),
        limit: formatTokens(limitTokens),
      }),
      subClass: 'cell-sub',
    };
  }

  const quotaSum = resolveQuotaCapsuleSummary(quotas);
  const quotaToneCls =
    quotaSum && quotaSum.roundedPct <= 15
      ? 'cell-value tone-danger'
      : quotaSum && quotaSum.roundedPct <= 30
        ? 'cell-value tone-warn'
        : 'cell-value';
  return {
    key: 'quota_tightest',
    label: t('ovMetric.quota_tightest'),
    icon: 'pulse',
    iconSize: 11,
    isPulsing: false,
    valueText: quotaSum ? quotaSum.shortText : '—',
    valueClass: quotaToneCls,
    subText: quotaSum
      ? t('ovMetric.subQuotaPool', { label: quotaSum.subLabelText })
      : t('ovMetric.subQuotaPending'),
    subClass: 'cell-sub',
  };
}
