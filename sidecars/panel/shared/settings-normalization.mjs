/**
 * @fileoverview 前后端与 CLI 共用的偏好设置枚举常量、默认值与无状态纯函数归一化规则。
 */

export const SUPPORTED_LANGUAGES = Object.freeze(['auto', 'zh-CN', 'en-US']);

export const THEME_ACCENT_KEYS = Object.freeze([
  'host',
  'blue',
  'emerald',
  'amber',
  'violet',
  'cyan',
  'rose',
]);

export const FONT_SCALE_KEYS = Object.freeze(['sm', 'md', 'lg', 'xl']);

export const TOPBAR_SLOT_KEYS = Object.freeze([
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_5h',
  'gemini_weekly',
  'claude_5h',
  'claude_weekly',
  'argon_weekly',
]);

export const DEFAULT_TOPBAR_SLOTS = Object.freeze(['tps', 'ttft', 'context']);
export const MIN_TOPBAR_SLOTS = 1;
export const MAX_TOPBAR_SLOTS = 6;

export const OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_HOVER_MODULES = Object.freeze(['metrics', 'context', 'quotas']);

export const OVERVIEW_METRIC_KEYS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'context_usage',
  'quota_tightest',
]);

export const DEFAULT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);

export const STEP_TABLE_COLUMN_KEYS = Object.freeze([
  'step',
  'time',
  'model',
  'tps',
  'ttft',
  'duration',
  'tokens_combo',
  'tokens_io_cache',
  'tokens_custom',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TABLE_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'ttft',
  'tokens_combo',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

export const STEP_TOKEN_SEGMENT_ALIASES = Object.freeze({
  context: 'context',
  ctx: 'context',
  '上下文': 'context',
  in: 'in',
  new: 'in',
  input: 'in',
  '输入': 'in',
  '新输入': 'in',
  out: 'out',
  output: 'out',
  '输出': 'out',
  '总输出': 'out',
  cache: 'cache',
  cached: 'cache',
  cache_read: 'cache',
  cacheread: 'cache',
  '缓存': 'cache',
  '缓存读': 'cache',
  think: 'think',
  thinking: 'think',
  '思考': 'think',
  reply: 'reply',
  body: 'reply',
  resp: 'reply',
  response: 'reply',
  text: 'reply',
  '正文': 'reply',
  '回复': 'reply',
  total: 'total',
  all: 'total',
  sum: 'total',
  '总计': 'total',
  '总token': 'total',
});

export const POPOVER_WIDTH_MODES = Object.freeze(['auto', 'custom']);
export const MIN_POPOVER_WIDTH = 440;
export const MAX_POPOVER_WIDTH = 1080;
export const DEFAULT_POPOVER_WIDTH = 580;

/**
 * 归一化界面语言枚举（默认 `'zh-CN'`，支持 `'auto'`/`'system'` 与 `'en-US'`）。
 *
 * @param {unknown} lang
 * @returns {'auto'|'zh-CN'|'en-US'}
 */
export function normalizeLanguageSetting(lang) {
  const raw = String(lang ?? '').trim();
  if (!raw) return 'zh-CN';
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'system') return 'auto';
  if (lower === 'en' || lower === 'en-us' || lower.startsWith('en-')) return 'en-US';
  if (lower === 'zh' || lower === 'zh-cn' || lower.startsWith('zh')) return 'zh-CN';
  return 'zh-CN';
}

/**
 * 归一化主题强调色预设键（默认 `'host'` 跟随宿主原生主题）。
 *
 * @param {unknown} accent
 * @returns {'host'|'blue'|'emerald'|'amber'|'violet'|'cyan'|'rose'}
 */
export function normalizeThemeAccent(accent) {
  const clean = String(accent ?? '').trim().toLowerCase();
  return THEME_ACCENT_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'host';
}

/**
 * 归一化面板字号档位（默认 `'md'` 标准 100%）。
 *
 * @param {unknown} scale
 * @returns {'sm'|'md'|'lg'|'xl'}
 */
export function normalizeFontScale(scale) {
  const clean = String(scale ?? '').trim().toLowerCase();
  return FONT_SCALE_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'md';
}

/**
 * 归一化模型名称展示模式（`'short'` | `'upstream_compact'` | `'upstream'`），兼容历史 `showUpstreamModel`。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyShowUpstream]
 * @returns {'short'|'upstream_compact'|'upstream'}
 */
export function normalizeModelDisplayMode(mode, legacyShowUpstream) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
  if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
    return 'upstream_compact';
  }
  if (m === 'short') return 'short';
  if (legacyShowUpstream === true) return 'upstream';
  return 'short';
}

/**
 * 归一化 Orchestrator 系列模型 ID 显示风格（`'compact'` vs `'full'`，默认 `'compact'`）。
 *
 * @param {unknown} mode
 * @returns {'compact'|'full'}
 */
export function normalizeOrchestratorIdMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

/**
 * 归一化悬浮主面板宽度模式（`'auto'` | `'custom'`，默认 `'auto'`）。
 *
 * @param {unknown} mode
 * @returns {'auto'|'custom'}
 */
export function normalizePopoverWidthMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
}

