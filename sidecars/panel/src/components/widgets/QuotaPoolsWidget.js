/**
 * @fileoverview Standalone decoupled Quota Pools Widget (`QuotaPoolsWidget.js`).
 * Renders dynamic multi-pool quota bars (Gemini, Argon/Carbon, Claude & GPT)
 * and weekly summary footer for both `LiveOverviewView` and `WindowOverlayShell`.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import {
  formatCountdown,
  formatTokens,
  formatUsd,
  resolveQuotaRemainingBarGradient,
} from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';

const QUOTA_POOL_DISPLAY_ORDER = {
  Gemini: 0,
  'Claude & GPT': 1,
  Claude: 1,
  GPT: 1,
  Argon: 2,
  Carbon: 3,
};

function getPoolDisplayRank(pool) {
  const famRank = QUOTA_POOL_DISPLAY_ORDER[pool?.family];
  if (famRank !== undefined) return famRank;
  const keyRank = QUOTA_POOL_DISPLAY_ORDER[pool?.poolKey];
  if (keyRank !== undefined) return keyRank;
  return 99;
}

/**
 * 归一化动态配额池列表；在官方配额尚未返回时回退预占 Gemini 与 Claude & GPT 两个标准池槽位。
 *
 * @param {object|null|undefined} quotas
 * @param {number} minuteTick
 * @param {{ isPending?: boolean }} [options]
 * @returns {Array<object>}
 */
export function buildQuotaPoolItems(quotas, minuteTick = 0, { isPending = false } = {}) {
  const safeQuotas = quotas || {};
  const activePool = safeQuotas.activePool || {};
  const rawPools =
    Array.isArray(safeQuotas.pools) && safeQuotas.pools.length > 0
      ? safeQuotas.pools
      : [
          { poolKey: 'Gemini', poolLabel: 'Gemini', family: 'Gemini' },
          { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', family: 'Claude & GPT' },
        ];
  const orderedPools = [...rawPools].sort((a, b) => getPoolDisplayRank(a) - getPoolDisplayRank(b));
  const weekly = safeQuotas.weekly || {};
  const poolItems = orderedPools.map((p) => {
    const key = p.poolKey || p.family || p.poolLabel || 'Other';
    const poolLabel = p.poolLabel || p.family || key;
    const isActivePool =
      Boolean(activePool.family) &&
      (activePool.poolKey === key ||
        activePool.family === p.family ||
        (key === 'Claude & GPT' && ['Claude', 'GPT'].includes(activePool.family)));
    return {
      key,
      poolLabel,
      poolData: p,
      fallbackWeekly: weekly,
      isActivePool,
      minuteTick,
      isPending,
    };
  });
  if (
    weekly?.isOfficial === false &&
    poolItems.length > 0 &&
    !poolItems.some((item) => item.isActivePool)
  ) {
    poolItems[0].isActivePool = true;
  }
  return poolItems;
}

/**
 * 创建单个配额池的 DOM 行结构，内含 5h 限额与每周限额两个可独立显隐的子窗口进度条。
 */
export function createPoolQuotaRow() {
  const title5h = h('span', { className: 'quota-win-title', text: '5h' });
  const usage5h = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const left5h = h('span', { className: 'quota-win-left' }, [title5h, usage5h]);
  const meta5h = h('span', { className: 'panel-meta quota-win-meta text-mono', text: '--' });
  const fill5h = h('div', { className: 'progress-fill' });
  const row5h = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [left5h, meta5h]),
    h('div', { className: 'progress-track' }, [fill5h]),
  ]);

  const titleWk = h('span', { className: 'quota-win-title', text: t('quota.weeklyShort') });
  const usageWk = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const leftWk = h('span', { className: 'quota-win-left' }, [titleWk, usageWk]);
  const metaWk = h('span', { className: 'panel-meta quota-win-meta text-mono', text: '--' });
  const fillWk = h('div', { className: 'progress-fill' });
  const rowWk = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [leftWk, metaWk]),
    h('div', { className: 'progress-track' }, [fillWk]),
  ]);

  const el = h('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }, [
    rowWk,
    row5h,
  ]);

  return {
    el,
    refs: {
      row5h,
      left5h,
      title5h,
      usage5h,
      meta5h,
      fill5h,
      rowWk,
      leftWk,
      titleWk,
      usageWk,
      metaWk,
      fillWk,
    },
  };
}

/**
 * 格式化可用额度面板底部的汇总行文案（官方配额模式下展示各池周期合计，自定义预算模式下展示自然周累计）。
 */
export function formatQuotaSummaryFooter(quotas, account) {
  const weekly = quotas?.weekly || {};
  const isCustomLocal = weekly.isOfficial === false;
  const tokStr = formatTokens(weekly.tokens || 0);
  const costStr = formatUsd(weekly.costUsd || 0);
  const leftText = isCustomLocal
    ? t('quota.footTokensCustom', { tok: tokStr, cost: costStr })
    : t('quota.footTokensCycle', { tok: tokStr, cost: costStr });
  const rightText =
    Number(account?.aiCredits) > 0
      ? t('quota.footCredits', { credits: account.aiCredits })
      : isCustomLocal
        ? t('quota.footCallsCustom', { calls: weekly.calls || 0 })
        : t('quota.footCallsCycle', { calls: weekly.calls || 0 });
  const tooltip = isCustomLocal ? t('quota.footTipCustom') : t('quota.footTipCycle');
  return { leftText, rightText, tooltip };
}

