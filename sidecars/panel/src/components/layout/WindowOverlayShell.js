/**
 * @fileoverview 主窗口双栖挂载外壳 (WindowOverlayShell.js).
 *
 * 采用「分离式双 Shadow Host」架构，彻底规避宿主顶栏层叠上下文 (`z-0` / `overflow: hidden`) 裁切与路由重绘卸载问题：
 * 1. `#ag-usage-monitor-capsule`：轻量顶栏胶囊，优先内嵌停靠至 `[class*="@container/titlebar"]` 右侧按钮组，
 *    支持四级迟滞宽度自适应折叠（`wide` -> `compact` -> `minimal` -> `ring-only`），找不到顶栏时自动回退至右上角固定定位；
 * 2. `#ag-usage-monitor-portal`：常驻 `document.body` 顶层的无遮挡浮层宿主，承载悬停速览卡与完整四标签 `App()` 监控面板，
 *    在宿主切换会话重建顶栏 DOM 时始终保持组件实例、滚动位置与动画状态不丢失。
 */

import {
  WINDOW_BRIDGE_KEY,
  WINDOW_OVERLAY_KEY,
  WINDOW_OVERLAY_METHODS,
  readInjectedWindowBridge,
} from '../../../shared/window-bridge-protocol.mjs';
import { App } from '../../App.js';
import {
  PANEL_SCALE_FACTORS,
  applyAppearanceToRoot,
  normalizeClientFontScale,
} from '../../core/appearance.js';
import {
  h,
  isEventInside,
  patchAttr,
  patchClasses,
  patchText,
} from '../../core/domPatch.js';
import { deliverCdpBridgeResponses, getWindowBridgeConfig } from '../../core/httpClient.js';
import { i18nStore, setI18nLanguage, t } from '../../i18n/index.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import {
  buildCapsuleSlotContext,
  createCapsuleSlotNode,
  resolveMultiSessionCapsuleState,
  syncCapsuleSlotNodes,
} from '../widgets/CapsuleBarWidget.js';
import {
  disposeTurnUsageCardsInViewport,
  syncTurnUsageCardsInViewport,
} from '../widgets/TurnUsageCardWidget.js';
import { LiveActivityWidget } from '../widgets/LiveActivityWidget.js';
import { createDynamicWidgetHost } from '../../registries/widgetRegistry.js';
import {
  DEFAULT_CLIENT_HOVER_MODULES,
  extractHostRouteCascadeId,
  fetchTelemetry,
  isMacHostPlatform,
  normalizeClientHoverModules,
  normalizeClientPopoverWidth,
  normalizeClientPopoverWidthMode,
  normalizeClientTopbarSlots,
  normalizeClientUpdateMode,
  normalizeClientWindowMountMode,
  resolveScopedConversation,
  startAsyncTelemetryLoop,
  stopAsyncTelemetryLoop,
  telemetryStore,
  triggerPluginUpdate,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

const CAPSULE_HOST_ID = 'ag-usage-monitor-capsule';
const PORTAL_HOST_ID = 'ag-usage-monitor-portal';
const FLOATING_CARD_WIDTH = 522;
const POPOVER_BASE_WIDTH = 540;
const POPOVER_MAX_AUTO_WIDTH = 960;
const MULTI_PANEL_WIDTH = 464;

/**
 * 带迟滞区间（Hysteresis）的四阶段顶栏双胶囊响应式宽度计算，避免临界宽度反复跳动。
 * 当左侧多会话入口关闭（`showMulti === false`）时自动释放约 76px 预算给右侧指标胶囊；
 * 当槽位数超过 3 个（4..5 槽）时自动按槽位增量上浮 `wide` 阈值。
 *
 * @param {number} availWidth
 * @param {'wide'|'compact'|'minimal'|'ring-only'} currentMode
 * @param {{ showMulti?: boolean, hasUpdate?: boolean, slotCount?: number }} [options]
 * @returns {'wide'|'compact'|'minimal'|'ring-only'}
 */
export function computeCapsuleLayoutMode(availWidth, currentMode = 'wide', options = undefined) {
  if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
  const showMulti = options?.showMulti !== false;
  const updateReserve = options?.hasUpdate ? 52 : 0;
  const slotCount = Number(options?.slotCount || 3);
  const extraSlotWidth = slotCount > 3 ? (slotCount - 3) * 58 : 0;
  const wideKeep = 256 + extraSlotWidth;
  const wideEnter = 272 + extraSlotWidth;
  const baseEffWidth = showMulti ? availWidth : availWidth + 76;
  const effWidth = baseEffWidth - updateReserve;
  if (currentMode === 'wide') {
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    if (effWidth < wideKeep) return 'compact';
    return 'wide';
  }
  if (currentMode === 'compact') {
    if (effWidth >= wideEnter) return 'wide';
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    return 'compact';
  }
  if (currentMode === 'minimal') {
    if (effWidth >= wideEnter) return 'wide';
    if (effWidth >= 212) return 'compact';
    if (baseEffWidth < 78) return 'ring-only';
    return 'minimal';
  }
  if (effWidth >= wideEnter) return 'wide';
  if (effWidth >= 212) return 'compact';
  if (baseEffWidth >= 92) return 'minimal';
  return 'ring-only';
}

function findIdeWorkbenchTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const workbench = document.querySelector('.monaco-workbench');
    if (!workbench?.querySelector) return null;
    const partTitlebar = workbench.querySelector('.part.titlebar');
    if (!partTitlebar?.querySelector) return null;
    if (partTitlebar.getBoundingClientRect) {
      const pr = partTitlebar.getBoundingClientRect();
      if (pr.width <= 0 || pr.height <= 0) return null;
    }
    const container =
      partTitlebar.querySelector(':scope > .titlebar-container') ||
      partTitlebar.querySelector('.titlebar-container');
    const rightGroup =
      container?.querySelector?.(':scope > .titlebar-right') ||
      container?.querySelector?.('.titlebar-right');
    if (!container || !rightGroup) return null;
    const actionToolbar =
      rightGroup.querySelector?.(':scope > .action-toolbar-container') ||
      rightGroup.querySelector?.('.action-toolbar-container') ||
      null;
    return {
      kind: 'ide-titlebar',
      workbench,
      titlebar: container,
      targetContainer: rightGroup,
      actionToolbar,
    };
  } catch {
    return null;
  }
}

function findHostTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const tb = document.querySelector('[class*="@container/titlebar"]');
    if (tb?.getBoundingClientRect) {
      const r = tb.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
    }
    return tb;
  } catch {
    return null;
  }
}

const COMPOSER_EXCLUDED_ANCESTOR_SELECTOR =
  '.part.titlebar, .part.statusbar, .quick-input-widget, .suggest-widget, .find-widget, .scm-editor, .search-view, [class*="@container/titlebar"]';
const COMPOSER_MODEL_LABEL_RE =
  /\b(?:gemini|claude|gpt|neon|argon|carbon|hydrogen|helix|flash|fable|sonnet|opus|haiku|orchestrator|llama|deepseek|qwen|mistral|model_placeholder|placeholder_m\d+|o[134](?:-\w+)?)\b/i;
const COMPOSER_MODEL_ATTR_RE =
  /\bmodel[-_\s]?(?:select|picker|switch|selector|menu|name)\b|选择模型|切换模型/i;
const COMPOSER_MODE_EXACT_RE = /^(?:auto|自动)$/i;
const COMPOSER_MODE_TEXT_RE =
  /^(?:auto|ask|manual|supervised|autonomous|always\s*allow|turbo|safe|yolo|plan|act|review|confirm|normal|fast|自动|询问|手动|始终允许|受控|规划)(?:\s*(?:mode|模式))?$/i;
const COMPOSER_MODE_ATTR_RE =
  /\b(?:auto(?:nomy|matic)?|execution[-_]?mode|agent[-_]?mode|permission|approval|hitl|policy|mode[-_]?selector|mode[-_]?picker)\b|自动|执行模式|权限模式|审批/i;
const COMPOSER_ICON_FONT_CLASS_RE =
  /\b(?:codicon|material-symbols(?:-\w+)?|material-icons(?:-\w+)?|lucide(?:-\w+)?)\b/i;

function querySimpleSelectorList(root, selectors) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const seen = new Set();
  const out = [];
  for (const sel of selectors) {
    let list = [];
    try {
      list = root.querySelectorAll(sel) || [];
    } catch {
      list = [];
    }
    for (const item of list) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

function extractVisibleButtonText(node, isRoot = true) {
  if (!node) return '';
  const tag = String(node.tagName || node.nodeName || '').toLowerCase();
  if (tag === 'svg' || tag === 'style' || tag === 'script') return '';
  if (!isRoot) {
    if (node.getAttribute?.('aria-hidden') === 'true') return '';
    const cls = String(node.className || '');
    if (cls && COMPOSER_ICON_FONT_CLASS_RE.test(cls)) return '';
  }
  if (tag === '#text' || node.nodeType === 3) {
    return String(node.nodeValue ?? node.textContent ?? '');
  }
  const childNodes = node.childNodes || node.children;
  if (!childNodes || childNodes.length === 0) {
    return String(node.textContent || '');
  }
  let acc = '';
  for (const ch of childNodes) {
    acc += ` ${extractVisibleButtonText(ch, false)}`;
  }
  return acc;
}

function cleanComposerButtonText(btn) {
  const raw = extractVisibleButtonText(btn, true)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.replace(/^[⌃⌄▾▴∨∧^<>›‹+\s]+|[⌃⌄▾▴∨∧^<>›‹\s]+$/g, '').trim();
}

function isComposerModelButtonItem(item) {
  if (!item) return false;
  if (item.cleanText && COMPOSER_MODEL_LABEL_RE.test(item.cleanText)) return true;
  if (item.attrText && COMPOSER_MODEL_ATTR_RE.test(item.attrText)) return true;
  return false;
}

function hasExcludedComposerAncestor(el) {
  if (!el) return false;
  if (typeof el.closest === 'function') {
    try {
      if (el.closest(COMPOSER_EXCLUDED_ANCESTOR_SELECTOR)) return true;
    } catch {
      // 忽略选择器异常并回退祖先链遍历
    }
  }
  let cur = el.parentElement || el.parentNode;
  while (cur) {
    const cls = String(cur.className || '');
    if (
      cls.includes('@container/titlebar') ||
      cls.includes('quick-input-widget') ||
      cls.includes('suggest-widget') ||
      cls.includes('find-widget') ||
      cls.includes('scm-editor') ||
      cls.includes('search-view') ||
      (cls.includes('part') && (cls.includes('titlebar') || cls.includes('statusbar')))
    ) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return false;
}

function isNodeHiddenByStyle(el) {
  if (!el) return true;
  if (el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      if (cs?.display === 'none' || cs?.visibility === 'hidden') return true;
    } catch {
      // 忽略样式读取异常
    }
  }
  return false;
}

function getInFlowHostChildren(container, capsuleNode, portalNode) {
  const rawChildren = container?.children || [];
  const out = [];
  for (const ch of rawChildren) {
    if (!ch || ch === capsuleNode || ch === portalNode) continue;
    if (ch.id === CAPSULE_HOST_ID || ch.id === PORTAL_HOST_ID) continue;
    if (ch.hasAttribute?.('hidden')) continue;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const cs = window.getComputedStyle(ch);
        if (cs?.display === 'none') continue;
        if (cs?.position === 'absolute' || cs?.position === 'fixed') continue;
      } catch {
        // 忽略计算样式异常
      }
    }
    out.push(ch);
  }
  return out;
}

function isHorizontalFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\b(?:inline-)?flex\b/.test(cls) && !/\bflex-col\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      const disp = String(cs?.display || '');
      const dir = String(cs?.flexDirection || 'row');
      if (disp.includes('flex') && !dir.startsWith('column')) return true;
    } catch {
      // 忽略计算样式异常
    }
  }
  return false;
}

function isSpaceDistributedFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\bjustify-(?:between|around|evenly)\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const jc = String(window.getComputedStyle(el)?.justifyContent || '');
      if (jc.includes('space-between') || jc.includes('space-around') || jc.includes('space-evenly')) {
        return true;
      }
    } catch {
      // 忽略计算样式异常
    }
  }
  return false;
}