/**
 * 归一化悬浮主面板自定义宽度像素值（范围 `440..1080`，默认 `580`）。
 *
 * @param {unknown} width
 * @returns {number}
 */
export function normalizePopoverWidth(width) {
  const num = Number(width);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_POPOVER_WIDTH;
  return Math.max(MIN_POPOVER_WIDTH, Math.min(MAX_POPOVER_WIDTH, Math.round(num)));
}

/**
 * 解析步骤表自定义 Token 组合表达式，支持 `:`、`/`、`,`、`|` 分隔与中英文别名（1~4 项不重复）。
 *
 * @param {unknown} raw
 * @returns {Array<'context'|'in'|'out'|'cache'|'think'|'reply'|'total'>}
 */
export function parseStepTokenComboSegments(raw) {
  const str = String(raw ?? '').trim();
  const out = [];
  const seen = new Set();
  if (str) {
    for (const part of str.split(/[:/,|]+/)) {
      const key = part.trim().toLowerCase();
      if (!key) continue;
      const mapped = Object.prototype.hasOwnProperty.call(STEP_TOKEN_SEGMENT_ALIASES, key)
        ? STEP_TOKEN_SEGMENT_ALIASES[key]
        : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(/** @type {any} */ (mapped));
      if (out.length >= 4) break;
    }
  }
  return out.length > 0 ? out : ['context', 'in', 'cache'];
}

/**
 * 归一化步骤表自定义 Token 组合格式字符串（如 `'context:new:cache'` -> `'context:in:cache'`）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeStepTokenComboFormat(raw) {
  return parseStepTokenComboSegments(raw).join(':');
}

/**
 * 归一化插件更新策略枚举（兼容历史 `autoUpdatePlugin` 布尔开关，默认 `'manual'`）。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyAutoUpdate]
 * @returns {'off'|'manual'|'auto'}
 */
export function normalizePluginUpdateMode(mode, legacyAutoUpdate) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'off' || m === 'manual' || m === 'auto') return m;
  if (legacyAutoUpdate === true) return 'auto';
  return 'manual';
}

/**
 * 归一化面板挂载方式枚举（`'dual'` | `'composer'` | `'sidebar'`），兼容历史 `enableWindowOverlay`。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyEnableOverlay]
 * @returns {'dual'|'composer'|'sidebar'}
 */
export function normalizeWindowMountMode(mode, legacyEnableOverlay) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'composer' || m === 'input') return 'composer';
  if (m === 'sidebar' || m === 'sidebar_only' || m === 'off') return 'sidebar';
  if (m === 'dual' || m === 'topbar') return 'dual';
  if (legacyEnableOverlay === false) return 'sidebar';
  return 'dual';
}

/**
 * 归一化每周额度统计模式枚举（`'official'` | `'custom_tokens'` | `'custom_cost'`）。
 *
 * @param {unknown} mode
 * @returns {'official'|'custom_tokens'|'custom_cost'}
 */
export function normalizeWeeklyLimitMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'custom_tokens' || m === 'tokens') return 'custom_tokens';
  if (m === 'custom_cost' || m === 'cost') return 'custom_cost';
  return 'official';
}

/**
 * 归一化顶栏/输入框胶囊槽位数组（1~5 项动态自添加，默认 3 项，自动清洗历史 `'none'` 与重复项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeTopbarCapsuleSlots(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_TOPBAR_SLOTS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_TOPBAR_SLOTS) break;
  }
  if (out.length < MIN_TOPBAR_SLOTS) {
    return ['context'];
  }
  return out;
}

/**
 * 归一化实时监控第一行指标矩阵的槽位与顺序（1~4 项，默认 4 项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewMetrics(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_METRICS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const rawVal = String(item ?? '').trim();
    const val = rawVal === 'cost' ? 'step_cost' : rawVal;
    if (!OVERVIEW_METRIC_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : ['tps'];
}

/**
 * 归一化实时监控视图展示的模块及上下顺序（1~4 项，默认 4 项全开）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out.length > 0 ? out : ['metrics'];
}

/**
 * 归一化鼠标悬停速览窗展示的模块及上下顺序（0~4 项，默认 3 项；显式空数组 `[]` 表示禁用悬停弹窗）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeHoverModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_HOVER_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out;
}

/**
 * 归一化调用明细「按步查看」表格列配置与左右顺序（2~14 列，默认保留现有 7 列）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeStepTableColumns(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STEP_TABLE_COLUMNS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!STEP_TABLE_COLUMN_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= STEP_TABLE_COLUMN_KEYS.length) break;
  }
  if (out.length < 2) {
    for (const fallbackCol of ['step', 'model', 'tps']) {
      if (!seen.has(fallbackCol)) {
        seen.add(fallbackCol);
        out.push(fallbackCol);
      }
      if (out.length >= 2) break;
    }
  }
  return out;
}

/**
 * 归一化独立 Web 服务自动托管端口（`0` 表示关闭自动拉起，合法监听端口范围 `1024..65535`）。
 *
 * @param {unknown} port
 * @returns {number}
 */
export function normalizeStandalonePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num <= 0) return 0;
  if (num >= 1024 && num <= 65535) return num;
  return 0;
}