/**
 * 同步单个配额池行的 5h 与每周窗口状态。
 */
export function syncPoolQuotaRow(refs, item, idx, rowEl) {
  const { poolData, poolLabel, fallbackWeekly, isActivePool, isPending } = item;
  patchAttr(
    rowEl,
    'style',
    idx === 0
      ? 'display: flex; flex-direction: column; gap: 8px;'
      : 'display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-hairline);'
  );

  const has5h = poolData?.usedPct != null && poolData?.remainingPct != null;
  const used5hVal = has5h ? Number(poolData.usedPct) : 0;
  const rem5hVal = has5h ? Number(poolData.remainingPct) : 0;

  const useCustomWeekly = Boolean(isActivePool && fallbackWeekly?.isOfficial === false);
  const wkUsedRaw = useCustomWeekly
    ? fallbackWeekly?.usedPct
    : poolData?.weeklyUsedPct ?? (isActivePool ? fallbackWeekly?.usedPct : null);
  const wkRemRaw = useCustomWeekly
    ? fallbackWeekly?.remainingPct
    : poolData?.weeklyRemainingPct ?? (isActivePool ? fallbackWeekly?.remainingPct : null);
  const wkResetRaw = useCustomWeekly
    ? fallbackWeekly?.resetTime || poolData?.weeklyResetTime
    : poolData?.weeklyResetTime || (isActivePool ? fallbackWeekly?.resetTime : null);
  const hasWk = wkUsedRaw != null && wkRemRaw != null;
  const usedWkVal = hasWk ? Number(wkUsedRaw) : 0;
  const remWkVal = hasWk ? Number(wkRemRaw) : 0;

  const hide5h = !has5h && hasWk;
  const hideWk = !hasWk && has5h;
  refs.row5h.hidden = hide5h;
  refs.row5h.style.display = hide5h ? 'none' : 'flex';
  refs.rowWk.hidden = hideWk;
  refs.rowWk.style.display = hideWk ? 'none' : 'flex';

  const fallbackMetaText = isPending ? t('quota.loading') : t('quota.failed');

  patchText(refs.title5h, `5h (${poolLabel})`);
  const c5h = poolData?.cycle5h;
  if (!isPending && has5h && c5h && (c5h.tokens != null || c5h.costUsd != null)) {
    const tok5h = formatTokens(c5h.tokens || 0);
    const cost5h = formatUsd(c5h.costUsd || 0);
    const calls5h = Number(c5h.calls || 0);
    refs.usage5h.hidden = false;
    patchText(refs.usage5h, `· ${tok5h} (${cost5h})`);
    patchAttr(
      refs.left5h,
      'title',
      t('quota.cycle5hTitle', {
        pool: poolLabel,
        tok: tok5h,
        cost: cost5h,
        calls: calls5h,
      })
    );
  } else {
    refs.usage5h.hidden = true;
    patchText(refs.usage5h, '');
    patchAttr(refs.left5h, 'title', null);
  }
  patchText(
    refs.meta5h,
    has5h
      ? t('quota.usedAndLeft', {
          reset: formatCountdown(poolData.resetTime),
          used: used5hVal.toFixed(1),
          rem: rem5hVal.toFixed(1),
        })
      : fallbackMetaText
  );
  const rem5hClamped = has5h ? Math.max(0, Math.min(100, rem5hVal)) : 0;
  patchStyleVar(refs.fill5h, '--fill-w', has5h ? `${rem5hClamped}%` : '0%');
  patchStyleVar(
    refs.fill5h,
    '--fill-bg',
    has5h ? resolveQuotaRemainingBarGradient(rem5hClamped) : ''
  );
  patchClasses(refs.fill5h, {
    'tone-warn': has5h && rem5hClamped <= 30 && rem5hClamped > 15,
    'tone-danger': has5h && rem5hClamped <= 15,
  });

  const customTitle =
    useCustomWeekly && fallbackWeekly?.title
      ? fallbackWeekly.title
      : t('quota.weeklyPool', { pool: poolLabel });
  patchText(refs.titleWk, customTitle);
  const cWk = useCustomWeekly
    ? fallbackWeekly
    : poolData?.cycleWeekly || (isActivePool ? fallbackWeekly : null);
  if (!isPending && hasWk && cWk && (cWk.tokens != null || cWk.costUsd != null)) {
    const tokWk = formatTokens(cWk.tokens || 0);
    const costWk = formatUsd(cWk.costUsd || 0);
    const callsWk = Number(cWk.calls || 0);
    refs.usageWk.hidden = false;
    patchText(refs.usageWk, `· ${tokWk} (${costWk})`);
    patchAttr(
      refs.leftWk,
      'title',
      useCustomWeekly
        ? t('quota.cycleWkCustomTitle', { tok: tokWk, cost: costWk, calls: callsWk })
        : t('quota.cycleWkPoolTitle', {
            pool: poolLabel,
            tok: tokWk,
            cost: costWk,
            calls: callsWk,
          })
    );
  } else {
    refs.usageWk.hidden = true;
    patchText(refs.usageWk, '');
    patchAttr(refs.leftWk, 'title', null);
  }
  patchText(
    refs.metaWk,
    hasWk
      ? t('quota.usedAndLeft', {
          reset: formatCountdown(wkResetRaw),
          used: usedWkVal.toFixed(1),
          rem: remWkVal.toFixed(1),
        })
      : fallbackMetaText
  );
  const remWkClamped = hasWk ? Math.max(0, Math.min(100, remWkVal)) : 0;
  patchStyleVar(refs.fillWk, '--fill-w', hasWk ? `${remWkClamped}%` : '0%');
  patchStyleVar(
    refs.fillWk,
    '--fill-bg',
    hasWk ? resolveQuotaRemainingBarGradient(remWkClamped) : ''
  );
  patchClasses(refs.fillWk, {
    'tone-warn': hasWk && remWkClamped <= 30 && remWkClamped > 15,
    'tone-danger': hasWk && remWkClamped <= 15,
  });
}