function buildComposerDockDescriptor(autoBtn, composerCard, bottomRowBtns, capsuleNode, portalNode, patchedNode) {
  if (!autoBtn || !composerCard) return null;
  let item = autoBtn;
  while (
    (item.parentElement || item.parentNode) &&
    (item.parentElement || item.parentNode) !== composerCard &&
    (item.parentElement || item.parentNode) !== document.body
  ) {
    const parent = item.parentElement || item.parentNode;
    const hostSiblings = getInFlowHostChildren(parent, capsuleNode, portalNode);
    if (hostSiblings.length >= 2) break;
    const grandParent = parent.parentElement || parent.parentNode;
    const parentCls = String(parent.className || '');
    const parentInlineMl = String(parent.style?.marginLeft || '').trim();
    const isSingleClusterInSplitRow =
      !/\b(?:relative|ml-auto|ms-auto)\b/.test(parentCls) &&
      parentInlineMl !== 'auto' &&
      isHorizontalFlexContainer(parent) &&
      grandParent &&
      isSpaceDistributedFlexContainer(grandParent) &&
      getInFlowHostChildren(grandParent, capsuleNode, portalNode).length >= 2;
    if (isSingleClusterInSplitRow) {
      break;
    }
    item = parent;
  }

  const anchorNode = item;
  const targetContainer = anchorNode.parentElement || anchorNode.parentNode;
  if (!targetContainer) return null;

  const hostChildren = getInFlowHostChildren(targetContainer, capsuleNode, portalNode);
  const anchorIdx = hostChildren.indexOf(anchorNode);
  const isFirstHostChild = anchorIdx <= 0;

  let needsAutoMarginTransfer = false;
  let patchMarginNode = null;

  if (!isFirstHostChild) {
    const cls = String(anchorNode.className || '');
    const inlineMl = String(anchorNode.style?.marginLeft || '').trim();
    let computedLargeMl = false;
    if (
      patchedNode !== anchorNode &&
      typeof window !== 'undefined' &&
      typeof window.getComputedStyle === 'function'
    ) {
      try {
        const mlPx = parseFloat(window.getComputedStyle(anchorNode)?.marginLeft) || 0;
        const prevSib = hostChildren[anchorIdx - 1];
        const aRect = anchorNode.getBoundingClientRect?.();
        const pRect = prevSib?.getBoundingClientRect?.();
        if (mlPx > 24 && aRect && pRect && aRect.left - pRect.right >= mlPx - 6) {
          computedLargeMl = true;
        }
      } catch {
        // 忽略边距测量异常
      }
    }

    if (
      /\b(?:ml-auto|ms-auto)\b/.test(cls) ||
      inlineMl === 'auto' ||
      patchedNode === anchorNode ||
      computedLargeMl
    ) {
      needsAutoMarginTransfer = true;
      patchMarginNode = anchorNode;
    } else if (isSpaceDistributedFlexContainer(targetContainer)) {
      needsAutoMarginTransfer = true;
    }
  }

  const autoRect = anchorNode.getBoundingClientRect?.() || autoBtn.getBoundingClientRect?.();
  let leftClusterRightEdge = 0;
  if (autoRect && Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry.btn === autoBtn || anchorNode.contains?.(entry.btn)) continue;
      if (entry.rect.left < autoRect.left - 2 && entry.rect.right <= autoRect.left + 4) {
        if (entry.rect.right > leftClusterRightEdge) {
          leftClusterRightEdge = entry.rect.right;
        }
      }
    }
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer,
    actionToolbar: patchMarginNode,
    anchorNode,
    needsAutoMarginTransfer,
    leftClusterRightEdge,
  };
}

function buildComposerRightEndDockDescriptor(
  leftAnchorBtn,
  composerCard,
  bottomRowBtns,
  capsuleNode,
  portalNode
) {
  if (!leftAnchorBtn || !composerCard) return null;
  const cardRect = composerCard.getBoundingClientRect?.();
  const minRowWidth = cardRect && cardRect.width > 0 ? cardRect.width * 0.65 : 180;
  let toolbarRow = null;
  let cur = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
  for (let d = 0; d < 8 && cur && cur !== composerCard && cur !== document.body; d += 1) {
    const r = cur.getBoundingClientRect?.();
    if (r && r.width >= minRowWidth && r.height > 0 && r.height <= 60 && isHorizontalFlexContainer(cur)) {
      toolbarRow = cur;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  if (!toolbarRow) {
    const p = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
    if (!p || !isHorizontalFlexContainer(p)) return null;
    toolbarRow = p;
  }

  let leftClusterRightEdge = 0;
  if (Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry?.rect?.right > leftClusterRightEdge) {
        leftClusterRightEdge = entry.rect.right;
      }
    }
  }

  const rowChildren = getInFlowHostChildren(toolbarRow, capsuleNode, portalNode);
  const lastChild = rowChildren.length >= 2 ? rowChildren[rowChildren.length - 1] : null;
  if (
    lastChild &&
    !lastChild.contains?.(leftAnchorBtn) &&
    isHorizontalFlexContainer(lastChild) &&
    getInFlowHostChildren(lastChild, capsuleNode, portalNode).length === 0
  ) {
    return {
      kind: 'composer',
      workbench: null,
      titlebar: composerCard,
      targetContainer: lastChild,
      actionToolbar: null,
      anchorNode: null,
      needsAutoMarginTransfer: false,
      leftClusterRightEdge,
    };
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer: toolbarRow,
    actionToolbar: null,
    anchorNode: null,
    needsAutoMarginTransfer: true,
    leftClusterRightEdge,
  };
}

