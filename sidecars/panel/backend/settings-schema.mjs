/**
 * @fileoverview 用户偏好设置完整 Schema、默认对象工厂与带上下文窗口校验的整表归一化器。
 *
 * 所有跨端通用枚举与单项纯函数归一化规则统一源自 `../shared/settings-normalization.mjs`。
 */

import { isContextWindowSettingId, isContextWindowOption } from './context-windows.mjs';
import {
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_SLOTS,
  FONT_SCALE_KEYS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  POPOVER_WIDTH_MODES,
  STEP_TABLE_COLUMN_KEYS,
  STEP_TOKEN_SEGMENT_ALIASES,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_SLOT_KEYS,
  normalizeFontScale,
  normalizeHoverModules,
  normalizeLanguageSetting,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  parseStepTokenComboSegments,
} from '../shared/settings-normalization.mjs';

export {
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_SLOTS,
  FONT_SCALE_KEYS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  POPOVER_WIDTH_MODES,
  STEP_TABLE_COLUMN_KEYS,
  STEP_TOKEN_SEGMENT_ALIASES,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_SLOT_KEYS,
  normalizeFontScale,
  normalizeHoverModules,
  normalizeLanguageSetting,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  parseStepTokenComboSegments,
};

function isSchemaPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function schemaSanitizePositiveNum(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function normalizeModelContextWindows(value) {
  return Object.fromEntries(
    Object.entries(isSchemaPlainObject(value) ? value : {}).filter(
      ([id, option]) => isContextWindowSettingId(id) && isContextWindowOption(option)
    )
  );
}

export const DEFAULT_SETTINGS_SCHEMA = Object.freeze({
  language: 'zh-CN',
  themeAccent: 'host',
  fontScale: 'md',
  weeklyTokenBudget: 150000000,
  weeklyCostBudget: 100,
  weeklyLimitMode: 'official',
  modelDisplayMode: 'short',
  showUpstreamModel: false,
  orchestratorIdMode: 'compact',
  pluginUpdateMode: 'manual',
  autoUpdatePlugin: false,
  windowMountMode: 'dual',
  enableWindowOverlay: true,
  autoRelaunchDebug: false,
  popoverWidthMode: 'auto',
  popoverWidth: DEFAULT_POPOVER_WIDTH,
  enableCliStatusLine: true,
  standalonePort: 0,
  showTopbarMultiSession: true,
  topbarCapsuleSlots: DEFAULT_TOPBAR_SLOTS,
  hoverModules: DEFAULT_HOVER_MODULES,
  overviewModules: DEFAULT_OVERVIEW_MODULES,
  overviewMetrics: DEFAULT_OVERVIEW_METRICS,
  showStepTurnRail: false,
  showStepAgentBadge: true,
  showStepSpeedColor: false,
  stepTokenComboFormat: DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  stepTableColumns: DEFAULT_STEP_TABLE_COLUMNS,
  contextWindowRiskAccepted: false,
  modelContextWindows: Object.freeze({}),
});

/**
 * 创建一份深拷贝的全新默认偏好设置对象。
 */
export function createDefaultSettingsObject() {
  return {
    ...DEFAULT_SETTINGS_SCHEMA,
    topbarCapsuleSlots: [...DEFAULT_TOPBAR_SLOTS],
    hoverModules: [...DEFAULT_HOVER_MODULES],
    overviewModules: [...DEFAULT_OVERVIEW_MODULES],
    overviewMetrics: [...DEFAULT_OVERVIEW_METRICS],
    stepTableColumns: [...DEFAULT_STEP_TABLE_COLUMNS],
    modelContextWindows: {},
  };
}

/**
 * 将原始持久化对象或增量合并结果完整归一化为合法偏好对象。
 *
 * @param {unknown} rawInput
 */
export function normalizeFullSettings(rawInput) {
  const safeRaw = isSchemaPlainObject(rawInput) ? rawInput : {};
  const pluginUpdateMode = normalizePluginUpdateMode(
    safeRaw.pluginUpdateMode,
    safeRaw.autoUpdatePlugin
  );
  const windowMountMode = normalizeWindowMountMode(
    safeRaw.windowMountMode,
    safeRaw.enableWindowOverlay
  );
  const modelDisplayMode = normalizeModelDisplayMode(
    safeRaw.modelDisplayMode,
    safeRaw.showUpstreamModel
  );
  return {
    language: normalizeLanguageSetting(safeRaw.language),
    themeAccent: normalizeThemeAccent(safeRaw.themeAccent),
    fontScale: normalizeFontScale(safeRaw.fontScale),
    weeklyTokenBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyTokenBudget ?? safeRaw.weeklyTokenLimit,
      DEFAULT_SETTINGS_SCHEMA.weeklyTokenBudget
    ),
    weeklyCostBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyCostBudget,
      DEFAULT_SETTINGS_SCHEMA.weeklyCostBudget
    ),
    weeklyLimitMode: normalizeWeeklyLimitMode(safeRaw.weeklyLimitMode),
    modelDisplayMode,
    showUpstreamModel: modelDisplayMode !== 'short',
    orchestratorIdMode: normalizeOrchestratorIdMode(safeRaw.orchestratorIdMode),
    pluginUpdateMode,
    autoUpdatePlugin: pluginUpdateMode === 'auto',
    windowMountMode,
    enableWindowOverlay: windowMountMode !== 'sidebar',
    autoRelaunchDebug: safeRaw.autoRelaunchDebug === true,
    popoverWidthMode: normalizePopoverWidthMode(safeRaw.popoverWidthMode),
    popoverWidth: normalizePopoverWidth(safeRaw.popoverWidth),
    enableCliStatusLine: safeRaw.enableCliStatusLine !== false,
    standalonePort: normalizeStandalonePort(safeRaw.standalonePort),
    showTopbarMultiSession: safeRaw.showTopbarMultiSession !== false,
    topbarCapsuleSlots: normalizeTopbarCapsuleSlots(safeRaw.topbarCapsuleSlots),
    hoverModules: normalizeHoverModules(safeRaw.hoverModules),
    overviewModules: normalizeOverviewModules(safeRaw.overviewModules),
    overviewMetrics: normalizeOverviewMetrics(safeRaw.overviewMetrics),
    showStepTurnRail: safeRaw.showStepTurnRail === true,
    showStepAgentBadge: safeRaw.showStepAgentBadge !== false,
    showStepSpeedColor: safeRaw.showStepSpeedColor === true,
    stepTokenComboFormat: normalizeStepTokenComboFormat(safeRaw.stepTokenComboFormat),
    stepTableColumns: normalizeStepTableColumns(safeRaw.stepTableColumns),
    contextWindowRiskAccepted: safeRaw.contextWindowRiskAccepted === true,
    modelContextWindows: normalizeModelContextWindows(safeRaw.modelContextWindows),
  };
}