export function quotaPoolRowSig(item, idx) {
  const c5h = item.poolData?.cycle5h;
  const cWk = item.poolData?.cycleWeekly;
  const fw = item.fallbackWeekly;
  return `${getEffectiveLocale()}:${idx}:${item.poolLabel}:${item.isActivePool}:${Boolean(item.isPending)}:${item.minuteTick}:${item.poolData?.usedPct}:${item.poolData?.remainingPct}:${item.poolData?.resetTime}:${item.poolData?.weeklyUsedPct}:${item.poolData?.weeklyRemainingPct}:${item.poolData?.weeklyResetTime}:${c5h?.tokens}:${c5h?.costUsd}:${c5h?.calls}:${cWk?.tokens}:${cWk?.costUsd}:${cWk?.calls}:${fw?.isOfficial}:${fw?.usedPct}:${fw?.remainingPct}:${fw?.resetTime}:${fw?.title}:${fw?.tokens}:${fw?.costUsd}:${fw?.calls}`;
}

export const QuotaPoolsWidget = defineComponent({
  name: 'QuotaPoolsWidget',
  setup({ props }) {
    const compactHover = Boolean(props.compactHover);
    const titleTextEl = h('span', { text: t('module.quotas') });
    const tierBadge = h('span', { className: 'panel-meta', text: 'Google AI · Pro' });
    const poolsListEl = h(
      'div',
      compactHover
        ? { className: 'wm-hover-quota-pools' }
        : { style: 'display: flex; flex-direction: column; gap: 0;' }
    );

    if (compactHover) {
      patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });
    }

    const initFoot = formatQuotaSummaryFooter(null, null);
    const wkFootLeft = h('span', { className: 'text-muted', text: initFoot.leftText });
    const wkFootRight = h('span', {
      className: 'text-muted',
      text: compactHover ? initFoot.rightText : '',
    });

    const quotaPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          titleTextEl,
        ]),
        tierBadge,
      ]),
      poolsListEl,
      h(
        'div',
        compactHover
          ? { className: 'panel-header wm-hover-quota-foot' }
          : { className: 'panel-header', style: 'font-size: var(--fs-md); padding-top: 2px;' },
        [wkFootLeft, wkFootRight]
      ),
    ]);

    function update({ data, minuteTick } = {}) {
      patchText(titleTextEl, t('module.quotas'));
      if (!data) {
        if (compactHover) {
          patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
            keyFn: (item) => item.key,
            sigFn: quotaPoolRowSig,
            createRow: createPoolQuotaRow,
            updateRow: syncPoolQuotaRow,
          });
          const pendingFoot = formatQuotaSummaryFooter(null, null);
          patchText(wkFootLeft, pendingFoot.leftText);
          patchText(wkFootRight, pendingFoot.rightText);
        }
        return;
      }

      const quotas = data.quotas || {};
      const effTick = Number.isFinite(minuteTick) ? minuteTick : Math.floor(Date.now() / 30000);
      patchText(
        tierBadge,
        `${data.account?.tierName || 'Google AI'} · ${data.account?.planName || 'Pro'}`
      );
      patchKeyedList(poolsListEl, buildQuotaPoolItems(quotas, effTick), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });

      const footSummary = formatQuotaSummaryFooter(quotas, data.account);
      patchText(wkFootLeft, footSummary.leftText);
      patchText(wkFootRight, footSummary.rightText);
      patchAttr(wkFootLeft, 'title', footSummary.tooltip);
      patchAttr(wkFootRight, 'title', footSummary.tooltip);
    }

    return {
      el: quotaPanel,
      refs: { update, poolsListEl },
    };
  },
});