function collectComposerBottomButtons(container, editorEl, editorRect, capsuleNode, portalNode) {
  const rawBtns = querySimpleSelectorList(container, ['button', '[role="button"]', '[aria-haspopup]']);
  const hostBtns = [];
  for (const btn of rawBtns) {
    if (!btn || btn === editorEl || editorEl?.contains?.(btn)) continue;
    if (editorEl && btn.contains?.(editorEl)) continue;
    if (
      btn.id === CAPSULE_HOST_ID ||
      btn.id === PORTAL_HOST_ID ||
      capsuleNode?.contains?.(btn) ||
      portalNode?.contains?.(btn)
    ) {
      continue;
    }
    if (isNodeHiddenByStyle(btn)) continue;
    // 仅排除嵌套在真实紧凑按钮内部的图标/子触发器，避免外层卡片级 role="button" 误杀工具栏按钮
    let nestedInBtn = false;
    let p = btn.parentElement || btn.parentNode;
    while (p && p !== container) {
      const pTag = String(p.tagName || '').toLowerCase();
      if (pTag === 'button') {
        nestedInBtn = true;
        break;
      }
      if (
        (p.getAttribute?.('role') === 'button' || p.hasAttribute?.('aria-haspopup')) &&
        !(editorEl && p.contains?.(editorEl))
      ) {
        const pr = p.getBoundingClientRect?.();
        if (pr && pr.height > 0 && pr.height <= 48 && pr.width > 0 && pr.width <= 360) {
          nestedInBtn = true;
          break;
        }
      }
      p = p.parentElement || p.parentNode;
    }
    if (nestedInBtn) continue;

    const br = btn.getBoundingClientRect?.();
    if (!br || br.width <= 0 || br.height <= 0 || br.height > 48) continue;
    const centerY = (br.top + br.bottom) / 2;
    if (editorRect && centerY < editorRect.top - 4) continue;
    hostBtns.push({
      btn,
      rect: br,
      centerY,
      centerX: (br.left + br.right) / 2,
      cleanText: cleanComposerButtonText(btn),
      attrText: `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim(),
    });
  }
  if (hostBtns.length === 0) return [];
  let maxCenterY = -Infinity;
  for (const item of hostBtns) {
    if (item.centerY > maxCenterY) maxCenterY = item.centerY;
  }
  const bottomBand = hostBtns.filter((item) => Math.abs(item.centerY - maxCenterY) <= 22);
  bottomBand.sort((a, b) => a.rect.left - b.rect.left);
  return bottomBand;
}

function pickAutoButtonFromRow(bottomRowBtns, containerRect, options = undefined) {
  if (!Array.isArray(bottomRowBtns) || bottomRowBtns.length === 0) return null;
  const requireModelForFallback = Boolean(options?.requireModelForFallback);
  const rightSplitX = containerRect ? containerRect.left + containerRect.width * 0.35 : 0;
  const rightFirst = [
    ...bottomRowBtns.filter((b) => b.centerX >= rightSplitX),
    ...bottomRowBtns.filter((b) => b.centerX < rightSplitX),
  ];

  // Tier 1: 精确文本 Auto / 自动 匹配
  for (const item of rightFirst) {
    if (COMPOSER_MODE_EXACT_RE.test(item.cleanText)) {
      return { btn: item.btn, tier: 1 };
    }
  }

  // Tier 2: 执行/权限模式文案或无障碍语义属性匹配（排除模型选择器按钮）
  for (const item of rightFirst) {
    if (isComposerModelButtonItem(item)) continue;
    if (
      (item.cleanText && COMPOSER_MODE_TEXT_RE.test(item.cleanText)) ||
      (item.attrText && COMPOSER_MODE_ATTR_RE.test(item.attrText))
    ) {
      return { btn: item.btn, tier: 2 };
    }
  }

  const hasModelBtn = bottomRowBtns.some(isComposerModelButtonItem);

  // Tier 3: 几何右簇首按钮兜底（适配 Antigravity IDE 无 Auto 按钮、右侧为发送/语音按钮的输入栏布局）
  if (bottomRowBtns.length >= 2 && (!requireModelForFallback || hasModelBtn)) {
    let maxGap = -Infinity;
    let splitIdx = -1;
    for (let i = 1; i < bottomRowBtns.length; i += 1) {
      const gap = bottomRowBtns[i].rect.left - bottomRowBtns[i - 1].rect.right;
      if (gap > maxGap) {
        maxGap = gap;
        splitIdx = i;
      }
    }
    if (splitIdx >= 1 && maxGap >= 16) {
      return { btn: bottomRowBtns[splitIdx].btn, tier: 3 };
    }
  }

  // Tier 4: 输入为空时若右侧发送按钮暂时隐藏、仅左侧存在模型选择器按钮，停靠至工具栏最右侧
  if (hasModelBtn && containerRect && containerRect.width >= 200) {
    const lastItem = bottomRowBtns[bottomRowBtns.length - 1];
    if (lastItem.rect.right <= containerRect.left + containerRect.width * 0.72) {
      return { btn: null, leftAnchorBtn: lastItem.btn, tier: 4 };
    }
  }

  return null;
}

function resolveComposerEditorRect(ed) {
  const er = ed?.getBoundingClientRect?.();
  if (er && er.width >= 80 && er.height >= 12) return er;
  let cur = ed;
  for (let d = 0; d < 6 && cur; d += 1) {
    if (String(cur.className || '').includes('monaco-editor')) {
      const mr = cur.getBoundingClientRect?.();
      if (mr && mr.width >= 80 && mr.height >= 12) return mr;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return er || null;
}

function findHostComposerAutoTarget(capsuleNode = null, portalNode = null, patchedNode = null) {
  try {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }
    const capEl = capsuleNode || document.getElementById?.(CAPSULE_HOST_ID) || null;
    const porEl = portalNode || document.getElementById?.(PORTAL_HOST_ID) || null;
    const activeRouteId = extractHostRouteCascadeId();

    // 1. 优先从活跃会话的输入框编辑器向上定位底部工具栏与 Auto / 右簇发送按钮
    const rawEditors = querySimpleSelectorList(document, [
      'textarea',
      '[contenteditable]',
      '[role="textbox"]',
      '[data-lexical-editor]',
      '.ProseMirror',
      '.monaco-editor',
    ]);
    const scoredEditors = [];
    for (const ed of rawEditors) {
      if (!ed || capEl?.contains?.(ed) || porEl?.contains?.(ed)) continue;
      if (ed.hasAttribute?.('contenteditable')) {
        const ce = String(ed.getAttribute('contenteditable') || '').trim().toLowerCase();
        if (ce === 'false' && ed.getAttribute?.('role') !== 'textbox') continue;
      }
      if (isNodeHiddenByStyle(ed) || hasExcludedComposerAncestor(ed)) continue;
      const er = resolveComposerEditorRect(ed);
      if (!er || er.width < 100 || er.height < 12 || er.height > 540) continue;

      let score = Math.min(1200, er.width) + Math.max(0, er.bottom) * 0.2;
      if (activeRouteId) {
        let anc = ed.parentElement || ed.parentNode;
        while (anc) {
          const cid = anc.getAttribute?.('data-cascade-id');
          if (cid) {
            score += cid === activeRouteId ? 4000 : -2000;
            break;
          }
          anc = anc.parentElement || anc.parentNode;
        }
      }
      if (
        document.activeElement &&
        (ed === document.activeElement || ed.contains?.(document.activeElement))
      ) {
        score += 1000;
      }
      scoredEditors.push({ ed, rect: er, score });
    }
    scoredEditors.sort((a, b) => b.score - a.score);

    for (const { ed, rect: er } of scoredEditors) {
      const isMonacoCandidate = String(ed.className || '').includes('monaco-editor') ||
        String(ed.className || '').includes('inputarea');
      let tier3Candidate = null;
      let tier4Candidate = null;
      let cur = ed.parentElement || ed.parentNode;
      for (let depth = 0; depth < 18 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        const tag = String(cur.tagName || '').toLowerCase();
        if (tag === 'main' || String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (cr && cr.height > 680) break;
        if (cr && cr.width >= 180 && cr.height > 0) {
          const bottomRowBtns = collectComposerBottomButtons(cur, ed, er, capEl, porEl);
          const picked = pickAutoButtonFromRow(bottomRowBtns, cr, {
            requireModelForFallback: isMonacoCandidate,
          });
          if (picked) {
            if (picked.tier <= 2) {
              const desc = buildComposerDockDescriptor(
                picked.btn,
                cur,
                bottomRowBtns,
                capEl,
                porEl,
                patchedNode
              );
              if (desc) return desc;
            } else if (picked.tier === 3 && !tier3Candidate) {
              tier3Candidate = { btn: picked.btn, card: cur, bottomRowBtns };
            } else if (picked.tier === 4 && !tier4Candidate) {
              tier4Candidate = { leftAnchorBtn: picked.leftAnchorBtn, card: cur, bottomRowBtns };
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
      if (tier3Candidate) {
        const desc = buildComposerDockDescriptor(
          tier3Candidate.btn,
          tier3Candidate.card,
          tier3Candidate.bottomRowBtns,
          capEl,
          porEl,
          patchedNode
        );
        if (desc) return desc;
      }
      if (tier4Candidate) {
        const desc = buildComposerRightEndDockDescriptor(
          tier4Candidate.leftAnchorBtn,
          tier4Candidate.card,
          tier4Candidate.bottomRowBtns,
          capEl,
          porEl
        );
        if (desc) return desc;
      }
    }

    // 2. 兜底路径：编辑器自定义封装或暂时只读时，直接扫描底部包含模型选择器或 Auto 按钮的输入工具栏
    const vh = Number(window.innerHeight || 800);
    const allBtns = querySimpleSelectorList(document, ['button', '[role="button"]', '[aria-haspopup]']);
    let modelToolbarFallback = null;
    for (const btn of allBtns) {
      if (!btn || capEl?.contains?.(btn) || porEl?.contains?.(btn)) continue;
      if (isNodeHiddenByStyle(btn) || hasExcludedComposerAncestor(btn)) continue;
      const br = btn.getBoundingClientRect?.();
      if (!br || br.width <= 0 || br.height <= 0 || br.height > 48 || br.top < vh * 0.2) continue;
      const clean = cleanComposerButtonText(btn);
      const attr = `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim();
      const itemProbe = { cleanText: clean, attrText: attr };
      const isModeBtn =
        COMPOSER_MODE_EXACT_RE.test(clean) ||
        (!isComposerModelButtonItem(itemProbe) &&
          ((clean && COMPOSER_MODE_TEXT_RE.test(clean)) || (attr && COMPOSER_MODE_ATTR_RE.test(attr))));
      const isModelBtn = isComposerModelButtonItem(itemProbe);
      if (!isModeBtn && !isModelBtn) continue;

      let cur = btn.parentElement || btn.parentNode;
      for (let depth = 0; depth < 12 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        if (String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (!cr || cr.height > 560) break;
        if (cr.width >= 200) {
          const rowBtns = collectComposerBottomButtons(cur, null, null, capEl, porEl);
          if (isModeBtn) {
            const hasModelSibling = rowBtns.some((b) => b.btn !== btn && isComposerModelButtonItem(b));
            if (hasModelSibling) {
              const desc = buildComposerDockDescriptor(btn, cur, rowBtns, capEl, porEl, patchedNode);
              if (desc) return desc;
            }
          } else if (isModelBtn && !modelToolbarFallback) {
            const picked = pickAutoButtonFromRow(rowBtns, cr, { requireModelForFallback: true });
            if (picked) {
              const desc =
                picked.tier <= 3 && picked.btn
                  ? buildComposerDockDescriptor(picked.btn, cur, rowBtns, capEl, porEl, patchedNode)
                  : picked.tier === 4 && picked.leftAnchorBtn
                    ? buildComposerRightEndDockDescriptor(
                        picked.leftAnchorBtn,
                        cur,
                        rowBtns,
                        capEl,
                        porEl
                      )
                    : null;
              if (desc) {
                if (picked.tier <= 2) return desc;
                modelToolbarFallback = desc;
                break;
              }
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
    }
    if (modelToolbarFallback) return modelToolbarFallback;
  } catch {
    // 忽略输入框探测异常
  }
  return null;
}

function isImmediatelyBeforeNode(node, refNode) {
  if (!node || !refNode) return false;
  if (node.nextElementSibling !== undefined) {
    return node.nextElementSibling === refNode;
  }
  if (node.nextSibling !== undefined) {
    return node.nextSibling === refNode;
  }
  const parent = node.parentElement || node.parentNode;
  if (!parent?.children) return false;
  const idx = Array.prototype.indexOf.call(parent.children, node);
  return idx >= 0 && parent.children[idx + 1] === refNode;
}

function isIdeExtensionChatFrame() {
  try {
    if (typeof window === 'undefined') return false;
    if (readInjectedWindowBridge()?.isIdeChatFrame === true) return true;
    return /[?&]extension(?:View|Variant)=/i.test(String(window.location?.search || ''));
  } catch {
    return false;
  }
}

function resolveActiveDockTarget(options = undefined) {
  const settings = telemetryStore.getState().telemetry?.settings;
  const rawMode =
    settings?.windowMountMode ??
    readInjectedWindowBridge()?.mountMode;
  const mountMode =
    options?.mountMode ||
    normalizeClientWindowMountMode(rawMode, settings?.enableWindowOverlay);
  if (isIdeExtensionChatFrame()) {
    if (mountMode !== 'composer') return null;
    return findHostComposerAutoTarget(
      options?.capsuleNode || null,
      options?.portalNode || null,
      options?.patchedNode || null
    );
  }
  if (mountMode === 'composer') {
    const composerTarget = findHostComposerAutoTarget(
      options?.capsuleNode || null,
      options?.portalNode || null,
      options?.patchedNode || null
    );
    if (composerTarget) return composerTarget;
  }
  const ideTarget = findIdeWorkbenchTitlebar();
  if (ideTarget) return ideTarget;
  const titlebar = findHostTitlebar();
  if (!titlebar) return null;
  let targetContainer = titlebar;
  try {
    const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
    if (rightGroup && rightGroup !== titlebar.firstElementChild) {
      targetContainer = rightGroup;
    }
  } catch {
    // 忽略子选择器不兼容场景
  }
  return {
    kind: 'flow',
    workbench: null,
    titlebar,
    targetContainer,
    actionToolbar: null,
  };
}

function findNativeTopRightAnchor() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
    if (auxToggle?.closest) {
      return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
    }
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of candidates) {
      const text = String(btn.textContent || '').trim();
      if (
        (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) &&
        btn.getBoundingClientRect?.().top < 52
      ) {
        return btn.closest?.('div.flex.items-center, div.absolute.right-0') || btn;
      }
    }
    return document.querySelector('div.absolute.right-0.top-0');
  } catch {
    return null;
  }
}

function getLeftSidebarRightEdge(vw) {
  try {
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      if (document.querySelector('.monaco-workbench')) {
        return 0;
      }
      const navEl = document.querySelector('div[role="navigation"]');
      if (navEl?.getBoundingClientRect) {
        const nr = navEl.getBoundingClientRect();
        if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 280) {
          return Math.ceil(nr.right);
        }
      }
    }
  } catch {
    // 忽略侧栏测量异常
  }
  return 0;
}

/**
 * 在主窗口挂载双栖顶栏胶囊与完整四标签悬浮面板，并注册 `window.__AGUsageMonitorOverlay` 生命周期句柄。
 */
export function mountWindowOverlay() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  // 先读取旧实例缓存的遥测快照与展开态（热升级时无缝承接数据与悬停状态，杜绝闪烁或关开），再安全卸载旧实例
  let carryOverTelemetry = null;
  let carryOverTooltipOpen = false;
  let carryOverPopoverOpen = false;
  let carryOverMultiHoverOpen = false;
  let carryOverMultiPinnedOpen = false;
  let carryOverPointer = null;
  try {
    const prevOv = window[WINDOW_OVERLAY_KEY];
    carryOverTelemetry = prevOv?.getTelemetrySnapshot?.() || null;
    carryOverTooltipOpen = Boolean(prevOv?.isHoverOpen?.());
    carryOverPopoverOpen = Boolean(prevOv?.isOpen?.());
    carryOverMultiHoverOpen = Boolean(prevOv?.isMultiHoverOpen?.());
    carryOverMultiPinnedOpen = Boolean(prevOv?.isMultiPinnedOpen?.());
    carryOverPointer = prevOv?.getLastPointer?.() || null;
    prevOv?.[WINDOW_OVERLAY_METHODS.dispose]?.();
  } catch {
    // 忽略旧实例卸载异常
  }
  try {
    document.getElementById(CAPSULE_HOST_ID)?.remove?.();
    document.getElementById(PORTAL_HOST_ID)?.remove?.();
  } catch {
    // 忽略残留节点清理异常
  }

  const bridgeConfig = getWindowBridgeConfig();
  const bundleVersion = String(bridgeConfig?.bundleVersion || '');
  const stylesCss = String(bridgeConfig?.stylesCss || '');
  const seedTelemetry =
    (bridgeConfig?.initialTelemetry && typeof bridgeConfig.initialTelemetry === 'object'
      ? bridgeConfig.initialTelemetry
      : null) || carryOverTelemetry;
  if (bridgeConfig?.initialTelemetry) {
    delete bridgeConfig.initialTelemetry;
  }
  if (seedTelemetry) {
    setI18nLanguage(seedTelemetry?.settings?.language);
    telemetryStore.setState({
      telemetry: seedTelemetry,
      minuteTick: Math.floor(Date.now() / 30000),
      syncState: 'idle',
    });
  } else {
    setI18nLanguage(telemetryStore.getState().telemetry?.settings?.language);
  }

  let disposed = false;
  let popoverOpen = false;
  let tooltipOpen = false;
  let multiOpen = false;
  let multiPinned = false;
  let hoverLeaveTimer = null;
  let multiLeaveTimer = null;
  let hasPointerCoords = Boolean(
    carryOverPointer &&
      Number.isFinite(carryOverPointer.x) &&
      Number.isFinite(carryOverPointer.y)
  );
  let lastPointerX = hasPointerCoords ? carryOverPointer.x : -1;
  let lastPointerY = hasPointerCoords ? carryOverPointer.y : -1;
  let layoutMode = 'wide';
  let observedTitlebar = null;
  let dockRafId = 0;
  let lastObservedRouteId = extractHostRouteCascadeId();

  function recordPointerCoords(e) {
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      hasPointerCoords = true;
    }
  }

  function isPointerStillInCapsule() {
    if (!hasPointerCoords || document.hidden || !capsuleBtn.getBoundingClientRect) {
      return false;
    }
    const r = capsuleBtn.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    let rightBound = r.right;
    if (!topbarUpdateBtn.hasAttribute('hidden') && topbarUpdateBtn.getBoundingClientRect) {
      const ur = topbarUpdateBtn.getBoundingClientRect();
      if (ur.width > 0 && ur.height > 0) {
        rightBound = Math.max(rightBound, ur.right);
      }
    }
    return (
      lastPointerX >= r.left - 1 &&
      lastPointerX <= rightBound + 1 &&
      lastPointerY >= r.top - 1 &&
      lastPointerY <= r.bottom + 1
    );
  }

  function isPointerInMultiZone() {
    if (!hasPointerCoords || document.hidden || multiBtn.hasAttribute('hidden')) {
      return false;
    }
    const bridgePad = multiOpen ? 12 : 1;
    if (multiBtn.getBoundingClientRect) {
      const mr = multiBtn.getBoundingClientRect();
      if (
        mr.width > 0 &&
        mr.height > 0 &&
        lastPointerX >= mr.left - 1 &&
        lastPointerX <= mr.right + 1 &&
        lastPointerY >= mr.top - bridgePad &&
        lastPointerY <= mr.bottom + bridgePad
      ) {
        return true;
      }
    }
    if (multiOpen && multiPanelEl.getBoundingClientRect) {
      const pr = multiPanelEl.getBoundingClientRect();
      if (
        pr.width > 0 &&
        pr.height > 0 &&
        lastPointerX >= pr.left - 1 &&
        lastPointerX <= pr.right + 1 &&
        lastPointerY >= pr.top - 8 &&
        lastPointerY <= pr.bottom + 12
      ) {
        return true;
      }
    }
    return false;
  }

  function scheduleMultiHoverClose() {
    if (multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
    }
    multiLeaveTimer = setTimeout(() => {
      multiLeaveTimer = null;
      if (disposed || multiPinned || !multiOpen) return;
      let nativeHover = false;
      try {
        nativeHover = Boolean(
          multiBtn.matches?.(':hover') || multiPanelEl.matches?.(':hover')
        );
      } catch {
        nativeHover = false;
      }
      if (nativeHover || isPointerInMultiZone()) {
        return;
      }
      setMultiOpen(false);
    }, 90);
  }

  function inspectSessionInMonitor(cascadeId) {
    if (!cascadeId || cascadeId === 'current') return;
    uiStore.setState({
      activeView: 'overview',
      selectedAgentScope: 'all',
      ctxInspectorAgentId: 'auto',
    });
    telemetryStore.setState({ selectedConversationId: cascadeId });
    void fetchTelemetry({ force: false });
    setMultiOpen(false);
    setPopoverOpen(true);
  }

  // --- 1. 创建顶栏/输入框双胶囊 Shadow Host（左：多会话实时信息；右：单会话指标胶囊） ---
  const capsuleHost = document.createElement('div');
  capsuleHost.id = CAPSULE_HOST_ID;
  capsuleHost.className = 'wm-capsule-host';
  capsuleHost.setAttribute('data-dock', 'fixed');
  capsuleHost.setAttribute('data-layout', layoutMode);
  // 隔离冒泡事件，防止嵌入输入框工具栏时点击或回车误触外层编辑框聚焦或表单提交
  capsuleHost.addEventListener?.('mousedown', (e) => e.stopPropagation?.());
  capsuleHost.addEventListener?.('click', (e) => e.stopPropagation?.());
  capsuleHost.addEventListener?.('keydown', (e) => {
    if (e?.key !== 'Escape') {
      e.stopPropagation?.();
    }
  });
  const capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });

  const capsuleStyleEl = document.createElement('style');
  capsuleStyleEl.textContent = stylesCss;
  capsuleShadow.appendChild(capsuleStyleEl);

  // 左侧无边框多会话实时触发按钮（固定预占宽度，不随运行数跳动）
  const multiDot = h('span', { className: 'wm-multi-dot' });
  const multiLabel = h('span', { className: 'wm-multi-label', text: t('capsule.multiZero') });
  const multiBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-multi-btn',
      'aria-label': t('capsule.ariaMulti'),
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        if (multiOpen && multiPinned) {
          setMultiOpen(false);
        } else {
          setMultiOpen(true, { pinned: true });
        }
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          setMultiOpen(true, { pinned: false });
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiDot, multiLabel]
  );

  // 构建可复用的预占胶囊槽位节点（由 CapsuleBarWidget 共享创建，支持 1..6 项动态槽位）
  const capsuleSlots = [
    createCapsuleSlotNode(0, 'tps'),
    createCapsuleSlotNode(1, 'ttft'),
    createCapsuleSlotNode(2, 'context'),
    createCapsuleSlotNode(3, 'none'),
    createCapsuleSlotNode(4, 'none'),
    createCapsuleSlotNode(5, 'none'),
  ];
  const capsuleSeps = [
    h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
    h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
    h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
  ];
  let lastSlotCount = 3;
  let lastShowMulti = true;
  let lastShowUpdate = false;
  let isTopbarUpdating = false;

  const updateDot = h('span', { className: 'wm-update-dot', hidden: true });
  const topbarUpdateIcon = createSvgIcon('arrow-down', { size: 10 });
  const topbarUpdateLabel = h('span', {
    className: 'wm-update-label',
    text: t('capsule.newVersion'),
  });
  const topbarUpdateBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-update-btn',
      hidden: true,
      'aria-label': t('capsule.ariaUpdateTitle'),
      title: t('capsule.ariaUpdateTitle'),
      onClick: async (e) => {
        e.stopPropagation();
        if (isTopbarUpdating) return;
        isTopbarUpdating = true;
        patchClasses(topbarUpdateBtn, { 'is-updating': true });
        patchSvgIcon(topbarUpdateIcon, 'refresh');
        patchText(topbarUpdateLabel, t('capsule.updating'));
        patchAttr(topbarUpdateBtn, 'disabled', true);
        try {
          const res = await triggerPluginUpdate();
          if (!res?.ok) {
            uiStore.setState({ activeView: 'settings' });
            setPopoverOpen(true);
          }
        } catch {
          uiStore.setState({ activeView: 'settings' });
          setPopoverOpen(true);
        } finally {
          isTopbarUpdating = false;
          patchClasses(topbarUpdateBtn, { 'is-updating': false });
          patchSvgIcon(topbarUpdateIcon, 'arrow-down');
          patchAttr(topbarUpdateBtn, 'disabled', false);
          const cs = telemetryStore.getState().telemetry?.cloudStatus;
          patchText(
            topbarUpdateLabel,
            cs?.latestPluginVersion ? `v${cs.latestPluginVersion}` : t('capsule.newVersion')
          );
        }
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
          hoverLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          if (multiOpen) {
            setMultiOpen(false);
          }
          setTooltipOpen(true);
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
        }
        hoverLeaveTimer = setTimeout(() => {
          hoverLeaveTimer = null;
          if (disposed || popoverOpen) return;
          let nativeHover = false;
          try {
            nativeHover = Boolean(
              capsuleBtn.matches?.(':hover') || topbarUpdateBtn.matches?.(':hover')
            );
          } catch {
            nativeHover = false;
          }
          if (nativeHover || isPointerStillInCapsule()) {
            return;
          }
          setTooltipOpen(false);
        }, 40);
      },
    },
    [topbarUpdateIcon, topbarUpdateLabel]
  );

  const capsuleBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-capsule-btn',
      'aria-label': t('capsule.ariaMonitor'),
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        setPopoverOpen(!popoverOpen);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
          hoverLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          if (multiOpen) {
            setMultiOpen(false);
          }
          setTooltipOpen(true);
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
        }
        hoverLeaveTimer = setTimeout(() => {
          hoverLeaveTimer = null;
          if (disposed || popoverOpen) return;
          let nativeHover = false;
          try {
            nativeHover = Boolean(
              capsuleBtn.matches?.(':hover') || topbarUpdateBtn.matches?.(':hover')
            );
          } catch {
            nativeHover = false;
          }
          if (nativeHover || isPointerStillInCapsule()) {
            return;
          }
          setTooltipOpen(false);
        }, 40);
      },
    },
    [
      capsuleSlots[0].el,
      capsuleSeps[0],
      capsuleSlots[1].el,
      capsuleSeps[1],
      capsuleSlots[2].el,
      capsuleSeps[2],
      capsuleSlots[3].el,
      capsuleSeps[3],
      capsuleSlots[4].el,
      capsuleSeps[4],
      capsuleSlots[5].el,
      updateDot,
    ]
  );
  capsuleShadow.appendChild(multiBtn);
  capsuleShadow.appendChild(capsuleBtn);
  capsuleShadow.appendChild(topbarUpdateBtn);

  // --- 2. 创建 Body 顶层浮层 Portal Shadow Host ---
  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_HOST_ID;
  portalHost.className = 'wm-portal-host';
  const portalShadow = portalHost.attachShadow({ mode: 'open' });

  const portalStyleEl = document.createElement('style');
  portalStyleEl.textContent = stylesCss;
  portalShadow.appendChild(portalStyleEl);

  const initialSettings = telemetryStore.getState().telemetry?.settings;

  // 悬停全景概览浮层（完全解耦至 widgetRegistry，由 hoverModules 动态驱动 0..4 个独立组件，零硬编码）
  const hoverUpdateVerText = h('span', { text: t('capsule.hoverNewVerGeneric') });
  const hoverUpdateHintText = h('span', {
    className: 'wm-hover-update-hint',
    text: t('capsule.hoverUpdateHintTopbarGeneric'),
  });
  const hoverUpdateBar = h(
    'div',
    {
      className: 'wm-hover-update-bar',
      hidden: true,
    },
    [
      h('span', { className: 'wm-hover-update-left' }, [
        createSvgIcon('arrow-down', { size: 11 }),
        hoverUpdateVerText,
      ]),
      hoverUpdateHintText,
    ]
  );

  const hoverWidgetsContainer = h('div', { className: 'wm-hover-widgets' });
  const hoverWidgetHost = createDynamicWidgetHost({
    containerEl: hoverWidgetsContainer,
    mode: 'hover',
    isVisibleFn: () => Boolean(tooltipOpen && !disposed),
    initialModuleKeys: DEFAULT_CLIENT_HOVER_MODULES,
  });

  const hoverTipEl = h(
    'div',
    {
      className: 'wm-hover-tip',
      hidden: true,
    },
    [hoverUpdateBar, hoverWidgetsContainer]
  );

  // 左侧多会话实时看板浮层（受控复用 LiveActivityWidget，保持零硬编码与同一套计时器状态机）
  const multiPinBadge = h('span', {
    className: 'wm-pin-badge',
    hidden: true,
    text: t('multi.pinned'),
  });
  const multiRunningMetaEl = h('span', {
    className: 'panel-meta text-mono',
    text: t('multi.loading'),
  });
  const multiEmptyTextEl = h('span', { text: t('multi.empty') });
  const multiEmptyEl = h('div', { className: 'wm-multi-empty' }, [
    h('span', { className: 'wm-multi-empty-left' }, [
      h('span', { className: 'wm-idle-dot' }),
      multiEmptyTextEl,
    ]),
  ]);
  const multiRunningWidget = LiveActivityWidget({
    defaultExpandRunningSubs: true,
    showSessionExtras: true,
    isVisibleFn: () => Boolean(multiOpen && !document.hidden && !disposed),
    onSelectSession: inspectSessionInMonitor,
    onLayoutChange: () => {
      if (multiOpen) {
        positionFloatingElements();
      }
    },
  });

  const multiTitleTextEl = h('span', { text: t('multi.title') });
  const multiHeaderEl = h('div', { className: 'panel-header wm-multi-header' }, [
    h('span', { className: 'panel-title' }, [
      createSvgIcon('pulse', { size: 13 }),
      multiTitleTextEl,
      multiPinBadge,
    ]),
    multiRunningMetaEl,
  ]);

  const multiPanelEl = h(
    'div',
    {
      className: 'wm-multi-panel',
      role: 'dialog',
      'aria-label': t('multi.ariaDialog'),
      hidden: true,
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiHeaderEl, multiEmptyEl, multiRunningWidget.el]
  );

  // 完整四标签悬浮容器
  uiStore.setState({ monitorVisible: false });
  const appInstance = App();
  const popoverEl = h(
    'div',
    {
      className: 'wm-popover-panel',
      role: 'dialog',
      'aria-label': t('capsule.ariaMonitor'),
      hidden: true,
    },
    [appInstance.el]
  );

  function syncPortalAppearance(settings) {
    applyAppearanceToRoot(capsuleHost, settings, { includeFontScale: false });
    applyAppearanceToRoot(portalHost, settings, { includeFontScale: true });
    const scaleKey = normalizeClientFontScale(settings?.fontScale);
    popoverEl.setAttribute?.('data-font-scale', scaleKey);
    hoverTipEl.setAttribute?.('data-font-scale', scaleKey);
    multiPanelEl.setAttribute?.('data-font-scale', scaleKey);
  }

  portalShadow.appendChild(multiPanelEl);
  portalShadow.appendChild(hoverTipEl);
  portalShadow.appendChild(popoverEl);
  syncPortalAppearance(initialSettings);
  (document.body || document.documentElement).appendChild(portalHost);

  // --- 3. 几何测量、IDE 主题桥接、顶栏停靠与防溢出定位 ---
  let patchedActionToolbar = null;
  let patchedActionToolbarPrevMargin = '';
  let observedWorkbench = null;
  let themeObserver = null;
  const mirroredThemeVars = new Map();

  function restorePatchedActionToolbar() {
    if (!patchedActionToolbar) return;
    try {
      if (patchedActionToolbar.style) {
        patchedActionToolbar.style.marginLeft = patchedActionToolbarPrevMargin;
      }
    } catch {
      // 忽略还原宿主工具栏边距异常
    }
    patchedActionToolbar = null;
    patchedActionToolbarPrevMargin = '';
  }

  function syncWorkbenchThemeVars() {
    if (disposed) return null;
    try {
      if (
        typeof document === 'undefined' ||
        typeof document.querySelector !== 'function' ||
        typeof window.getComputedStyle !== 'function'
      ) {
        return null;
      }
      const workbenchEl = document.querySelector('.monaco-workbench');
      const rootCs = document.documentElement
        ? window.getComputedStyle(document.documentElement)
        : null;
      const bodyCs = document.body ? window.getComputedStyle(document.body) : null;
      const nativeRootBg = String(
        rootCs?.getPropertyValue?.('--background') ||
          bodyCs?.getPropertyValue?.('--background') ||
          ''
      ).trim();
      if (nativeRootBg) {
        if (mirroredThemeVars.size > 0) {
          for (const k of mirroredThemeVars.keys()) {
            portalHost.style.removeProperty?.(k);
            capsuleHost.style.removeProperty?.(k);
          }
          mirroredThemeVars.clear();
        }
        return workbenchEl || document.documentElement || null;
      }

      const themeSourceEl = workbenchEl || document.documentElement || document.body;
      if (!themeSourceEl) return null;
      const wbCs = window.getComputedStyle(themeSourceEl);
      const pick = (...names) => {
        for (const name of names) {
          const val = String(wbCs?.getPropertyValue?.(name) || '').trim();
          if (val) return val;
        }
        return '';
      };

      const nextVars = [
        [
          '--background',
          pick('--vscode-sideBar-background', '--vscode-editor-background', '--vscode-panel-background'),
        ],
        [
          '--card',
          pick(
            '--vscode-editorWidget-background',
            '--vscode-sideBar-background',
            '--vscode-editor-background'
          ),
        ],
        ['--foreground', pick('--vscode-foreground', '--vscode-editor-foreground')],
        [
          '--muted-foreground',
          pick('--vscode-descriptionForeground', '--vscode-sideBarTitle-foreground'),
        ],
        [
          '--border',
          pick(
            '--vscode-widget-border',
            '--vscode-panel-border',
            '--vscode-commandCenter-border',
            '--vscode-contrastBorder'
          ),
        ],
        [
          '--primary',
          pick('--vscode-textLink-foreground', '--vscode-button-background', '--vscode-focusBorder'),
        ],
        ['--destructive', pick('--vscode-errorForeground', '--vscode-editorError-foreground')],
      ];

      for (const [cssVar, val] of nextVars) {
        const prevVal = mirroredThemeVars.get(cssVar) || '';
        if (val) {
          if (prevVal !== val) {
            portalHost.style.setProperty?.(cssVar, val);
            capsuleHost.style.setProperty?.(cssVar, val);
            mirroredThemeVars.set(cssVar, val);
          }
        } else if (prevVal) {
          if (typeof portalHost.style.removeProperty === 'function') {
            portalHost.style.removeProperty(cssVar);
          } else {
            portalHost.style.setProperty?.(cssVar, '');
          }
          if (typeof capsuleHost.style.removeProperty === 'function') {
            capsuleHost.style.removeProperty(cssVar);
          } else {
            capsuleHost.style.setProperty?.(cssVar, '');
          }
          mirroredThemeVars.delete(cssVar);
        }
      }
      return themeSourceEl;
    } catch {
      return null;
    }
  }

  function ensureWorkbenchThemeObserved() {
    const wb = syncWorkbenchThemeVars();
    if (wb && wb !== observedWorkbench && themeObserver) {
      observedWorkbench = wb;
      try {
        themeObserver.observe(wb, { attributes: true, attributeFilter: ['class', 'style'] });
      } catch {
        // 忽略工作台属性观察异常
      }
    }
  }

  function resolveRuntimeDockTarget() {
    return resolveActiveDockTarget({
      capsuleNode: capsuleHost,
      portalNode: portalHost,
      patchedNode: patchedActionToolbar,
    });
  }

  function isDockPlacementSynced(dock) {
    const curDockAttr = capsuleHost.getAttribute('data-dock');
    if (!capsuleHost.isConnected || !portalHost.isConnected) return false;
    if (!dock) {
      if (isIdeExtensionChatFrame()) {
        return curDockAttr === 'pending-composer' && capsuleHost.style.display === 'none';
      }
      return curDockAttr === 'fixed';
    }
    if (capsuleHost.style.display === 'none') return false;
    if (!dock.targetContainer?.contains?.(capsuleHost) || curDockAttr !== dock.kind) return false;
    if (dock.kind === 'composer') {
      if (dock.anchorNode) {
        if (!isImmediatelyBeforeNode(capsuleHost, dock.anchorNode)) return false;
      } else {
        const lastEl =
          dock.targetContainer.lastElementChild !== undefined
            ? dock.targetContainer.lastElementChild
            : dock.targetContainer.children?.[dock.targetContainer.children.length - 1] ||
              dock.targetContainer.lastChild;
        if (lastEl !== capsuleHost) return false;
      }
    }
    return true;
  }

  const isMac = () => isMacHostPlatform(telemetryStore.getState().telemetry);

  function updateFixedFallbackPosition() {
    const dockMode = capsuleHost.getAttribute('data-dock');
    if (dockMode === 'flow' || dockMode === 'ide-titlebar' || dockMode === 'composer') {
      capsuleHost.style.top = '';
      capsuleHost.style.right = '';
      return;
    }
    try {
      const vw = Number(window.innerWidth || 1280);
      const minRight = isMac() ? 12 : 144;
      let rightOffset = minRight;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(minRight, Math.ceil(vw - r.left + 6));
        }
      }
      capsuleHost.style.top = '7px';
      capsuleHost.style.right = `${rightOffset}px`;
    } catch {
      // 忽略回退坐标计算异常
    }
  }

  function syncCapsuleOsAttr() {
    const nextOs = isMac() ? 'mac' : 'default';
    if (capsuleHost.getAttribute('data-os') !== nextOs) {
      patchAttr(capsuleHost, 'data-os', nextOs);
      if (capsuleHost.getAttribute('data-dock') === 'fixed') {
        updateFixedFallbackPosition();
      }
    }
  }

  function measureAvailableTitlebarWidth(dockTarget) {
    try {
      const titlebar = dockTarget?.titlebar || null;
      if (dockTarget?.kind === 'composer' && titlebar?.getBoundingClientRect) {
        const cRect = titlebar.getBoundingClientRect();
        const aRect = dockTarget.anchorNode?.getBoundingClientRect?.();
        if (cRect.width > 0) {
          const leftEdge =
            Number.isFinite(dockTarget.leftClusterRightEdge) &&
            dockTarget.leftClusterRightEdge > cRect.left + 12
              ? dockTarget.leftClusterRightEdge
              : cRect.left + 12;
          const leftOccupied = Math.max(12, leftEdge - cRect.left);
          if (aRect && aRect.width > 0) {
            const rightOccupied = Math.max(aRect.width + 8, cRect.right - aRect.left);
            return cRect.width - leftOccupied - rightOccupied - 16;
          }
          if (!dockTarget.anchorNode) {
            return cRect.width - leftOccupied - 28;
          }
        }
      }

      if (dockTarget?.kind === 'ide-titlebar' && titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          let leftContentWidth = 12;
          const leftGroup =
            titlebar.querySelector?.(':scope > .titlebar-left') ||
            titlebar.querySelector?.('.titlebar-left');
          if (leftGroup) {
            let leftSum = 0;
            if (typeof window.getComputedStyle === 'function') {
              leftSum += parseFloat(window.getComputedStyle(leftGroup).paddingLeft) || 0;
            }
            if (leftGroup.children) {
              for (const child of leftGroup.children) {
                if (child?.getBoundingClientRect) {
                  leftSum += Math.max(0, child.getBoundingClientRect().width);
                }
              }
            }
            leftContentWidth = Math.min(Math.round(tbRect.width * 0.45), Math.max(12, leftSum));
          }

          let minCenterWidth = 0;
          const centerGroup =
            titlebar.querySelector?.(':scope > .titlebar-center') ||
            titlebar.querySelector?.('.titlebar-center');
          if (centerGroup?.getBoundingClientRect) {
            const cr = centerGroup.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0) {
              minCenterWidth = Math.min(220, Math.ceil(cr.width));
            }
          }

          let rightSiblingsWidth = 0;
          let hasVisibleWindowControls = false;
          const rightGroup = dockTarget.targetContainer;
          if (rightGroup?.children) {
            for (const child of rightGroup.children) {
              if (child === capsuleHost || !child?.getBoundingClientRect) continue;
              const cw = Math.max(0, child.getBoundingClientRect().width);
              rightSiblingsWidth += cw;
              if (cw > 0 && child.classList?.contains?.('window-controls-container')) {
                hasVisibleWindowControls = true;
              }
            }
          }
          if (navigator?.windowControlsOverlay?.visible) {
            const wcoRect = navigator.windowControlsOverlay.getTitlebarAreaRect?.();
            if (wcoRect && wcoRect.width > 0) {
              if (!hasVisibleWindowControls && tbRect.right > wcoRect.right + 4) {
                rightSiblingsWidth += tbRect.right - wcoRect.right;
              }
              const leftOverlayInset = wcoRect.left - tbRect.left;
              if (leftOverlayInset > leftContentWidth) {
                leftContentWidth = Math.min(
                  Math.round(tbRect.width * 0.45),
                  Math.ceil(leftOverlayInset)
                );
              }
            }
          }

          return tbRect.width - leftContentWidth - minCenterWidth - rightSiblingsWidth - 28;
        }
      }

      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const macTrafficReserve = isMac() ? 80 : 168;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : tbRect.left < macTrafficReserve
              ? macTrafficReserve - tbRect.left
              : 12;
          const minTitleWidth = 180;
          let siblingButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = capsuleHost.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen =
              typeof document.querySelector === 'function' &&
              Boolean(document.querySelector('[data-testid="aux-pane-sash"]'));
            const root =
              typeof document.querySelector === 'function'
                ? document.querySelector('div.h-screen.w-screen')
                : null;
            const rightClusterVar =
              root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== capsuleHost && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) siblingButtonsWidth = sum + 8;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - siblingButtonsWidth;
        }
      }
      if (window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {
      // 忽略测量异常
    }
    return 320;
  }

  function positionFloatingElements() {
    if (disposed || !capsuleBtn.getBoundingClientRect) return;
    try {
      const bRect = capsuleBtn.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const vw = Number(window.innerWidth || 1280);
      const vh = Number(window.innerHeight || 800);
      const navRight = getLeftSidebarRightEdge(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;
      const curSettings = telemetryStore.getState().telemetry?.settings;
      const panelScale =
        PANEL_SCALE_FACTORS[normalizeClientFontScale(curSettings?.fontScale)] ?? 1;
      const defaultCardW = Math.min(
        Math.round(FLOATING_CARD_WIDTH * panelScale),
        Math.max(280, vw - 24)
      );
      const defaultMultiW = Math.min(
        Math.round(MULTI_PANEL_WIDTH * panelScale),
        Math.max(280, vw - 24)
      );
      const isDockComposer = capsuleHost.getAttribute('data-dock') === 'composer';

      if (multiOpen) {
        const mRect = multiBtn.getBoundingClientRect?.() || bRect;
        const anchorRect = mRect.width > 0 || mRect.height > 0 ? mRect : bRect;
        const rawW =
          Number(multiPanelEl.offsetWidth) ||
          Number(multiPanelEl.getBoundingClientRect?.().width) ||
          defaultMultiW;
        const panelW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const panelH =
          Number(multiPanelEl.offsetHeight) ||
          Number(multiPanelEl.getBoundingClientRect?.().height) ||
          320;
        const spaceBelowMulti = vh - anchorRect.bottom - 12;
        const spaceAboveMulti = anchorRect.top - 16;
        const openMultiAbove =
          (isDockComposer && spaceAboveMulti > spaceBelowMulti) ||
          (anchorRect.bottom + 6 + panelH > vh - 8 && spaceAboveMulti > spaceBelowMulti);

        let top;
        let maxMultiH;
        if (openMultiAbove) {
          maxMultiH = Math.max(180, Math.floor(anchorRect.top - 20));
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
          const effMultiH = Math.min(Number(multiPanelEl.offsetHeight) || panelH, maxMultiH);
          top = Math.max(12, Math.round(anchorRect.top - effMultiH - 8));
        } else {
          top = Math.max(38, Math.round(anchorRect.bottom + 6));
          maxMultiH = Math.max(240, vh - top - 12);
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
        }
        patchClasses(multiPanelEl, { 'is-above': openMultiAbove });
        let left = Math.round(anchorRect.left);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        multiPanelEl.style.top = `${top}px`;
        multiPanelEl.style.left = `${left}px`;
      }

      const rightAnchorEdge =
        !topbarUpdateBtn.hasAttribute('hidden') && topbarUpdateBtn.getBoundingClientRect
          ? Math.max(bRect.right, topbarUpdateBtn.getBoundingClientRect().right || 0)
          : bRect.right;

      if (popoverOpen) {
        const maxPopCardW = Math.max(280, vw - minLeft - 12);
        const popWidthMode = normalizeClientPopoverWidthMode(curSettings?.popoverWidthMode);
        let desiredPopW = Math.min(Math.round(POPOVER_BASE_WIDTH * panelScale), maxPopCardW);
        if (popWidthMode === 'custom') {
          desiredPopW = Math.min(
            normalizeClientPopoverWidth(curSettings?.popoverWidth),
            maxPopCardW
          );
        } else if (typeof popoverEl.querySelectorAll === 'function') {
          const panes = popoverEl.querySelectorAll('.table-viewport.is-step-table');
          for (const pane of panes) {
            let anc = pane;
            let inHiddenTree = false;
            while (anc && anc !== popoverEl) {
              if (anc.hasAttribute?.('hidden')) {
                inHiddenTree = true;
                break;
              }
              anc = anc.parentElement || anc.parentNode;
            }
            if (inHiddenTree) continue;
            const tableEl = pane.querySelector?.('.steps-data-table') || pane.firstElementChild;
            if (!tableEl) continue;
            const paneClientW = Number(pane.clientWidth || 0);
            const curPopW = Number(
              popoverEl.offsetWidth ||
                popoverEl.getBoundingClientRect?.().width ||
                POPOVER_BASE_WIDTH
            );
            let naturalTableW = 0;
            if (tableEl.style) {
              const prevW = tableEl.style.width || '';
              tableEl.style.width = 'max-content';
              naturalTableW = Math.ceil(
                Number(
                  tableEl.getBoundingClientRect?.().width ||
                    tableEl.scrollWidth ||
                    tableEl.offsetWidth ||
                    0
                )
              );
              tableEl.style.width = prevW;
            } else {
              naturalTableW = Math.ceil(Number(tableEl.scrollWidth || tableEl.offsetWidth || 0));
            }
            if (naturalTableW > 0) {
              const chromeW =
                paneClientW > 0 && curPopW >= paneClientW
                  ? Math.max(24, curPopW - paneClientW)
                  : 34;
              desiredPopW = Math.max(
                desiredPopW,
                Math.min(POPOVER_MAX_AUTO_WIDTH, maxPopCardW, naturalTableW + chromeW + 4)
              );
            }
          }
        }
        popoverEl.style.setProperty?.('--wm-popover-w', `${desiredPopW}px`);
        popoverEl.style.width = `${desiredPopW}px`;

        const rawW =
          Number(popoverEl.offsetWidth) ||
          Number(popoverEl.getBoundingClientRect?.().width) ||
          desiredPopW;
        const panelW = Math.min(rawW, maxPopCardW);
        const spaceBelowPop = vh - bRect.bottom - 12;
        const spaceAbovePop = bRect.top - 16;
        const openPopAbove =
          (isDockComposer && spaceAbovePop > spaceBelowPop) ||
          (spaceBelowPop < 360 && spaceAbovePop > spaceBelowPop);

        let top;
        if (openPopAbove) {
          const maxPopH = Math.max(240, Math.floor(bRect.top - 20));
          const targetPopH = Math.min(588, maxPopH);
          popoverEl.style.height = `${targetPopH}px`;
          popoverEl.style.maxHeight = `${maxPopH}px`;
          const actualPopH = Math.min(Number(popoverEl.offsetHeight) || targetPopH, maxPopH);
          top = Math.max(12, Math.round(bRect.top - actualPopH - 8));
        } else {
          popoverEl.style.height = '';
          top = Math.max(38, Math.min(vh - 140, Math.round(bRect.bottom + 6)));
          popoverEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(popoverEl, { 'is-above': openPopAbove });
        let left = Math.round(rightAnchorEdge - panelW);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        popoverEl.style.top = `${top}px`;
        popoverEl.style.left = `${left}px`;
      }

      if (tooltipOpen && !popoverOpen && !multiOpen) {
        const rawW =
          Number(hoverTipEl.offsetWidth) ||
          Number(hoverTipEl.getBoundingClientRect?.().width) ||
          defaultCardW;
        const tipW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const tipH =
          Number(hoverTipEl.offsetHeight) ||
          Number(hoverTipEl.getBoundingClientRect?.().height) ||
          480;
        const spaceBelowTip = vh - bRect.bottom - 12;
        const spaceAboveTip = bRect.top - 16;
        const openTipAbove =
          (isDockComposer && spaceAboveTip > spaceBelowTip) ||
          (bRect.bottom + 6 + tipH > vh - 8 && spaceAboveTip > spaceBelowTip);

        let top;
        if (openTipAbove) {
          const maxTipH = Math.max(220, Math.floor(bRect.top - 20));
          hoverTipEl.style.maxHeight = `${maxTipH}px`;
          const effTipH = Math.min(Number(hoverTipEl.offsetHeight) || tipH, maxTipH);
          top = Math.max(12, Math.round(bRect.top - effTipH - 8));
        } else {
          top = Math.max(38, Math.round(bRect.bottom + 6));
          hoverTipEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(hoverTipEl, { 'is-above': openTipAbove });
        let left = Math.round(rightAnchorEdge - tipW);
        left = Math.min(left, vw - tipW - 12);
        left = Math.max(minLeft, left);
        hoverTipEl.style.top = `${top}px`;
        hoverTipEl.style.left = `${left}px`;
      }
    } catch {
      // 忽略定位异常
    }
  }

  function updateResponsiveLayout(dockOverride = undefined) {
    if (disposed) return;
    const dockTarget = dockOverride === undefined ? resolveRuntimeDockTarget() : dockOverride;
    const avail = measureAvailableTitlebarWidth(dockTarget);
    const curTel = telemetryStore.getState().telemetry;
    const showMulti = curTel?.settings?.showTopbarMultiSession !== false;
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpdate = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    const slotCount = normalizeClientTopbarSlots(curTel?.settings?.topbarCapsuleSlots).length;
    const nextMode = computeCapsuleLayoutMode(avail, layoutMode, {
      showMulti,
      hasUpdate,
      slotCount,
    });
    if (nextMode !== layoutMode) {
      layoutMode = nextMode;
      capsuleHost.setAttribute('data-layout', layoutMode);
    }
    if (capsuleHost.getAttribute('data-dock') === 'fixed') {
      updateFixedFallbackPosition();
    }
    if (popoverOpen || tooltipOpen || multiOpen) {
      positionFloatingElements();
    }
  }

  let resizeObserver = null;

  function ensureCapsuleDocked() {
    if (disposed) return false;
    const bodyOrDoc = document.body || document.documentElement;
    if (bodyOrDoc && !portalHost.isConnected) {
      bodyOrDoc.appendChild(portalHost);
    }
    syncCapsuleOsAttr();
    ensureWorkbenchThemeObserved();

    const dockTarget = resolveRuntimeDockTarget();
    if (dockTarget) {
      if (capsuleHost.style.display === 'none') {
        capsuleHost.style.display = '';
      }
      const { kind, titlebar, targetContainer, actionToolbar } = dockTarget;
      if (kind === 'composer') {
        if (patchedActionToolbar !== actionToolbar) {
          restorePatchedActionToolbar();
          if (actionToolbar?.style) {
            patchedActionToolbar = actionToolbar;
            patchedActionToolbarPrevMargin = actionToolbar.style.marginLeft || '';
            actionToolbar.style.marginLeft = '0px';
          }
        }
        if (dockTarget.anchorNode) {
          if (
            (capsuleHost.parentElement || capsuleHost.parentNode) !== targetContainer ||
            !isImmediatelyBeforeNode(capsuleHost, dockTarget.anchorNode)
          ) {
            targetContainer.insertBefore(capsuleHost, dockTarget.anchorNode);
          }
        } else {
          const lastEl =
            targetContainer.lastElementChild !== undefined
              ? targetContainer.lastElementChild
              : targetContainer.children?.[targetContainer.children.length - 1] ||
                targetContainer.lastChild;
          if (
            (capsuleHost.parentElement || capsuleHost.parentNode) !== targetContainer ||
            lastEl !== capsuleHost
          ) {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'composer');
        patchAttr(
          capsuleHost,
          'data-composer-push',
          dockTarget.needsAutoMarginTransfer ? '1' : null
        );
      } else if (kind === 'ide-titlebar') {
        if (patchedActionToolbar !== actionToolbar) {
          restorePatchedActionToolbar();
          if (actionToolbar?.style) {
            patchedActionToolbar = actionToolbar;
            patchedActionToolbarPrevMargin = actionToolbar.style.marginLeft || '';
            actionToolbar.style.marginLeft = '0px';
          }
        }
        if (capsuleHost.parentElement !== targetContainer || targetContainer.firstChild !== capsuleHost) {
          if (targetContainer.firstChild) {
            targetContainer.insertBefore(capsuleHost, targetContainer.firstChild);
          } else {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'ide-titlebar');
        patchAttr(capsuleHost, 'data-composer-push', null);
      } else {
        restorePatchedActionToolbar();
        if (capsuleHost.parentElement !== targetContainer) {
          if (targetContainer.firstChild && targetContainer !== titlebar) {
            targetContainer.insertBefore(capsuleHost, targetContainer.firstChild);
          } else {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'flow');
        patchAttr(capsuleHost, 'data-composer-push', null);
      }
      if (capsuleHost.style.top) capsuleHost.style.top = '';
      if (capsuleHost.style.right) capsuleHost.style.right = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {
          // 忽略观察器异常
        }
      }
    } else if (isIdeExtensionChatFrame()) {
      restorePatchedActionToolbar();
      if (popoverOpen) setPopoverOpen(false);
      if (multiOpen) setMultiOpen(false);
      if (tooltipOpen) setTooltipOpen(false);
      if (bodyOrDoc && (capsuleHost.parentElement || capsuleHost.parentNode) !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      capsuleHost.style.display = 'none';
      patchAttr(capsuleHost, 'data-dock', 'pending-composer');
      patchAttr(capsuleHost, 'data-composer-push', null);
    } else if (bodyOrDoc) {
      if (capsuleHost.style.display === 'none') {
        capsuleHost.style.display = '';
      }
      restorePatchedActionToolbar();
      if (capsuleHost.parentElement !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      patchAttr(capsuleHost, 'data-dock', 'fixed');
      patchAttr(capsuleHost, 'data-composer-push', null);
      updateFixedFallbackPosition();
    }

    updateResponsiveLayout(dockTarget);
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  function scheduleDockSync() {
    if (disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (dockRafId) return;
      dockRafId = requestAnimationFrame(() => {
        dockRafId = 0;
        ensureCapsuleDocked();
      });
    } else {
      ensureCapsuleDocked();
    }
  }

  let turnCardsRafId = 0;

  function syncTurnCardsNow() {
    if (disposed) return;
    const curTel = telemetryStore.getState().telemetry;
    const mountMode = normalizeClientWindowMountMode(
      curTel?.settings?.windowMountMode,
      curTel?.settings?.enableWindowOverlay
    );
    if (!curTel || curTel.settings?.enableWindowOverlay === false || mountMode === 'sidebar') {
      disposeTurnUsageCardsInViewport(document);
      return;
    }
    syncTurnUsageCardsInViewport({ rootDoc: document, telemetry: curTel });
  }

  function scheduleTurnCardsSync() {
    if (disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (turnCardsRafId) return;
      turnCardsRafId = requestAnimationFrame(() => {
        turnCardsRafId = 0;
        syncTurnCardsNow();
      });
    } else {
      syncTurnCardsNow();
    }
  }

  function refreshActiveViewScrollbars() {
    const activeView = uiStore.getState().activeView;
    const refs = appInstance.refs;
    if (activeView === 'overview') {
      refs?.overviewView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'consumption') {
      refs?.consumptionView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'steps') {
      refs?.stepsView?.refs?.stepsScroll?.refresh();
      refs?.stepsView?.refs?.modelsScroll?.refresh();
    } else if (activeView === 'settings') {
      refs?.settingsView?.refs?.viewScrollbar?.refresh();
    }
  }

  function setMultiOpen(nextOpen, { pinned = false, instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen && multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
      multiLeaveTimer = null;
    }
    if (targetOpen) {
      setTooltipOpen(false);
      if (pinned && popoverOpen) {
        setPopoverOpen(false);
      }
    }
    const nextPinned = targetOpen ? Boolean(pinned) : false;
    const stateChanged = multiOpen !== targetOpen || multiPinned !== nextPinned;
    multiOpen = targetOpen;
    multiPinned = nextPinned;
    patchClasses(multiBtn, { 'is-open': multiOpen && multiPinned });
    patchAttr(multiBtn, 'aria-expanded', multiOpen ? 'true' : 'false');
    patchAttr(multiPinBadge, 'hidden', !multiPinned);
    if (!stateChanged) return;
    patchClasses(multiPanelEl, { 'is-instant': Boolean(instant && multiOpen) });
    patchAttr(multiPanelEl, 'hidden', !multiOpen);
    if (multiOpen) {
      renderCapsuleTelemetry();
      multiRunningWidget.refs.resumeTicker();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      multiRunningWidget.refs.pauseTicker();
    }
  }

  function canOpenHoverTooltip() {
    const curTel = telemetryStore.getState().telemetry;
    const hoverMods = normalizeClientHoverModules(curTel?.settings?.hoverModules);
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpd = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    return hoverMods.length > 0 || hasUpd;
  }

  function setTooltipOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(
      nextOpen && !popoverOpen && !(multiOpen && multiPinned) && canOpenHoverTooltip()
    );
    if (targetOpen && hoverLeaveTimer) {
      clearTimeout(hoverLeaveTimer);
      hoverLeaveTimer = null;
    }
    if (targetOpen && multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
    if (tooltipOpen === targetOpen) return;
    tooltipOpen = targetOpen;
    patchClasses(hoverTipEl, { 'is-instant': Boolean(instant && targetOpen) });
    patchAttr(hoverTipEl, 'hidden', !tooltipOpen);
    if (tooltipOpen) {
      renderHoverWidgets();
      hoverWidgetHost.resumeTickers();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      hoverWidgetHost.pauseTickers();
    }
  }

  function setPopoverOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen) {
      setTooltipOpen(false);
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
    if (popoverOpen === targetOpen) return;
    popoverOpen = targetOpen;
    patchClasses(capsuleBtn, { 'is-open': popoverOpen });
    patchClasses(popoverEl, { 'is-instant': Boolean(instant && popoverOpen) });
    patchAttr(capsuleBtn, 'aria-expanded', popoverOpen ? 'true' : 'false');
    patchAttr(popoverEl, 'hidden', !popoverOpen);
    uiStore.setState({ monitorVisible: popoverOpen && !document.hidden }, { sync: true });
    if (popoverOpen) {
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          positionFloatingElements();
          refreshActiveViewScrollbars();
        });
      } else {
        refreshActiveViewScrollbars();
      }
    }
  }

  function applyCapsuleSlots(slotKeys, slotCtx) {
    syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx);
  }

  function renderMultiRunningPanel(rawRunningList, runningCount, runningSubCount, hostRouteConversationId) {
    if (!multiOpen || document.hidden) {
      multiRunningWidget.refs.pauseTicker();
      return;
    }
    patchText(
      multiRunningMetaEl,
      runningCount > 0
        ? runningSubCount > 0
          ? t('multi.metaWithSubs', { main: runningCount, subs: runningSubCount })
          : t('multi.metaMainOnly', { main: runningCount })
        : t('multi.allIdle')
    );
    patchAttr(multiEmptyEl, 'hidden', runningCount > 0);
    multiRunningWidget.refs.update({
      items: rawRunningList,
      hostRouteConversationId,
    });
  }

  function renderHoverWidgets() {
    const { telemetry, minuteTick } = telemetryStore.getState();
    hoverWidgetHost.update({
      moduleKeys: normalizeClientHoverModules(telemetry?.settings?.hoverModules),
      data: telemetry,
      minuteTick: Number(minuteTick || Math.floor(Date.now() / 30000)),
    });
  }

  // --- 4. 实时遥测状态绑定（双胶囊与多会话/动态组件浮层就地更新，零硬编码、零布局跳动） ---
  function renderCapsuleTelemetry() {
    if (disposed) return;
    const telSt = telemetryStore.getState();
    const uiSt = uiStore.getState();
    const telemetry = telSt.telemetry;

    setI18nLanguage(telemetry?.settings?.language);
    syncPortalAppearance(telemetry?.settings);
    syncCapsuleOsAttr();

    const showMulti = telemetry?.settings?.showTopbarMultiSession !== false;
    patchAttr(multiBtn, 'hidden', !showMulti);
    patchAttr(capsuleHost, 'data-multi', showMulti ? 'on' : 'off');
    if (!showMulti && multiOpen) {
      setMultiOpen(false);
    }

    const slotKeys = normalizeClientTopbarSlots(telemetry?.settings?.topbarCapsuleSlots);
    const layoutInputsChanged =
      showMulti !== lastShowMulti || slotKeys.length !== lastSlotCount;
    if (layoutInputsChanged) {
      lastShowMulti = showMulti;
      lastSlotCount = slotKeys.length;
      updateResponsiveLayout();
    }

    if (!telemetry) {
      patchClasses(multiBtn, { 'is-running': false, 'is-waiting': false });
      patchText(multiLabel, t('capsule.multiZero'));
      patchText(multiRunningMetaEl, t('multi.loading'));
      multiRunningWidget.refs.stopLiveTicker();

      applyCapsuleSlots(slotKeys, { hasTelemetry: false });
      disposeTurnUsageCardsInViewport(document);
      return;
    }

    syncTurnCardsNow();

    const { agents, scopedConv: overviewScopedConv, ctxAgent, aggregated } =
      resolveScopedConversation(telemetry, 'all', uiSt.ctxInspectorAgentId);
    const { scopedConv: capsuleScopedConv } = resolveScopedConversation(
      telemetry,
      uiSt.selectedAgentScope,
      uiSt.ctxInspectorAgentId
    );
    const overviewActive = overviewScopedConv || telemetry.activeConversation || {};
    const slotCtx = buildCapsuleSlotContext(telemetry, {
      scopedConv: capsuleScopedConv,
      overviewConv: overviewActive,
      ctxAgent,
      aggregated,
    });
    const { rawRunningList, runningCount, runningSubCount, hasWaiting, multiBtnText } =
      resolveMultiSessionCapsuleState(telemetry, {
        agents,
        aggregated,
        latestTokPerSec: overviewActive.latestTokPerSec ?? null,
        contextUsedPct: slotCtx.usedPct,
      });

    patchClasses(multiBtn, {
      'is-running': runningCount > 0 && !hasWaiting,
      'is-waiting': runningCount > 0 && hasWaiting,
    });
    patchText(multiLabel, multiBtnText);

    renderMultiRunningPanel(
      rawRunningList,
      runningCount,
      runningSubCount,
      telSt.hostRouteConversationId
    );

    patchClasses(capsuleBtn, { 'is-running': slotCtx.isRunning });
    applyCapsuleSlots(slotKeys, slotCtx);

    const updateMode = normalizeClientUpdateMode(
      telemetry.settings?.pluginUpdateMode,
      telemetry.settings?.autoUpdatePlugin
    );
    const showUpdatePrompt =
      Boolean(telemetry.cloudStatus?.updateAvailable) && updateMode !== 'off';
    const latestVer = telemetry.cloudStatus?.latestPluginVersion || '';
    patchAttr(updateDot, 'hidden', !showUpdatePrompt);
    patchAttr(topbarUpdateBtn, 'hidden', !showUpdatePrompt);
    patchAttr(hoverUpdateBar, 'hidden', !showUpdatePrompt);
    if (showUpdatePrompt) {
      if (!isTopbarUpdating) {
        patchText(topbarUpdateLabel, latestVer ? `v${latestVer}` : t('capsule.newVersion'));
      }
      patchAttr(topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      patchText(
        hoverUpdateVerText,
        latestVer
          ? t('capsule.hoverNewVer', { ver: latestVer })
          : t('capsule.hoverNewVerGeneric')
      );
      const isComposerDock = capsuleHost.getAttribute('data-dock') === 'composer';
      patchText(
        hoverUpdateHintText,
        latestVer
          ? isComposerDock
            ? t('capsule.hoverUpdateHintComposer', { ver: latestVer })
            : t('capsule.hoverUpdateHintTopbar', { ver: latestVer })
          : isComposerDock
            ? t('capsule.hoverUpdateHintComposerGeneric')
            : t('capsule.hoverUpdateHintTopbarGeneric')
      );
    }
    if (showUpdatePrompt !== lastShowUpdate) {
      lastShowUpdate = showUpdatePrompt;
      updateResponsiveLayout();
    }

    // --- 同步动态悬停组件宿主（0 项且无更新提示时自动关闭悬停窗，点击完整浮窗不受影响） ---
    const hoverModuleKeys = normalizeClientHoverModules(telemetry.settings?.hoverModules);
    patchAttr(hoverWidgetsContainer, 'hidden', hoverModuleKeys.length === 0);
    if (hoverModuleKeys.length === 0 && !showUpdatePrompt && tooltipOpen) {
      setTooltipOpen(false);
    }
    if (tooltipOpen) {
      renderHoverWidgets();
      positionFloatingElements();
    }
  }

  let lastAppliedMountMode = normalizeClientWindowMountMode(
    telemetryStore.getState().telemetry?.settings?.windowMountMode,
    telemetryStore.getState().telemetry?.settings?.enableWindowOverlay
  );

  const unsubStore = telemetryStore.subscribe(
    (st) => ({
      syncState: st.syncState,
      telemetry: st.telemetry,
      minuteTick: st.minuteTick,
      selectedConversationId: st.selectedConversationId,
    }),
    (slice) => {
      const nextMountMode = normalizeClientWindowMountMode(
        slice.telemetry?.settings?.windowMountMode,
        slice.telemetry?.settings?.enableWindowOverlay
      );
      if (slice.telemetry?.settings?.enableWindowOverlay === false || nextMountMode === 'sidebar') {
        if (popoverOpen) setPopoverOpen(false);
        if (multiOpen) setMultiOpen(false);
      } else if (nextMountMode !== lastAppliedMountMode) {
        lastAppliedMountMode = nextMountMode;
        ensureCapsuleDocked();
      }
      lastAppliedMountMode = nextMountMode;
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
      }
    }
  );

  const unsubUiScope = uiStore.subscribe(
    (st) => ({
      selectedAgentScope: st.selectedAgentScope,
      ctxInspectorAgentId: st.ctxInspectorAgentId,
      activeView: st.activeView,
      stepsSubTab: st.stepsSubTab,
      settingsSubTab: st.settingsSubTab,
      settingsStructureTab: st.settingsStructureTab,
    }),
    () => {
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!disposed && popoverOpen) {
              positionFloatingElements();
              refreshActiveViewScrollbars();
            }
          });
        }
      }
    }
  );

  const unsubI18n = i18nStore.subscribe(
    (st) => st.locale,
    () => {
      patchAttr(multiBtn, 'aria-label', t('capsule.ariaMulti'));
      patchAttr(capsuleBtn, 'aria-label', t('capsule.ariaMonitor'));
      patchAttr(topbarUpdateBtn, 'aria-label', t('capsule.ariaUpdateTitle'));
      patchAttr(topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      patchAttr(multiPanelEl, 'aria-label', t('multi.ariaDialog'));
      patchAttr(popoverEl, 'aria-label', t('capsule.ariaMonitor'));
      patchText(multiPinBadge, t('multi.pinned'));
      patchText(multiEmptyTextEl, t('multi.empty'));
      patchText(multiTitleTextEl, t('multi.title'));
      renderCapsuleTelemetry();
    }
  );

  // --- 5. 宿主会话路由跟随与全局交互监听 ---
  function syncHostRouteIfChanged() {
    if (disposed) return;
    const currentRouteId = extractHostRouteCascadeId();
    if (currentRouteId === lastObservedRouteId) return;
    lastObservedRouteId = currentRouteId;
    const st = telemetryStore.getState();
    const patch = { hostRouteConversationId: currentRouteId };
    if (currentRouteId && st.selectedConversationId && st.selectedConversationId !== currentRouteId) {
      patch.selectedConversationId = '';
    }
    uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
    telemetryStore.setState(patch);
    void fetchTelemetry({ force: false });
  }

  const onDocMouseDown = (e) => {
    if (popoverOpen && !isEventInside(e, popoverEl) && !isEventInside(e, capsuleHost)) {
      setPopoverOpen(false);
    }
    if (multiOpen && !isEventInside(e, multiPanelEl) && !isEventInside(e, capsuleHost)) {
      setMultiOpen(false);
    }
  };

  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (popoverOpen) {
        setPopoverOpen(false);
      }
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
  };

  const onWindowPointerMove = (e) => recordPointerCoords(e);
  const onWindowBlur = () => {
    hasPointerCoords = false;
    if (tooltipOpen) {
      setTooltipOpen(false);
    }
    if (multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
  };
  const onWindowResize = () => updateResponsiveLayout();
  const onPopState = () => syncHostRouteIfChanged();
  const onDocFocusIn = () => syncHostRouteIfChanged();
  const onVisibilityChange = () => {
    if (document.hidden) {
      uiStore.setState({ monitorVisible: false });
      multiRunningWidget.refs.pauseTicker();
      hasPointerCoords = false;
      if (tooltipOpen) {
        setTooltipOpen(false);
      }
      if (multiOpen && !multiPinned) {
        setMultiOpen(false);
      }
      return;
    }
    if (!document.hidden && !disposed) {
      uiStore.setState({ monitorVisible: popoverOpen });
      if (multiOpen) renderCapsuleTelemetry();
      syncHostRouteIfChanged();
      void fetchTelemetry({ force: false });
    }
  };

  let hostDomObserver = null;
  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        syncWorkbenchThemeVars();
      });
      if (document.head) {
        themeObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
      if (document.body) {
        hostDomObserver = new MutationObserver((records) => {
          const isInternalOnly =
            Array.isArray(records) &&
            records.length > 0 &&
            records.every((r) => {
              const tgt = r?.target;
              if (!tgt) return true;
              if (tgt === capsuleHost || tgt === portalHost) return true;
              if (tgt.id === 'ag-usage-monitor-turn-styles') return true;
              if (tgt.getAttribute?.('data-ag-turn-usage') === 'true') return true;
              if (
                typeof tgt.closest === 'function' &&
                tgt.closest('[data-ag-turn-usage="true"]')
              ) {
                return true;
              }
              const added = Array.from(r.addedNodes || []);
              const removed = Array.from(r.removedNodes || []);
              const changedNodes = [...added, ...removed];
              if (
                changedNodes.length > 0 &&
                changedNodes.every(
                  (n) =>
                    n?.id === 'ag-usage-monitor-turn-styles' ||
                    n?.getAttribute?.('data-ag-turn-usage') === 'true'
                )
              ) {
                return true;
              }
              return false;
            });
          if (isInternalOnly) {
            return;
          }
          syncHostRouteIfChanged();
          if (!observedWorkbench) {
            ensureWorkbenchThemeObserved();
          }
          const dock = resolveRuntimeDockTarget();
          if (!isDockPlacementSynced(dock)) {
            scheduleDockSync();
          }
          scheduleTurnCardsSync();
        });
        hostDomObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-cascade-id', 'data-selected'],
        });
      }
    }
  } catch {
    // 忽略观察器初始化异常
  }

  document.addEventListener?.('mousedown', onDocMouseDown, true);
  document.addEventListener?.('keydown', onDocKeyDown);
  document.addEventListener?.('focusin', onDocFocusIn);
  document.addEventListener?.('visibilitychange', onVisibilityChange);
  window.addEventListener?.('pointermove', onWindowPointerMove, { passive: true });
  window.addEventListener?.('blur', onWindowBlur);
  window.addEventListener?.('resize', onWindowResize);
  window.addEventListener?.('popstate', onPopState);
  navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);

  const watchdogTimer = setInterval(() => {
    if (disposed) return;
    syncHostRouteIfChanged();
    ensureWorkbenchThemeObserved();
    const dock = resolveRuntimeDockTarget();
    if (!isDockPlacementSynced(dock)) {
      ensureCapsuleDocked();
    }
  }, 1200);

  ensureCapsuleDocked();
  renderCapsuleTelemetry();
  const allowMultiCarryOver =
    telemetryStore.getState().telemetry?.settings?.showTopbarMultiSession !== false;
  if (carryOverPopoverOpen) {
    setPopoverOpen(true, { instant: true });
  } else if (carryOverMultiPinnedOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: true, instant: true });
  } else if (carryOverMultiHoverOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: false, instant: true });
  } else if (carryOverTooltipOpen) {
    setTooltipOpen(true, { instant: true });
  }
  const stopPolling = startAsyncTelemetryLoop(2000);

  const handle = {
    bundleVersion,
    [WINDOW_OVERLAY_METHODS.ensureAlive]() {
      if (disposed) return false;
      return ensureCapsuleDocked();
    },
    [WINDOW_OVERLAY_METHODS.syncHostRoute]() {
      if (disposed) return false;
      syncHostRouteIfChanged();
      return true;
    },
    [WINDOW_OVERLAY_METHODS.updateBridge](nextBridge) {
      if (disposed || !nextBridge || typeof nextBridge !== 'object') return false;
      const port = Number(nextBridge.port || 0);
      const token = String(nextBridge.token || '');
      if (!Number.isInteger(port) || port <= 0 || !token) return false;
      const cur = readInjectedWindowBridge() || {};
      const portChanged = Number(cur.port || 0) !== port || String(cur.token || '') !== token;
      cur.port = port;
      cur.token = token;
      if (portChanged) {
        cur.transportMode = 'http';
      }
      window[WINDOW_BRIDGE_KEY] = cur;
      void fetchTelemetry({ force: false });
      return true;
    },
    getTelemetrySnapshot() {
      return telemetryStore.getState().telemetry;
    },
    getLastPointer() {
      return hasPointerCoords ? { x: lastPointerX, y: lastPointerY } : null;
    },
    [WINDOW_OVERLAY_METHODS.deliverRpc](responses) {
      if (disposed) return 0;
      return deliverCdpBridgeResponses(responses);
    },
    open() {
      setPopoverOpen(true);
    },
    close() {
      setPopoverOpen(false);
    },
    toggle() {
      setPopoverOpen(!popoverOpen);
    },
    openMulti(pinned = true) {
      setMultiOpen(true, { pinned: Boolean(pinned) });
    },
    closeMulti() {
      setMultiOpen(false);
    },
    isOpen: () => popoverOpen,
    isHoverOpen: () => tooltipOpen,
    isMultiOpen: () => multiOpen,
    isMultiHoverOpen: () => Boolean(multiOpen && !multiPinned),
    isMultiPinnedOpen: () => Boolean(multiOpen && multiPinned),
    getLayoutMode: () => layoutMode,
    [WINDOW_OVERLAY_METHODS.getDockKind]: () => String(capsuleHost.getAttribute('data-dock') || ''),
    [WINDOW_OVERLAY_METHODS.getMountMode]: () => lastAppliedMountMode,
    [WINDOW_OVERLAY_METHODS.applyMountMode](nextMode) {
      if (disposed) return false;
      const normalized = normalizeClientWindowMountMode(nextMode, nextMode !== 'sidebar');
      const bridgeConfig = readInjectedWindowBridge();
      if (bridgeConfig) bridgeConfig.mountMode = normalized;
      const curTel = telemetryStore.getState().telemetry;
      if (curTel?.settings) {
        telemetryStore.setState({
          telemetry: {
            ...curTel,
            settings: {
              ...curTel.settings,
              windowMountMode: normalized,
              enableWindowOverlay: normalized !== 'sidebar',
            },
          },
        });
      }
      lastAppliedMountMode = normalized;
      return ensureCapsuleDocked();
    },
    [WINDOW_OVERLAY_METHODS.dispose]() {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdogTimer);
      if (hoverLeaveTimer) {
        clearTimeout(hoverLeaveTimer);
        hoverLeaveTimer = null;
      }
      if (multiLeaveTimer) {
        clearTimeout(multiLeaveTimer);
        multiLeaveTimer = null;
      }
      multiRunningWidget.refs.stopLiveTicker();
      if (dockRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(dockRafId);
        dockRafId = 0;
      }
      if (turnCardsRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(turnCardsRafId);
        turnCardsRafId = 0;
      }
      disposeTurnUsageCardsInViewport(document);
      stopPolling();
      stopAsyncTelemetryLoop();
      unsubStore();
      unsubUiScope();
      unsubI18n();
      try {
        resizeObserver?.disconnect();
      } catch {}
      try {
        hostDomObserver?.disconnect();
      } catch {}
      try {
        themeObserver?.disconnect();
      } catch {}
      document.removeEventListener?.('mousedown', onDocMouseDown, true);
      document.removeEventListener?.('keydown', onDocKeyDown);
      document.removeEventListener?.('focusin', onDocFocusIn);
      document.removeEventListener?.('visibilitychange', onVisibilityChange);
      window.removeEventListener?.('pointermove', onWindowPointerMove);
      window.removeEventListener?.('blur', onWindowBlur);
      window.removeEventListener?.('resize', onWindowResize);
      window.removeEventListener?.('popstate', onPopState);
      navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      restorePatchedActionToolbar();
      try {
        hoverWidgetHost.destroy();
      } catch {}
      try {
        appInstance.destroy();
      } catch {}
      try {
        capsuleHost.remove();
      } catch {}
      try {
        portalHost.remove();
      } catch {}
      if (window[WINDOW_OVERLAY_KEY] === handle) {
        delete window[WINDOW_OVERLAY_KEY];
      }
    },
  };

  window[WINDOW_OVERLAY_KEY] = handle;
  return handle;
}
