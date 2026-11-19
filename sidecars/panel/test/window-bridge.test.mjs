import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { MockMutationObserver, createMockDom } from './mock-dom.mjs';
import {
  associateIdeIframeRoutes,
  createWindowBridgeController,
  ensureIdeRemoteDebuggingArgv,
  ensureRemoteDebuggingInArgvText,
  extractIdeExtensionCascadeId,
  isAllowedBridgeOrigin,
  isAntigravityMainPageTarget,
  isIdeExtensionChatTarget,
  parseDevToolsPortFile,
  resolveDevToolsPortCandidates,
  resolveIdeArgvPath,
} from '../backend/window-bridge.mjs';
import {
  buildDarwinTerminalRelaunchScript,
  buildSanitizedDesktopRelaunchEnv,
  buildWindowsRelaunchInnerScript,
  ensureDarwinTerminalRelaunchScript,
  ensureDesktopLaunchEntriesConfigured,
  ensureRemoteDebugFlagInArgs,
  inspectRunningDarwinDesktopHost,
  maybeAutoRelaunchDarwinDesktopHost,
  parsePsElapsedSeconds,
  patchLinuxDesktopEntryText,
  patchWindowsRunRegistryCommand,
  resolveDesktopHostExecutable,
  triggerDarwinTerminalRelaunch,
  triggerDesktopHostRelaunch,
} from '../backend/desktop-launcher-config.mjs';
import { loadSettings } from '../backend/config.mjs';
import { normalizeFullSettings } from '../backend/settings-schema.mjs';
import {
  discoverAntigravityLsEndpoint,
  parseLinuxProcNetTcpPorts,
  parseLsArgsFromCommandLine,
  parseSsListeningPorts,
} from '../backend/ls-discovery.mjs';
import {
  createStandaloneWebServer,
  isLoopbackBindHost,
  parseStandaloneCliArgs,
} from '../backend/standalone-server.mjs';
import { handleMcpJsonRpcMessage } from '../mcp-entry.mjs';
import { computeCapsuleLayoutMode } from '../src/components/layout/WindowOverlayShell.js';
import {
  getCacheToneClass,
  getSpeedToneClass,
  getStepCostToneClass,
  getTtftToneClass,
} from '../src/core/formatters.js';
import { setI18nLanguage } from '../src/i18n/index.js';
import {
  resolveCapsuleMetricPresentation,
  resolveOverviewMetricCell,
} from '../src/registries/metricRegistry.js';
import { backendHarness } from './backend-harness.mjs';

test('DevToolsActivePort parsing, cross-platform discovery (2.0 + IDE), and strict target/origin filtering', () => {
  assert.equal(parseDevToolsPortFile('9222\n/devtools/browser/abc-123\n'), 9222);
  assert.equal(parseDevToolsPortFile('54321\r\n/devtools/browser/win'), 54321);
  assert.equal(parseDevToolsPortFile('0\n/devtools'), null);
  assert.equal(parseDevToolsPortFile('70000\n/devtools'), null);
  assert.equal(parseDevToolsPortFile('not-a-port'), null);

  const explicit = resolveDevToolsPortCandidates(
    { ANTIGRAVITY_DEVTOOLS_PORT_FILE: '/tmp/custom-port' },
    'win32',
    'C:\\Users\\Dev'
  );
  assert.deepEqual(explicit, ['/tmp/custom-port']);

  const winPaths = resolveDevToolsPortCandidates(
    { APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' },
    'win32',
    'C:\\Users\\Dev'
  );
  assert.equal(winPaths.length, 4);
  assert.equal(winPaths[0], path.join('C:\\Roaming', 'Antigravity', 'DevToolsActivePort'));
  assert.equal(winPaths[1], path.join('C:\\Local', 'Antigravity', 'DevToolsActivePort'));
  assert.equal(winPaths[2], path.join('C:\\Roaming', 'Antigravity IDE', 'DevToolsActivePort'));
  assert.equal(winPaths[3], path.join('C:\\Local', 'Antigravity IDE', 'DevToolsActivePort'));

  const macPaths = resolveDevToolsPortCandidates({}, 'darwin', '/Users/dev');
  assert.equal(macPaths.length, 6);
  assert.equal(
    macPaths[0],
    path.join('/Users/dev', 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
  );
  assert.equal(
    macPaths[1],
    path.join('/Users/dev', 'Library', 'Application Support', 'Antigravity IDE', 'DevToolsActivePort')
  );
  assert.equal(
    macPaths[2],
    path.join('/Users/dev', 'Library', 'Application Support', 'antigravity', 'DevToolsActivePort')
  );
  assert.equal(
    macPaths[3],
    path.join('/Users/dev', 'Library', 'Application Support', 'antigravity-ide', 'DevToolsActivePort')
  );
  assert.equal(
    macPaths[4],
    path.join('/Users/dev', '.config', 'Antigravity', 'DevToolsActivePort')
  );
  assert.equal(
    macPaths[5],
    path.join('/Users/dev', '.config', 'Antigravity IDE', 'DevToolsActivePort')
  );

  const linuxPaths = resolveDevToolsPortCandidates({ XDG_CONFIG_HOME: '/home/dev/.config' }, 'linux', '/home/dev');
  assert.equal(linuxPaths.length, 2);
  assert.equal(linuxPaths[0], path.join('/home/dev/.config', 'Antigravity', 'DevToolsActivePort'));
  assert.equal(linuxPaths[1], path.join('/home/dev/.config', 'Antigravity IDE', 'DevToolsActivePort'));

  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'https://127.0.0.1:51234/c/12345678-1234-1234-1234-123456789abc',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/main1',
    }),
    true
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'vscode-file://vscode-app/c:/Users/Admin/AppData/Local/Programs/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ide-main',
    }),
    true
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'vscode-file://vscode-app/Applications/Antigravity%20IDE.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.esm.html?ew=1',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ide-esm',
    }),
    true
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'vscode-file://vscode-app/c:/Users/Admin/AppData/Local/Programs/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench-jetski-agent.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ide-jetski',
    }),
    true
  );

  // Reject auxiliary webviews, sharedProcess, non-HTTPS pages, and non-loopback debugger sockets
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'iframe',
      url: 'vscode-webview://panel/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/wv1',
    }),
    false
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'vscode-webview://panel/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/wv-page',
    }),
    false
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'vscode-file://vscode-app/c:/App/out/vs/code/electron-browser/sharedProcess/sharedProcess.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/shared',
    }),
    false
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'http://127.0.0.1:51234/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/http1',
    }),
    false
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'https://127.0.0.1:51234/',
      webSocketDebuggerUrl: 'ws://evil.example.com:9222/devtools/page/remote',
    }),
    false
  );

  assert.equal(isAllowedBridgeOrigin('https://127.0.0.1:58123'), true);
  assert.equal(isAllowedBridgeOrigin('https://localhost:58123'), true);
  assert.equal(isAllowedBridgeOrigin('vscode-file://vscode-app'), true);
  assert.equal(isAllowedBridgeOrigin('vscode-file://evil-host'), false);
  assert.equal(isAllowedBridgeOrigin('http://127.0.0.1:58123'), false);
  assert.equal(isAllowedBridgeOrigin('https://example.com:58123'), false);
  assert.equal(isAllowedBridgeOrigin('vscode-webview://panel'), false);
});

test('Loopback HTTP bridge enforces Origin, Private Network CORS, token auth, and body limits', async () => {
  const receivedCalls = [];
  const controller = createWindowBridgeController({
    handleApiRequest: async (pathname, method, data) => {
      receivedCalls.push({ pathname, method, data });
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, echoPath: pathname, echoData: data }),
      };
    },
    readAssetFn: async () => '',
    getSettingsFn: () => ({ enableWindowOverlay: true }),
    getBundleVersionFn: () => 'v1',
  });

  try {
    const { port, token } = await controller.ensureBridgeServer();
    assert.ok(port > 0);
    assert.equal(token.length, 64);

    const validOrigin = 'https://127.0.0.1:60123';

    // 1. Disallowed origin -> 403
    const badOriginRes = await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
      headers: { Origin: 'https://evil.example', 'X-Usage-Monitor-Token': token },
    });
    assert.equal(badOriginRes.status, 403);

    // 2. OPTIONS preflight -> 204 with Private Network header (including Chromium cross-scheme Sec-Fetch-Site: cross-site)
    const rawCrossSchemePreflight = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/telemetry',
          method: 'OPTIONS',
          headers: {
            Origin: validOrigin,
            'Sec-Fetch-Site': 'cross-site',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-usage-monitor-token',
          },
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode, headers: res.headers });
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rawCrossSchemePreflight.status, 204);
    assert.equal(rawCrossSchemePreflight.headers['access-control-allow-origin'], validOrigin);
    assert.equal(rawCrossSchemePreflight.headers['access-control-allow-private-network'], 'true');

    const rawCrossSchemeGetStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/telemetry?conversationId=conv-sec&range=today',
          method: 'GET',
          headers: {
            Origin: validOrigin,
            'Sec-Fetch-Site': 'cross-site',
            'X-Usage-Monitor-Token': token,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rawCrossSchemeGetStatus, 200);

    // 3. Invalid token -> 403
    const badTokenRes = await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
      headers: { Origin: validOrigin, 'X-Usage-Monitor-Token': 'wrong-token' },
    });
    assert.equal(badTokenRes.status, 403);

    // 4. Valid GET /api/telemetry -> 200
    const okGetRes = await fetch(
      `http://127.0.0.1:${port}/api/telemetry?conversationId=conv-1&range=today`,
      {
        headers: { Origin: validOrigin, 'X-Usage-Monitor-Token': token },
      }
    );
    assert.equal(okGetRes.status, 200);
    const getBody = await okGetRes.json();
    assert.equal(getBody.ok, true);
    assert.equal(getBody.echoData.conversationId, 'conv-1');
    assert.equal(getBody.echoData.range, 'today');

    // 5. Valid POST /api/settings -> 200
    const okPostRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: {
        Origin: validOrigin,
        'Content-Type': 'application/json',
        'X-Usage-Monitor-Token': token,
      },
      body: JSON.stringify({ enableWindowOverlay: false }),
    });
    assert.equal(okPostRes.status, 200);
    const postBody = await okPostRes.json();
    assert.equal(postBody.echoData.enableWindowOverlay, false);
    assert.equal(receivedCalls.length, 3);

    // 6. Oversized POST body -> 413
    const hugePayload = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
    const hugeRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: {
        Origin: validOrigin,
        'Content-Type': 'application/json',
        'X-Usage-Monitor-Token': token,
      },
      body: hugePayload,
    }).catch(() => ({ status: 413 }));
    assert.equal(hugeRes.status, 413);
  } finally {
    await controller.stop();
  }
});

test('CDP multi-window sync injects, skips healthy windows, hot-upgrades on version bump, and cleans up on disable', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wm-cdp-test-'));
  const portFile = path.join(tmpDir, 'DevToolsActivePort');

  // Simulated VM contexts for two open Antigravity windows
  const windowContexts = new Map();
  for (const id of ['win1', 'win2']) {
    const winObj = {};
    winObj.window = winObj;
    winObj.globalThis = winObj;
    windowContexts.set(id, vm.createContext(winObj));
  }

  let injectEvalCount = 0;

  class MockCdpWebSocket {
    constructor(url) {
      this.url = url;
      this.targetId = url.split('/').pop();
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params.expression;
        const ctx = windowContexts.get(this.targetId);
        const previousBridge = ctx.__AGUsageMonitorBridge;
        const value = vm.runInContext(expr, ctx);
        if (ctx.__AGUsageMonitorBridge && ctx.__AGUsageMonitorBridge !== previousBridge) {
          injectEvalCount += 1;
        }
        Promise.resolve(value).then((result) =>
          this._emit('message', {
            data: JSON.stringify({ id: msg.id, result: { result: { value: result } } }),
          })
        );
      }
    }
    close() {}
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }

  const cdpHttpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const cdpPort = cdpHttpServer.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'win1',
            type: 'page',
            url: 'https://127.0.0.1:61001/c/11111111-1111-1111-1111-111111111111',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/win1`,
          },
          {
            id: 'win2',
            type: 'page',
            url: 'https://127.0.0.1:61002/c/22222222-2222-2222-2222-222222222222',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/win2`,
          },
          {
            type: 'iframe',
            url: 'vscode-webview://aux-pane/index.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/ignored`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => cdpHttpServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(portFile, `${cdpHttpServer.address().port}\n/devtools/browser/mock`, 'utf8');

  let overlayEnabled = true;
  let currentVer = 'bundle-v1';

  const mockAppJs = `
    (() => {
      window.__AGUsageMonitorOverlay?.dispose?.();
      const br = window.__AGUsageMonitorBridge;
      let alive = true;
      window.__AGUsageMonitorOverlay = {
        bundleVersion: br.bundleVersion,
        ensureAlive: () => alive,
        dispose: () => { alive = false; },
      };
    })();
  `;

  const controller = createWindowBridgeController({
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    readAssetFn: async (rel) => (rel === 'styles.css' ? ':host{}' : mockAppJs),
    getSettingsFn: () => ({ enableWindowOverlay: overlayEnabled }),
    getBundleVersionFn: () => currentVer,
    env: { ANTIGRAVITY_DEVTOOLS_PORT_FILE: portFile },
    WebSocketImpl: MockCdpWebSocket,
  });

  try {
    // 1. Initial sync mounts onto both main windows and ignores the webview
    const first = await controller.syncAllWindows();
    assert.equal(first.ok, true);
    assert.equal(first.targets, 2);
    assert.equal(first.injected, 2);
    assert.equal(first.aliveCount, 2);
    assert.equal(injectEvalCount, 2);

    // 2. Subsequent poll sees matching bundleVersion & port -> 0 re-injections
    const second = await controller.syncAllWindows();
    assert.equal(second.injected, 0);
    assert.equal(second.aliveCount, 2);
    assert.equal(injectEvalCount, 2);

    // 3. Hot bundle update triggers seamless re-injection on both windows
    currentVer = 'bundle-v2';
    const upgraded = await controller.syncAllWindows();
    assert.equal(upgraded.injected, 2);
    assert.equal(upgraded.aliveCount, 2);
    assert.equal(windowContexts.get('win1').__AGUsageMonitorOverlay.bundleVersion, 'bundle-v2');
    assert.equal(windowContexts.get('win2').__AGUsageMonitorOverlay.bundleVersion, 'bundle-v2');

    // 4. Disabling enableWindowOverlay disposes and removes globals from all windows
    overlayEnabled = false;
    const disabled = await controller.notifySettingChanged(false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.removed, 2);
    assert.equal(windowContexts.get('win1').__AGUsageMonitorOverlay, undefined);
    assert.equal(windowContexts.get('win1').__AGUsageMonitorBridge, undefined);
  } finally {
    await controller.stop();
    await new Promise((resolve) => cdpHttpServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Capsule 4-stage responsive hysteresis and backend settings default/override', async () => {
  // Hysteresis stability check for dual-capsule topbar layout (multiBtn + capsuleBtn)
  let mode = computeCapsuleLayoutMode(300, 'wide');
  assert.equal(mode, 'wide');
  mode = computeCapsuleLayoutMode(240, mode);
  assert.equal(mode, 'compact');
  // At 265px (< 272px restore threshold), stays compact instead of flickering back to wide
  mode = computeCapsuleLayoutMode(265, mode);
  assert.equal(mode, 'compact');
  mode = computeCapsuleLayoutMode(280, mode);
  assert.equal(mode, 'wide');
  mode = computeCapsuleLayoutMode(150, mode);
  assert.equal(mode, 'minimal');
  mode = computeCapsuleLayoutMode(70, mode);
  assert.equal(mode, 'ring-only');
  mode = computeCapsuleLayoutMode(85, mode);
  assert.equal(mode, 'ring-only');
  mode = computeCapsuleLayoutMode(96, mode);
  assert.equal(mode, 'minimal');

  // Single-capsule mode (showMulti: false) grants ~76px extra breathing room before collapsing
  assert.equal(computeCapsuleLayoutMode(200, 'wide', { showMulti: false }), 'wide');
  assert.equal(computeCapsuleLayoutMode(150, 'wide', { showMulti: false }), 'compact');

  // Backend harness verifies windowMountMode, enableWindowOverlay, showTopbarMultiSession, and topbarCapsuleSlots defaults & normalization
  const defaultEnv = backendHarness({ settings: {} });
  const defaultPayload = await defaultEnv.buildTelemetryPayloadInternal('', false, {});
  assert.equal(defaultPayload.settings.windowMountMode, 'dual');
  assert.equal(defaultPayload.settings.enableWindowOverlay, true);
  assert.equal(defaultPayload.settings.showTopbarMultiSession, true);
  assert.deepEqual(Array.from(defaultPayload.settings.topbarCapsuleSlots), [
    'tps',
    'ttft',
    'context',
  ]);

  const disabledEnv = backendHarness({
    settings: {
      enableWindowOverlay: false,
      showTopbarMultiSession: false,
      topbarCapsuleSlots: ['gemini_5h', 'ttft', 'claude_weekly'],
    },
  });
  const disabledPayload = await disabledEnv.buildTelemetryPayloadInternal('', false, {});
  assert.equal(disabledPayload.settings.windowMountMode, 'sidebar');
  assert.equal(disabledPayload.settings.enableWindowOverlay, false);
  assert.equal(disabledPayload.settings.showTopbarMultiSession, false);
  assert.deepEqual(Array.from(disabledPayload.settings.topbarCapsuleSlots), [
    'gemini_5h',
    'ttft',
    'claude_weekly',
  ]);

  const composerEnv = backendHarness({
    settings: {
      windowMountMode: 'composer',
      enableWindowOverlay: false,
    },
  });
  const composerPayload = await composerEnv.buildTelemetryPayloadInternal('', false, {});
  assert.equal(composerPayload.settings.windowMountMode, 'composer');
  assert.equal(composerPayload.settings.enableWindowOverlay, true);

  const allNoneEnv = backendHarness({
    settings: { topbarCapsuleSlots: ['none', 'none', 'none'] },
  });
  const allNonePayload = await allNoneEnv.buildTelemetryPayloadInternal('', false, {});
  assert.deepEqual(Array.from(allNonePayload.settings.topbarCapsuleSlots), ['context']);

  // Dynamic 5-slot configuration & hysteresis width threshold scaling (+58px per slot beyond 3)
  const fiveSlotEnv = backendHarness({
    settings: {
      topbarCapsuleSlots: ['context', 'tps', 'ttft', 'session_cost', 'claude_weekly'],
    },
  });
  const fiveSlotPayload = await fiveSlotEnv.buildTelemetryPayloadInternal('', false, {});
  assert.deepEqual(Array.from(fiveSlotPayload.settings.topbarCapsuleSlots), [
    'context',
    'tps',
    'ttft',
    'session_cost',
    'claude_weekly',
  ]);
  assert.equal(computeCapsuleLayoutMode(340, 'wide', { slotCount: 5 }), 'compact');
  assert.equal(computeCapsuleLayoutMode(400, 'compact', { slotCount: 5 }), 'wide');
});

test('Compiled app.js mounts dual Shadow DOM hosts, tracks /c/<uuid> routes, protects host reload, and supports composedPath()', async () => {
  const appJsPath = new URL('../app.js', import.meta.url);
  const stylesCssPath = new URL('../styles.css', import.meta.url);
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const stylesCss = fs.readFileSync(stylesCssPath, 'utf8');

  let reloadCalled = false;
  let currentBundleVer = 'ver-100';
  let currentAccountEmail = 'test@example.com';
  let liveSubagentPollActive = false;
  const fetchedUrls = [];
  const fetchedHeaders = [];
  const createdForms = [];
  const winListeners = new Map();

  const {
    docRoot,
    body,
    document: mockDocument,
    docListeners,
    makeElement,
  } = createMockDom({
    defaultRect: { left: 900, right: 1080, top: 6, bottom: 32, width: 180, height: 26 },
    onCreateElement: (node, tag) => {
      if (tag === 'form') createdForms.push(node);
    },
  });

  // Build simulated Antigravity titlebar
  const titlebar = makeElement('div');
  titlebar.className = 'flex items-center @container/titlebar';
  const titleLeft = makeElement('div');
  titleLeft.textContent = 'Chat Title';
  const titleRight = makeElement('div');
  titleRight.className = 'shrink-0 flex items-center';
  const nativeBtn = makeElement('button');
  titleRight.appendChild(nativeBtn);
  titlebar.appendChild(titleLeft);
  titlebar.appendChild(titleRight);
  body.appendChild(titlebar);

  const mockLocation = {
    pathname: '/c/aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    reload() {
      reloadCalled = true;
    },
  };

  const defaultMockSettings = {
    language: 'zh-CN',
    themeAccent: 'host',
    fontScale: 'md',
    pluginUpdateMode: 'manual',
    autoUpdatePlugin: false,
    windowMountMode: 'dual',
    enableWindowOverlay: true,
    showTopbarMultiSession: true,
    enableCliStatusLine: true,
    topbarCapsuleSlots: ['tps', 'ttft', 'context'],
    hoverModules: ['metrics', 'context', 'quotas'],
    overviewModules: ['metrics', 'context', 'quotas', 'live_tasks'],
    overviewMetrics: ['tps', 'ttft', 'avg_tps', 'step_cost'],
    stepTableColumns: ['step', 'model', 'tps', 'ttft', 'tokens_combo', 'cache', 'cost'],
    showStepTurnRail: false,
    showStepAgentBadge: true,
    showStepSpeedColor: false,
    showUpstreamModel: false,
    orchestratorIdMode: 'compact',
    weeklyLimitMode: 'official',
    weeklyTokenBudget: 150000000,
    weeklyCostBudget: 100,
    contextWindowRiskAccepted: false,
    modelContextWindows: {},
  };
  const mockSettings = { ...defaultMockSettings };
  let cacheRebuildCalls = 0;
  let selectedEmail = '';
  const accountRequests = [];

  const mockWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    location: mockLocation,
    document: mockDocument,
    __AGUsageMonitorBridge: {
      port: 49152,
      token: 'secret-bridge-token-123',
      bundleVersion: 'ver-100',
      stylesCss,
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = winListeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    getComputedStyle: () => ({ paddingRight: '8px', getPropertyValue: () => '' }),
    fetch: async (url, opts = {}) => {
      const urlStr = String(url);
      fetchedUrls.push(urlStr);
      fetchedHeaders.push(opts.headers || {});
      if (urlStr.endsWith('/api/accounts') || urlStr.endsWith('/api/accounts/update')) {
        if (opts.method === 'POST') {
          const update = JSON.parse(opts.body);
          accountRequests.push(update);
          if (update.action === 'quota') {
            return { ok: true, status: 200, json: async () => ({ email: update.email, pools: [{ poolKey: 'Gemini', remainingPct: 70 }] }) };
          }
          if (update.action === 'switch') selectedEmail = update.email;
        }
        return { ok: true, status: 200, json: async () => ({ supported: true, accounts: ['next@example.com'], selectedEmail }) };
      }
      if (urlStr.includes('/api/settings/reset') && String(opts.method || '').toUpperCase() === 'POST') {
        for (const k of Object.keys(mockSettings)) delete mockSettings[k];
        Object.assign(mockSettings, {
          ...defaultMockSettings,
          topbarCapsuleSlots: [...defaultMockSettings.topbarCapsuleSlots],
          hoverModules: [...defaultMockSettings.hoverModules],
          overviewModules: [...defaultMockSettings.overviewModules],
          overviewMetrics: [...defaultMockSettings.overviewMetrics],
          stepTableColumns: [...defaultMockSettings.stepTableColumns],
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, settings: { ...mockSettings } }),
        };
      }
      if (urlStr.includes('/api/cache/rebuild') && String(opts.method || '').toUpperCase() === 'POST') {
        cacheRebuildCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, clearedEntries: 12 }),
        };
      }
      if (urlStr.includes('/api/context-window') && opts.method === 'POST') {
        const { modelId, option } = JSON.parse(opts.body);
        const modelContextWindows = { ...mockSettings.modelContextWindows };
        if (option === null) delete modelContextWindows[modelId];
        else modelContextWindows[modelId] = option;
        mockSettings.modelContextWindows = modelContextWindows;
        return { ok: true, status: 200, json: async () => ({ modelContextWindows }) };
      }
      if (urlStr.includes('/api/settings') && String(opts.method || '').toUpperCase() === 'POST') {
        const patch = opts.body ? JSON.parse(opts.body) : {};
        Object.assign(mockSettings, patch);
        if (patch.windowMountMode !== undefined && patch.enableWindowOverlay === undefined) {
          mockSettings.enableWindowOverlay = patch.windowMountMode !== 'sidebar';
        }
        if (patch.pluginUpdateMode !== undefined && patch.autoUpdatePlugin === undefined) {
          mockSettings.autoUpdatePlugin = patch.pluginUpdateMode === 'auto';
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...mockSettings }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          uiBundleVersion: currentBundleVer,
          settings: { ...mockSettings },
          contextWindowModels: [
            { id: 'model:gemini-4-argon', label: 'Argon', members: ['MODEL_PLACEHOLDER_M430', 'MODEL_PLACEHOLDER_M417'],
              reportedLimitTokens: 256000, options: [{ name: '512000', tokens: 512000 }] },
            { id: 'model:gemini-3.8-flash', label: 'Flash', options: [{ name: '256K' }] },
            { id: 'MODEL_PLACEHOLDER_M432', label: 'Other', options: [] },
          ],
          cloudStatus: { updateAvailable: true, currentPluginVersion: '1.4.2', latestPluginVersion: '1.5.0' },
          account: { status: 'signedIn', email: currentAccountEmail, tierName: 'Google AI Ultra', planName: 'Pro', totalConversations: 5 },
          runningConversations: [
            {
              cascadeId: 'bbbbbbbb-2222-3333-4444-cccccccccccc',
              title: 'Background Security Audit',
              isCurrentSelected: false,
              isMainRunning: true,
              isRunning: true,
              stepCount: 24,
              totalStepCount: 38,
              latestTokPerSec: 64.2,
              contextUsedPct: 48.4,
              mainActivity: {
                phase: 'tool',
                label: '执行命令',
                detail: 'rg -n ProtectedURLFilter',
                stepProgress: '1/2',
                startedAtMs: Date.now() - 12000,
                signature: 'tool:rg:1',
              },
              subagentCount: 1,
              runningSubagentCount: 1,
              subagents: [
                {
                  cascadeId: 'bbbbbbbb-2222-3333-4444-cccccccccccc:sub1',
                  index: 1,
                  badgeText: '子1',
                  shortLabel: '子代理 #1',
                  role: 'Auth Researcher',
                  isRunning: true,
                  stepCount: 14,
                  lastModifiedMs: Date.now() - 8000,
                  liveActivity: {
                    phase: 'thinking',
                    label: '读取文件',
                    detail: 'MastLoginFilter.java',
                    stepProgress: '',
                    startedAtMs: Date.now() - 8000,
                    signature: 'sub1:read',
                  },
                },
              ],
            },
            {
              cascadeId: 'eeeeeeee-5555-6666-7777-ffffffffffff',
              title: 'Solo Refactor Task',
              isCurrentSelected: false,
              isMainRunning: true,
              isRunning: true,
              stepCount: 9,
              totalStepCount: 9,
              latestTokPerSec: 72.1,
              contextUsedPct: 21.0,
              mainActivity: {
                phase: 'thinking',
                label: '推理中',
                detail: '',
                stepProgress: '',
                startedAtMs: Date.now() - 4000,
                signature: 'solo:think',
              },
              subagentCount: 0,
              runningSubagentCount: 0,
              subagents: [],
            },
          ],
          conversations: [
            {
              cascadeId: 'bbbbbbbb-2222-3333-4444-cccccccccccc',
              title: 'Background Security Audit',
              stepCount: 24,
              subagentCount: 1,
              runningSubagentCount: 1,
              totalStepCount: 38,
              isRunning: true,
              contextUsedPct: 48.4,
              sessionCostUsd: 1.85,
              lastModifiedMs: Date.now() - 2000,
            },
            {
              cascadeId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
              title: 'Dual Mode Session',
              stepCount: 6,
              subagentCount: 0,
              totalStepCount: 6,
              isRunning: false,
              contextUsedPct: 50,
              sessionCostUsd: 7.3,
              lastModifiedMs: Date.now() - 180000,
            },
          ],
          activeConversation: (() => {
            const mainSteps = [
              {
                stepIndex: 35,
                createdAtMs: 2000,
                turnIndex: 1,
                isTurnStart: false,
                isLatestTurn: true,
                turnPrompt: '请优化调用明细与轮次导轨',
                rootTurnIndex: 1,
                isRootTurnStart: false,
                isRootLatestTurn: true,
                rootTurnPrompt: '请优化调用明细与轮次导轨',
                modelLabel: 'Gemini 4 Hydrogen',
                modelShort: 'gemini-4-hydrogen',
                modelUpstream: 'gemini-4-hydrogen',
                tokPerSec: 92.3,
                ttftSec: 5.6,
                contextTokens: 37800,
                inputTokens: 2500,
                cacheReadTokens: 34615,
                outputTokens: 685,
                thinkingTokens: 420,
                responseTokens: 265,
                cacheHitPct: 93.6,
                costUsd: 0.014,
              },
              {
                stepIndex: 20,
                createdAtMs: 1000,
                turnIndex: 1,
                isTurnStart: true,
                isLatestTurn: true,
                turnPrompt: '请优化调用明细与轮次导轨',
                rootTurnIndex: 1,
                isRootTurnStart: true,
                isRootLatestTurn: true,
                rootTurnPrompt: '请优化调用明细与轮次导轨',
                modelLabel: 'Claude Opus 4.6',
                modelShort: 'claude-opus-4.6',
                modelUpstream: 'claude-opus-4-6',
                tokPerSec: 52.2,
                ttftSec: 14.8,
                contextTokens: 117746,
                inputTokens: 4492,
                cacheReadTokens: 98713,
                outputTokens: 14541,
                thinkingTokens: 14484,
                cacheHitPct: 95.6,
                costUsd: 0.032,
              },
            ];
            const mainModels = [
              {
                label: 'Gemini 4 Hydrogen',
                shortName: 'gemini-4-hydrogen',
                upstreamName: 'gemini-4-hydrogen',
                calls: 1,
                avgTokPerSec: 92.3,
                avgTtftSec: 5.6,
                cacheHitPct: 93.3,
                inputTokens: 2500,
                cacheReadTokens: 34615,
                outputTokens: 685,
                thinkingTokens: 420,
                responseTokens: 265,
                totalTokens: 37800,
                costUsd: 0.014,
              },
              {
                label: 'Claude Opus 4.6',
                shortName: 'claude-opus-4.6',
                upstreamName: 'claude-opus-4-6',
                calls: 1,
                avgTokPerSec: 52.2,
                avgTtftSec: 14.8,
                cacheHitPct: 95.6,
                inputTokens: 4492,
                cacheReadTokens: 98713,
                outputTokens: 14541,
                thinkingTokens: 14484,
                responseTokens: 57,
                totalTokens: 117746,
                costUsd: 0.032,
              },
            ];
            if (!liveSubagentPollActive) {
              return {
                cascadeId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
                title: 'Dual Mode Session',
                isRunning: false,
                stepCount: 6,
                latestTokPerSec: 92.4,
                latestTtftSec: 0.85,
                avgTokPerSec: 88.2,
                latestStepCostUsd: 0.04,
                latestCacheHitPct: 98.7,
                sessionCostUsd: 7.3,
                activeModelLabel: 'Gemini 4 Hydrogen',
                activeModelShort: 'gemini-4-hydrogen',
                context: {
                  totalTokens: 128000,
                  compactionLimitTokens: 256000,
                  limitTokens: 256000,
                  toolResultsTokens: 76000,
                  assistantTokens: 42000,
                  userRulesTokens: 10000,
                },
                recentSteps: mainSteps,
                modelBreakdown: mainModels,
              };
            }
            const subStep = {
              agentId: 'sub-fast-1',
              agentCascadeId: 'sub-fast-1',
              agentIndex: 1,
              agentBadge: '子1',
              agentLabel: '子代理 #1 · Flash Researcher',
              isSubagent: true,
              stepIndex: 4,
              createdAtMs: 3500,
              turnIndex: 1,
              isTurnStart: true,
              isLatestTurn: true,
              turnPrompt: '审计子代理任务',
              rootTurnIndex: 1,
              isRootTurnStart: false,
              isRootLatestTurn: true,
              rootTurnPrompt: '请优化调用明细与轮次导轨',
              modelLabel: 'Gemini 3 Flash',
              modelShort: 'gemini-3-flash',
              modelUpstream: 'gemini-3-flash',
              tokPerSec: 145.0,
              ttftSec: 1.2,
              contextTokens: 18400,
              inputTokens: 1800,
              cacheReadTokens: 16200,
              outputTokens: 400,
              thinkingTokens: 80,
              responseTokens: 320,
              cacheHitPct: 90.0,
              costUsd: 0.004,
            };
            const subModel = {
              label: 'Gemini 3 Flash',
              shortName: 'gemini-3-flash',
              upstreamName: 'gemini-3-flash',
              calls: 1,
              avgTokPerSec: 145.0,
              avgTtftSec: 1.2,
              cacheHitPct: 90.0,
              inputTokens: 1800,
              cacheReadTokens: 16200,
              outputTokens: 400,
              thinkingTokens: 80,
              responseTokens: 320,
              totalTokens: 18400,
              costUsd: 0.004,
            };
            return {
              cascadeId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
              title: 'Dual Mode Session',
              isRunning: true,
              hasSubagents: true,
              subagentCount: 1,
              stepCount: 6,
              latestTokPerSec: 145.0,
              latestTtftSec: 1.2,
              avgTokPerSec: 96.5,
              latestStepCostUsd: 0.004,
              latestCacheHitPct: 90.0,
              sessionCostUsd: 7.304,
              activeModelLabel: 'Gemini 3 Flash',
              activeModelShort: 'gemini-3-flash',
              context: {
                totalTokens: 128000,
                compactionLimitTokens: 256000,
                limitTokens: 256000,
                toolResultsTokens: 76000,
                assistantTokens: 42000,
                userRulesTokens: 10000,
              },
              recentSteps: mainSteps.map((s) => ({
                ...s,
                agentId: 'main',
                agentBadge: '主',
                isSubagent: false,
              })),
              modelBreakdown: mainModels,
              agents: [
                {
                  agentId: 'main',
                  isMain: true,
                  index: 0,
                  shortLabel: '主代理',
                  badgeText: '主',
                  stepCount: 2,
                  activeModelLabel: 'Gemini 4 Hydrogen',
                  activeModelShort: 'gemini-4-hydrogen',
                  recentSteps: mainSteps.map((s) => ({
                    ...s,
                    agentId: 'main',
                    agentBadge: '主',
                    isSubagent: false,
                  })),
                  modelBreakdown: mainModels,
                },
                {
                  agentId: 'sub-fast-1',
                  isMain: false,
                  index: 1,
                  shortLabel: '子代理 #1',
                  badgeText: '子1',
                  role: 'Flash Researcher',
                  isRunning: true,
                  stepCount: 1,
                  activeModelLabel: 'Gemini 3 Flash',
                  activeModelShort: 'gemini-3-flash',
                  recentSteps: [subStep],
                  modelBreakdown: [subModel],
                },
              ],
              aggregated: {
                agentId: 'all',
                shortLabel: '全部汇总',
                badgeText: '全部',
                stepCount: 3,
                activeAgentId: 'sub-fast-1',
                activeModelLabel: 'Gemini 3 Flash',
                activeModelShort: 'gemini-3-flash',
                recentSteps: [
                  subStep,
                  ...mainSteps.map((s) => ({
                    ...s,
                    agentId: 'main',
                    agentBadge: '主',
                    isSubagent: false,
                  })),
                ],
                modelBreakdown: [...mainModels, subModel],
              },
            };
          })(),
          consumption: (() => {
            const isAllRange = String(url).includes('range=all');
            const dayCount = isAllRange ? 120 : 30;
            const baseDayMs = Date.UTC(2026, 6, 18, 0, 0, 0);
            const trendSeries = Array.from({ length: dayCount }, (_, idx) => {
              const sMs = baseDayMs + idx * 86400_000;
              const d = new Date(sMs);
              const tokens = idx % 3 === 0 ? (idx + 1) * 100_000 : 0;
              return {
                index: idx,
                startMs: sMs,
                endMs: sMs + 86400_000,
                granularity: 'day',
                label: `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`,
                fullLabel: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (周六)`,
                tokens,
                inputTokens: tokens > 0 ? 20_000 : 0,
                cacheReadTokens: tokens > 0 ? tokens - 25_000 : 0,
                outputTokens: tokens > 0 ? 5_000 : 0,
                costUsd: tokens > 0 ? 0.12 : 0,
                calls: tokens > 0 ? 4 : 0,
              };
            });
            return {
              selectedRange: {
                key: isAllRange ? 'all' : 'today',
                label: isAllRange ? '全部时间' : '今天',
                startMs: baseDayMs,
                endMs: baseDayMs + dayCount * 86400_000,
              },
              session: { totalTokens: 128000, costUsd: 0.42, unpricedCalls: 12 },
              account: { totalTokens: 500000, costUsd: 1.5, unpricedCalls: 3993 },
              trendSeries,
              monthlySeries: [],
            };
          })(),
          quotas: {
            meta: { hasOfficialData: true },
            activePool: { family: 'Carbon', poolLabel: 'Carbon', remainingPct: 68, weeklyRemainingPct: 81 },
            pools: [
              {
                poolKey: 'Gemini',
                poolLabel: 'Gemini',
                usedPct: 56,
                remainingPct: currentAccountEmail === 'test@example.com' ? 44 : 0,
                resetTime: new Date(Date.now() + 2 * 3600_000).toISOString(),
                weeklyUsedPct: 74,
                weeklyRemainingPct: 26,
                weeklyResetTime: new Date(Date.now() + 4 * 24 * 3600_000).toISOString(),
                cycle5h: { tokens: 3_100_000, costUsd: 0.92, calls: 18 },
                cycleWeekly: { tokens: 18_200_000, costUsd: 5.4, calls: 112 },
              },
              {
                poolKey: 'Claude & GPT',
                poolLabel: 'Claude & GPT',
                usedPct: 0,
                remainingPct: 100,
                resetTime: new Date(Date.now() + 5 * 3600_000).toISOString(),
                weeklyUsedPct: 9,
                weeklyRemainingPct: 91,
                weeklyResetTime: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
                cycle5h: { tokens: 0, costUsd: 0, calls: 0 },
                cycleWeekly: { tokens: 7_300_000, costUsd: 3.82, calls: 48 },
              },
            ],
            weekly: {
              isOfficial: true,
              remainingPct: 81,
              tokens: 25_500_000,
              costUsd: 9.22,
              calls: 160,
            },
          },
          modelBreakdown: [],
        }),
      };
    },
  };
  mockWindow.window = mockWindow;
  mockWindow.globalThis = mockWindow;

  const sandbox = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: mockDocument,
    location: mockLocation,
    navigator: {},
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: mockWindow.fetch,
    console,
  });

  vm.runInContext(appJs, sandbox);
  await new Promise((r) => setTimeout(r, 40));

  try {
    const ov = mockWindow.__AGUsageMonitorOverlay;
    assert.ok(ov, 'Overlay handle should be registered on window');
    assert.equal(ov.ensureAlive(), true);

    const capsuleHost = mockDocument.getElementById('ag-usage-monitor-capsule');
    const portalHost = mockDocument.getElementById('ag-usage-monitor-portal');
    assert.ok(capsuleHost, 'Capsule host mounted');
    assert.ok(portalHost, 'Portal host mounted');
    assert.equal(capsuleHost.getAttribute('data-dock'), 'flow');
    assert.equal(capsuleHost.parentNode, titleRight);
    assert.equal(titleRight.firstChild, capsuleHost, 'Capsule inserted before native right buttons');

    // Verify authenticated bridge call & automatic /c/<uuid> route tracking
    assert.ok(fetchedUrls.length >= 1);
    assert.ok(fetchedUrls[0].startsWith('http://127.0.0.1:49152/api/telemetry?'));
    assert.ok(fetchedUrls[0].includes('conversationId=aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb'));
    assert.equal(fetchedHeaders[0]['X-Usage-Monitor-Token'], 'secret-bridge-token-123');

    // Verify dual topbar buttons: left multi-session button (.wm-multi-btn) before right telemetry capsule (.wm-capsule-btn)
    const multiBtn = capsuleHost.shadowRoot.querySelector('.wm-multi-btn');
    const capsuleBtn = capsuleHost.shadowRoot.querySelector('.wm-capsule-btn');
    assert.ok(multiBtn, 'Left multi-session button mounted');
    assert.ok(capsuleBtn, 'Right telemetry capsule button mounted');
    assert.ok(
      capsuleHost.shadowRoot.children.indexOf(multiBtn) <
        capsuleHost.shadowRoot.children.indexOf(capsuleBtn),
      'Multi-session button sits immediately to the left of telemetry capsule'
    );
    assert.equal(multiBtn.querySelector('.svg-icon'), null, 'Multi-session button has zero SVG clutter');
    assert.equal(multiBtn.classList.contains('is-running'), true);
    const multiLabelEl = multiBtn.querySelector('.wm-multi-label');
    assert.equal(multiLabelEl.textContent, '2 运行 · 1 子');

    // Verify capsule reactive text (default order: 92.4 t/s without bolt SVG, 0.85s TTFT, 50% context)
    const defaultCapSlots = capsuleHost.shadowRoot.querySelectorAll('.wm-cap-slot');
    const ctxPctEl = capsuleHost.shadowRoot.querySelector('.wm-ctx-pct');
    const speedSegEl = capsuleHost.shadowRoot.querySelector('.wm-seg-speed');
    assert.equal(defaultCapSlots[0].getAttribute('data-metric'), 'tps');
    assert.equal(defaultCapSlots[1].getAttribute('data-metric'), 'ttft');
    assert.equal(defaultCapSlots[2].getAttribute('data-metric'), 'context');
    assert.equal(speedSegEl.children.length, 1, 'Speed segment has no lightning bolt SVG');
    assert.equal(speedSegEl.querySelector('.svg-icon'), null);
    assert.ok(speedSegEl.children[0].textContent.includes('92.4 t/s'));
    assert.equal(defaultCapSlots[1].children[0].textContent, '0.85s');
    assert.equal(ctxPctEl.textContent, '50%');

    // Verify hovering left multi-session button opens .wm-multi-panel with live tasks, subagents, and recent sessions
    const multiPanelEl = portalHost.shadowRoot.querySelector('.wm-multi-panel');
    const hoverTipEl = portalHost.shadowRoot.querySelector('.wm-hover-tip');
    assert.ok(multiPanelEl, 'Multi-session floating panel mounted in portal shadow root');
    assert.equal(multiPanelEl.children.length, 3, 'Single-layer online sessions panel (header + empty state + running list)');

    multiBtn.dispatchEvent({ type: 'mouseenter', clientX: 930, clientY: 18 });
    assert.equal(ov.isMultiOpen(), true);
    assert.equal(ov.isMultiHoverOpen(), true);
    assert.equal(multiPanelEl.hasAttribute('hidden'), false);

    // Stationary pointer inside multiBtn prevents synthetic mouseleave blink
    multiBtn.dispatchEvent({ type: 'mouseleave', clientX: 930, clientY: 18 });
    await new Promise((r) => setTimeout(r, 110));
    assert.equal(ov.isMultiOpen(), true, 'Stationary pointer inside multi button prevents synthetic mouseleave blink');

    const runningListEl = multiPanelEl.querySelector('.live-activity-list');
    assert.equal(runningListEl.children.length, 2, 'Both running session cards rendered');
    const liveTaskCard = runningListEl.children[0];
    const soloTaskCard = runningListEl.children[1];
    assert.equal(liveTaskCard.querySelector('.live-task-title').textContent, 'Background Security Audit');
    assert.equal(liveTaskCard.querySelector('.badge-main').hasAttribute('hidden'), false, 'Session with subagents shows 主 badge');
    assert.equal(liveTaskCard.querySelector('.live-activity-phase').textContent, '执行命令');
    assert.equal(liveTaskCard.querySelector('.live-sub-list').hasAttribute('hidden'), false, 'Active subagents auto-expanded');
    assert.equal(liveTaskCard.querySelector('.live-sub-role').textContent, 'Auth Researcher');
    assert.equal(soloTaskCard.querySelector('.live-task-title').textContent, 'Solo Refactor Task');
    assert.equal(soloTaskCard.querySelector('.badge-main').hasAttribute('hidden'), true, 'Session without subagents hides 主 badge');
    const liveDotSvg = liveTaskCard.querySelector('.live-activity-dot').children[0];
    assert.equal(liveDotSvg.attributes.get('width'), '11', 'Enlarged live activity SVG dot size is 11');
    assert.equal(liveDotSvg.children[0].attributes.get('r'), '5', 'Enlarged dot circle radius is 5');
    assert.match(stylesCss, /\.wm-multi-dot\s*\{\s*width:\s*8px;\s*height:\s*8px;/, 'Topbar multi-session dot enlarged to 8px');
    assert.match(
      stylesCss,
      /\.wm-hover-tip\s*\{[^}]*width:\s*min\(calc\(522px \* var\(--ui-panel-scale, 1\)\),\s*calc\(100vw - 24px\)\);/,
      'Hover floating card base width is 522px and scales with --ui-panel-scale'
    );
    assert.equal(multiPanelEl.querySelector('.wm-recent-list'), null, 'Recent sessions list removed so panel shows online sessions only');
    assert.equal(multiPanelEl.querySelector('.panel'), null, 'Single-layer multi-session panel without nested .panel box');

    // Verify hovering right capsule closes unpinned multi-session panel and opens decoupled 3-widget hover HUD (.wm-hover-tip)
    assert.ok(hoverTipEl, 'Hover overview HUD mounted in portal shadow root');
    assert.equal(
      hoverTipEl.children.length,
      2,
      'Hover HUD has optional update banner + decoupled .wm-hover-widgets host'
    );
    const hoverWidgetsHost = hoverTipEl.querySelector('.wm-hover-widgets');
    assert.equal(
      hoverWidgetsHost.children.length,
      3,
      'Default hoverModules mounts 3 standalone widgets (metrics + context + quotas)'
    );
    assert.equal(
      multiPanelEl.querySelector('.wm-multi-empty-hint'),
      null,
      'Redundant hover/pin hint copy removed from multi-session empty state'
    );

    capsuleBtn.dispatchEvent({ type: 'mouseenter', clientX: 960, clientY: 18 });
    assert.equal(ov.isMultiOpen(), false, 'Mutual exclusion closes unpinned multi-session panel');
    assert.equal(ov.isHoverOpen(), true);
    assert.equal(hoverTipEl.hasAttribute('hidden'), false);

    // Transient mouseleave while pointer remains inside capsule rect (900..1080 x 6..32) must NOT close hover HUD
    capsuleBtn.dispatchEvent({ type: 'mouseleave', clientX: 960, clientY: 18 });
    await new Promise((r) => setTimeout(r, 55));
    assert.equal(ov.isHoverOpen(), true, 'Stationary pointer inside capsule prevents synthetic mouseleave blink');

    const hoverMatrix = hoverTipEl.querySelector('.telemetry-matrix');
    const hoverLegendGrid = hoverTipEl.querySelector('.ctx-legend-grid');
    const hoverQuotaPools = hoverTipEl.querySelector('.wm-hover-quota-pools');
    assert.equal(hoverMatrix.children.length, 4);
    assert.equal(hoverMatrix.children[0].children[1].textContent, '92.4 tok/s');
    assert.equal(hoverMatrix.children[3].children[1].textContent, '$0.040');
    assert.equal(hoverLegendGrid.children.length, 10, 'All 10 context legend slots pre-reserved');
    const firstLegendSlotBefore = hoverLegendGrid.children[0];
    assert.equal(firstLegendSlotBefore.children[0].children[1].textContent, '工具结果');
    assert.equal(firstLegendSlotBefore.children[1].textContent, '76.0k');
    assert.equal(hoverQuotaPools.children.length, 2, 'Default Gemini & Claude/GPT quota pools pre-reserved');
    assert.equal(hoverQuotaPools.children[0].children.length, 2, 'Zero extra vertical rows in pool item');
    const geminiHoverTitles = hoverQuotaPools.children[0].querySelectorAll('.quota-win-title');
    const geminiHoverUsages = hoverQuotaPools.children[0].querySelectorAll('.quota-win-usage');
    assert.equal(geminiHoverTitles[0].textContent, '周限 (Gemini)');
    assert.equal(geminiHoverUsages[0].textContent, '· 18.2M ($5.40)');
    assert.equal(geminiHoverTitles[1].textContent, '5h (Gemini)');
    assert.equal(geminiHoverUsages[1].textContent, '· 3.1M ($0.92)');
    const claudeHoverUsages = hoverQuotaPools.children[1].querySelectorAll('.quota-win-usage');
    assert.equal(claudeHoverUsages[0].textContent, '· 7.3M ($3.82)');
    assert.equal(claudeHoverUsages[1].textContent, '· 0 ($0.00)');
    const hoverFootSpans = hoverTipEl.querySelector('.wm-hover-quota-foot').children;
    assert.equal(hoverFootSpans[0].textContent, '周期累计: 25.5M ($9.22)');
    assert.equal(hoverFootSpans[1].textContent, '周期调用: 160 次');

    // Verify clicking multi-session button pins open multi-session panel, and clicking capsule switches to 4-tab panel
    multiBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(ov.isMultiPinnedOpen(), true);
    assert.equal(ov.isHoverOpen(), false);
    assert.equal(multiBtn.classList.contains('is-open'), true);

    ov.open();
    assert.equal(ov.isMultiOpen(), false);
    assert.equal(ov.isHoverOpen(), false);
    assert.equal(hoverTipEl.hasAttribute('hidden'), true);
    assert.equal(ov.isOpen(), true);
    const popoverEl = portalHost.shadowRoot.querySelector('.wm-popover-panel');
    assert.equal(popoverEl.hasAttribute('hidden'), false);
    const overviewUsageSpans = popoverEl.querySelectorAll('.quota-win-usage');
    assert.equal(overviewUsageSpans.length, 4, 'LiveOverviewView renders inline weekly and 5h cycle stats for both pools');
    assert.equal(overviewUsageSpans[0].textContent, '· 18.2M ($5.40)');
    assert.equal(overviewUsageSpans[1].textContent, '· 3.1M ($0.92)');

    // Verify Shadow DOM retargeted click inside CustomSelect does NOT close select or popover
    const selectRoot = portalHost.shadowRoot.querySelector('.custom-select');
    const selectTrigger = selectRoot.querySelector('.select-trigger');
    selectTrigger.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(selectRoot.classList.contains('is-open'), true);

    // Simulate document capture-phase click retargeted to portalHost while composedPath includes selectRoot
    for (const fn of docListeners.get('click') || []) {
      fn({
        target: portalHost,
        composedPath: () => [selectTrigger, selectRoot, popoverEl, portalHost.shadowRoot, portalHost, body, docRoot],
      });
    }
    assert.equal(selectRoot.classList.contains('is-open'), true, 'CustomSelect stays open via composedPath');
    selectTrigger.dispatchEvent({ type: 'click', stopPropagation() {} });

    // Verify modular 3-tab SettingsView (常规 / 结构 / 其他) with Account tab hidden
    const pillTabs = popoverEl.querySelectorAll('.pill-tab');
    pillTabs[pillTabs.length - 1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));

    const allPanes = popoverEl.querySelectorAll('.view-pane');
    const settingsRoot = popoverEl.querySelector('.settings-view-root');
    const subNavBtns = settingsRoot.querySelector('.settings-subnav-bar').querySelectorAll('.seg-btn');
    assert.deepEqual(subNavBtns.map((button) => button.textContent), ['常规', '结构', '其他']);
    assert.match(
      stylesCss,
      /\.settings-subnav-bar\s+\.segmented\s*\{[^}]*grid-auto-flow:\s*column;[^}]*grid-auto-columns:\s*minmax\(0,\s*1fr\);/,
      'Settings subnav uses auto-sized equal columns regardless of visible tab count'
    );
    const [generalPane, structurePane, otherPane] = settingsRoot.querySelectorAll('.settings-tab-stack');
    const thirdNavBar = settingsRoot.querySelector('.settings-thirdnav-bar');
    assert.ok(thirdNavBar, '3rd-level structure menu bar mounted in SettingsView');
    assert.equal(thirdNavBar.hasAttribute('hidden'), true, '3rd-level menu hidden when General tab is active');
    assert.equal(generalPane.hasAttribute('hidden'), false, 'General tab active by default');
    assert.equal(structurePane.hasAttribute('hidden'), true);
    assert.equal(otherPane.hasAttribute('hidden'), true);

    // --- Tab 0: 常规 (languageSwitch, themeAccent, fontScaleSwitch, pluginUpdateMode) ---
    const generalSegControls = generalPane.querySelectorAll('.segmented');
    assert.equal(generalSegControls.length, 2, 'General tab has Language and FontScale segmented controls');
    const langBtns = generalSegControls[0].querySelectorAll('.seg-btn');
    const fontScaleBtns = generalSegControls[1].querySelectorAll('.seg-btn');
    assert.equal(langBtns.length, 3, 'Language switch has 简体中文 / English / 跟随宿主');
    assert.equal(langBtns[0].textContent, '简体中文');
    assert.equal(langBtns[0].classList.contains('is-active'), true, 'Default language is zh-CN');
    const generalSelects = generalPane.querySelectorAll('.custom-select');
    assert.equal(generalSelects.length, 1, 'General tab has Update Mode select');
    const updateModeSelectEl = generalSelects[0];

    // Theme accent picker: switch to emerald, verify CSS vars injected on both hosts, then restore host
    const swatchBtns = generalPane.querySelectorAll('.theme-swatch-btn');
    assert.equal(swatchBtns.length, 6, '6 curated theme swatches rendered');
    const emeraldBtn = swatchBtns.find((b) => b.getAttribute('data-accent-key') === 'emerald');
    emeraldBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.themeAccent, 'emerald');
    assert.equal(portalHost.style.getPropertyValue('--user-accent-primary'), 'hsl(152 66% 39%)', 'Portal host gets emerald accent');
    assert.equal(capsuleHost.style.getPropertyValue('--user-accent-primary'), 'hsl(152 66% 39%)', 'Capsule host gets emerald accent');
    const hostChipBtn = generalPane.querySelector('.theme-host-chip');
    hostChipBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.themeAccent, 'host');
    assert.equal(portalHost.style.getPropertyValue('--user-accent-primary'), '', 'Host accent clears override');

    // Font scale: switch to xl (1.28), verify portalHost and inner panels scale while capsuleHost NEVER scales
    assert.equal(fontScaleBtns.length, 4, 'Font scale segmented control has sm / md / lg / xl');
    fontScaleBtns[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.fontScale, 'xl');
    assert.equal(portalHost.style.getPropertyValue('--ui-font-scale'), '1.28', 'Portal host scales to 1.28');
    assert.equal(portalHost.style.getPropertyValue('--ui-panel-scale'), '1.18', 'Portal host panel width scales to 1.18');
    assert.equal(popoverEl.getAttribute('data-font-scale'), 'xl', 'Popover panel receives data-font-scale');
    assert.equal(hoverTipEl.getAttribute('data-font-scale'), 'xl', 'Hover card receives data-font-scale');
    assert.equal(multiPanelEl.getAttribute('data-font-scale'), 'xl', 'Multi-session panel receives data-font-scale');
    assert.equal(capsuleHost.style.getPropertyValue('--ui-font-scale'), '', 'Capsule host strictly excludes font scale');
    assert.equal(capsuleHost.hasAttribute('data-font-scale'), false);
    fontScaleBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.fontScale, 'md');
    assert.equal(portalHost.style.getPropertyValue('--ui-font-scale'), '');
    assert.equal(portalHost.style.getPropertyValue('--ui-panel-scale'), '');
    assert.equal(portalHost.getAttribute('data-font-scale'), 'md');
    assert.equal(popoverEl.getAttribute('data-font-scale'), 'md');

    // Live i18n switch: zh-CN -> en-US -> zh-CN without page reload
    langBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.language, 'en-US');
    assert.equal(pillTabs[0].querySelector('.pill-tab-label').textContent, 'Live');
    assert.equal(pillTabs[3].querySelector('.pill-tab-label').textContent, 'Settings');
    assert.equal(subNavBtns[0].textContent, 'General');
    assert.equal(subNavBtns[1].textContent, 'Structure');
    assert.equal(subNavBtns[2].textContent, 'Other');
    langBtns[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.language, 'zh-CN');
    assert.equal(pillTabs[0].querySelector('.pill-tab-label').textContent, '实时监控');
    assert.equal(subNavBtns[0].textContent, '常规');

    // Verify 3-tier update mode select (manual default -> off hides topbar/hover prompts -> auto -> manual)
    const topbarUpdateBtn = capsuleHost.shadowRoot.querySelector('.wm-update-btn');
    const hoverUpdateBar = hoverTipEl.querySelector('.wm-hover-update-bar');
    const headerUpdateBtn = popoverEl.querySelector('.update-badge-btn');
    assert.ok(topbarUpdateBtn, 'Topbar subtle update pill button mounted');
    assert.ok(hoverUpdateBar, 'Hover card update banner mounted');
    assert.equal(topbarUpdateBtn.hasAttribute('hidden'), false, 'Update pill visible in default manual mode');
    assert.equal(topbarUpdateBtn.querySelector('.wm-update-label').textContent, 'v1.5.0');
    assert.ok(
      topbarUpdateBtn.children[0].children[0].getAttribute('d').includes('13.2l3.8-3.8'),
      'Topbar update pill uses downward arrow matching panel & settings design language'
    );
    assert.equal(hoverUpdateBar.hasAttribute('hidden'), false, 'Hover update bar visible in default manual mode');
    assert.ok(
      hoverUpdateBar
        .querySelector('.wm-hover-update-left')
        .children[0].children[0].getAttribute('d')
        .includes('13.2l3.8-3.8'),
      'Hover update bar uses downward arrow matching panel & settings design language'
    );
    assert.equal(
      hoverUpdateBar.querySelector('.wm-hover-update-left').children[1].textContent,
      '发现新版本 v1.5.0'
    );
    assert.equal(
      hoverUpdateBar.querySelector('.wm-hover-update-hint').textContent,
      '点击顶栏 v1.5.0 即可更新'
    );
    assert.equal(headerUpdateBtn.hasAttribute('hidden'), false);

    assert.equal(updateModeSelectEl.querySelector('.select-label').textContent, '仅提示新版本，手动更新');
    updateModeSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    const updateOpts = updateModeSelectEl.querySelectorAll('.select-option');
    assert.equal(updateOpts.length, 3, '3 update modes rendered (manual, auto, off)');
    assert.equal(updateOpts[0].querySelector('.select-option-text').textContent, '仅提示新版本，手动更新');
    assert.equal(updateOpts[1].querySelector('.select-option-text').textContent, '自动更新');
    assert.equal(updateOpts[2].querySelector('.select-option-text').textContent, '关闭更新');

    updateOpts[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.pluginUpdateMode, 'off');
    assert.equal(mockSettings.autoUpdatePlugin, false);
    assert.equal(topbarUpdateBtn.hasAttribute('hidden'), true, 'Topbar update pill hidden when mode=off');
    assert.equal(hoverUpdateBar.hasAttribute('hidden'), true, 'Hover update bar hidden when mode=off');
    assert.equal(headerUpdateBtn.hasAttribute('hidden'), true, 'Header update button hidden when mode=off');

    updateModeSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    updateModeSelectEl.querySelectorAll('.select-option')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.pluginUpdateMode, 'auto');
    assert.equal(mockSettings.autoUpdatePlugin, true);
    assert.equal(topbarUpdateBtn.hasAttribute('hidden'), false, 'Topbar update pill restored when mode=auto');

    updateModeSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    updateModeSelectEl.querySelectorAll('.select-option')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(mockSettings.pluginUpdateMode, 'manual');
    assert.equal(mockSettings.autoUpdatePlugin, false);
    assert.equal(topbarUpdateBtn.hasAttribute('hidden'), false, 'Topbar update pill visible when mode=manual');

    // --- Tab 1: 结构 (3rd-level menu + 4 real-UI live previews + mouse drag reordering) ---
    subNavBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(structurePane.hasAttribute('hidden'), false);
    assert.equal(thirdNavBar.hasAttribute('hidden'), false, '3rd-level menu visible when Structure tab is active');
    const thirdNavBtns = thirdNavBar.querySelectorAll('.structure-thirdnav-btn');
    assert.deepEqual(
      thirdNavBtns.map((btn) => btn.querySelector('.structure-thirdnav-label').textContent),
      ['挂载胶囊', '鼠标悬浮窗', '实时监控布局', '调用明细字段'],
      '3rd-level menu renders 4 structure sub-tabs'
    );
    assert.equal(thirdNavBtns[0].classList.contains('is-active'), true, 'First 3rd-level tab active by default');

    const accordionSections = structurePane.querySelectorAll('.collapsible-section');
    assert.equal(accordionSections.length, 4, 'Structure tab has 4 static pane sections');
    assert.equal(accordionSections[0].hasAttribute('hidden'), false, 'Pane 0 visible by default');
    assert.equal(accordionSections[1].hasAttribute('hidden'), true, 'Pane 1 hidden until selected');
    assert.equal(accordionSections[2].hasAttribute('hidden'), true, 'Pane 2 hidden until selected');
    assert.equal(accordionSections[3].hasAttribute('hidden'), true, 'Pane 3 hidden until selected');

    const sec0 = accordionSections[0];
    assert.equal(sec0.querySelector('.structure-preview-stage'), null, 'No outer preview wrapper box');
    assert.equal(sec0.querySelector('.structure-preview-head'), null, 'No redundant mock data label header');
    const previewCapsuleBar = sec0.querySelector('.preview-capsule-bar');
    const previewCapsuleSlots = sec0.querySelectorAll('.wm-cap-slot');
    const previewMultiBtn = sec0.querySelector('.wm-multi-btn');
    assert.ok(previewCapsuleBar, 'Pane 0 mounts real CapsuleBarWidget preview');
    assert.equal(previewCapsuleBar.querySelector('.preview-win-controls'), null, 'No redundant 3 window dots after capsule');
    assert.equal(previewCapsuleSlots.length, 6, 'Preview CapsuleBarWidget mounts real 6 capsule slots');
    assert.equal(previewCapsuleSlots[0].children[0].textContent, '68.4 t/s', 'Preview slot 0 renders simulated speed');
    assert.equal(previewCapsuleSlots[0].classList.contains('tone-good'), true, 'Preview capsule 68.4 t/s shares tone-good green with cards');
    assert.equal(previewCapsuleSlots[1].children[0].textContent, '1.1s', 'Preview slot 1 renders simulated TTFT');
    assert.equal(previewCapsuleSlots[2].querySelector('.wm-ctx-pct').textContent, '56%', 'Preview slot 2 renders simulated context %');
    const mountSelectEl = sec0.querySelectorAll('.custom-select')[0];

    // Toggle windowMountSelect: dual -> composer -> sidebar -> dual (updating both live host & preview bar)
    assert.ok(mountSelectEl.querySelector('.select-label').textContent.includes('顶部栏 + 侧边栏'));
    mountSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    mountSelectEl.querySelectorAll('.select-option')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.windowMountMode, 'composer', 'windowMountMode persisted as composer');
    assert.equal(mockSettings.enableWindowOverlay, true, 'enableWindowOverlay stays true in composer mode');
    assert.ok(mountSelectEl.querySelector('.select-label').textContent.includes('输入框挂载'), 'UI reflects composer mode');
    assert.equal(previewCapsuleBar.getAttribute('data-mount-mode'), 'composer', 'Preview bar switches to composer mode');
    assert.equal(previewCapsuleBar.classList.contains('is-composer'), true);

    mountSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    mountSelectEl.querySelectorAll('.select-option')[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.windowMountMode, 'sidebar', 'windowMountMode persisted as sidebar');
    assert.equal(mockSettings.enableWindowOverlay, false, 'enableWindowOverlay persisted as false');
    assert.ok(mountSelectEl.querySelector('.select-label').textContent.includes('仅侧边栏'), 'UI reflects sidebar mode');
    assert.equal(previewCapsuleBar.classList.contains('is-sidebar-only'), true);
    assert.equal(sec0.querySelector('.preview-sidebar-note').hasAttribute('hidden'), false, 'Sidebar-only preview hint shown');

    // Re-open popover after sidebar closed it and switch back to dual
    ov.open();
    mountSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    mountSelectEl.querySelectorAll('.select-option')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.windowMountMode, 'dual', 'windowMountMode persisted back to dual');
    assert.equal(mockSettings.enableWindowOverlay, true, 'enableWindowOverlay persisted back to true');
    assert.equal(previewCapsuleBar.getAttribute('data-mount-mode'), 'dual');

    // Toggle popover width mode (auto -> custom 640px -> step +10px -> auto), topbar multi-session switch (show -> hide -> show), and CLI bottom capsule switch (on -> off -> on)
    const topbarSegBtns = sec0.querySelectorAll('.seg-btn');
    assert.equal(topbarSegBtns.length, 6, 'Popover width + Topbar multi-session + CLI bottom capsule toggles render 6 buttons');
    const popWidthInput = sec0.querySelector('.num-field');
    const popWidthStepBtns = sec0.querySelectorAll('.num-step-btn');
    assert.ok(popWidthInput, 'CustomNumberInput field exists without native <input type="number">');
    assert.equal(popWidthStepBtns.length, 2, 'CustomNumberInput renders - / + step buttons');
    topbarSegBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.popoverWidthMode, 'custom', 'Popover width mode switches to custom');
    popWidthInput.value = '640';
    popWidthInput.dispatchEvent({ type: 'change', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.popoverWidth, 640, 'Custom popover width persisted');
    assert.equal(popoverEl.style.width, '640px', 'Popover width immediately reflects custom 640px');
    popWidthStepBtns[1].dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.popoverWidth, 650, 'Stepper + button increments custom width by 10px');
    assert.equal(popoverEl.style.width, '650px', 'Popover width immediately reflects stepped 650px');
    topbarSegBtns[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.popoverWidthMode, 'auto', 'Popover width mode restored to auto');

    topbarSegBtns[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.showTopbarMultiSession, false);
    assert.equal(multiBtn.hasAttribute('hidden'), true, 'Topbar multi-session button hidden immediately');
    assert.equal(previewMultiBtn.hasAttribute('hidden'), true, 'Preview multi-session button hidden immediately');
    assert.equal(capsuleHost.getAttribute('data-multi'), 'off');
    topbarSegBtns[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.showTopbarMultiSession, true);
    assert.equal(multiBtn.hasAttribute('hidden'), false, 'Topbar multi-session button restored immediately');
    assert.equal(previewMultiBtn.hasAttribute('hidden'), false, 'Preview multi-session button restored immediately');

    topbarSegBtns[5].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.enableCliStatusLine, false, 'CLI bottom capsule toggle turns off enableCliStatusLine');
    topbarSegBtns[4].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.enableCliStatusLine, true, 'CLI bottom capsule toggle restores enableCliStatusLine');

    // Dynamic 1..6 capsule slots via EditableSlotList (+ / - / ↑ / ↓ & mouse drag-and-drop)
    const capSlots = capsuleHost.shadowRoot.querySelectorAll('.wm-cap-slot');
    const capSeps = capsuleHost.shadowRoot.querySelectorAll('.wm-sep');
    assert.equal(capSlots.length, 6, '6 capsule slot nodes pre-reserved');
    assert.equal(capSeps.length, 5, '5 capsule separators pre-reserved');
    assert.equal(capSlots[3].hasAttribute('hidden'), true, 'Slot 4 hidden by default (3 slots)');
    assert.equal(capSlots[4].hasAttribute('hidden'), true, 'Slot 5 hidden by default (3 slots)');
    assert.equal(capSlots[5].hasAttribute('hidden'), true, 'Slot 6 hidden by default (3 slots)');

    const capSlotWrap = sec0.querySelector('.editable-slot-wrap');
    let capRowSelects = capSlotWrap.querySelectorAll('.custom-select');
    assert.equal(capRowSelects.length, 3, 'Default 3 capsule slot rows in EditableSlotList');

    // Slot 0 ('tps') -> Gemini 5h (index 9), Slot 1 stays TTFT, Slot 2 ('context') -> Cost (index 4)
    capRowSelects[0].querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    capRowSelects[0].querySelectorAll('.select-option')[9].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(capSlots[0].getAttribute('data-metric'), 'gemini_5h');
    assert.equal(capSlots[0].querySelector('.wm-slot-tag').textContent, 'G5h');
    assert.ok(capSlots[0].querySelector('.wm-ring-svg'), 'Tagged quota slot mounts circular ring');
    assert.equal(capSlots[0].querySelector('.wm-quota-pct').textContent, '44%');
    assert.ok(
      capSlots[0].querySelector('.wm-ring-fill').style.getPropertyValue('--ring-color'),
      'Quota ring receives synced Scheme B remaining gradient color'
    );
    assert.equal(previewCapsuleSlots[0].getAttribute('data-metric'), 'gemini_5h', 'Preview slot 0 mirrors gemini_5h');
    assert.equal(previewCapsuleSlots[0].querySelector('.wm-slot-tag').textContent, 'G5h', 'Preview slot 0 renders G5h tag');
    assert.equal(previewCapsuleSlots[0].querySelector('.wm-quota-pct').textContent, '64%', 'Preview slot 0 renders simulated gemini_5h');
    assert.equal(capSlots[1].getAttribute('data-metric'), 'ttft');
    assert.equal(capSlots[1].children[0].textContent, '0.85s');

    capRowSelects[2].querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    capRowSelects[2].querySelectorAll('.select-option')[4].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(capSlots[2].getAttribute('data-metric'), 'cost');
    assert.equal(capSlots[2].children.length, 1, 'Ring SVG detached cleanly when slot leaves context');
    assert.equal(capSlots[2].children[0].textContent, '$0.040');
    assert.deepEqual(mockSettings.topbarCapsuleSlots, ['gemini_5h', 'ttft', 'cost']);

    // Move Row 1 up (left): each row has [up, down, remove], so Row 1 up is index 3
    capSlotWrap.querySelectorAll('.slot-move-btn')[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(mockSettings.topbarCapsuleSlots, ['ttft', 'gemini_5h', 'cost']);
    assert.equal(capSlots[0].children.length, 1, 'Tag & ring detached cleanly when slot leaves quota');
    assert.equal(capSlots[0].children[0].textContent, '0.85s');
    assert.equal(capSlots[1].querySelector('.wm-slot-tag').textContent, 'G5h');
    assert.equal(capSlots[1].querySelector('.wm-quota-pct').textContent, '44%');

    // Mouse drag-and-drop reorder: drag Row 0 ('ttft') down below Row 2 ('cost') -> ['gemini_5h', 'cost', 'ttft']
    const capSlotListEl = capSlotWrap.querySelector('.editable-slot-list');
    for (const rowEl of capSlotListEl.children) {
      rowEl.getBoundingClientRect = () => {
        const curIdx = capSlotListEl.children.indexOf(rowEl);
        return { left: 0, right: 280, top: curIdx * 30, bottom: curIdx * 30 + 28, width: 280, height: 28 };
      };
    }
    const firstDragHandle = capSlotListEl.children[0].querySelector('.slot-drag-handle');
    assert.ok(firstDragHandle, 'Drag handle rendered on EditableSlotList row');
    firstDragHandle.dispatchEvent({ type: 'pointerdown', button: 0, clientY: 14, preventDefault() {}, stopPropagation() {} });
    mockDocument.dispatchEvent({ type: 'pointermove', clientY: 78, preventDefault() {} });
    assert.equal(capSlotListEl.classList.contains('is-dragging-list'), true, 'List enters dragging state on pointermove');
    assert.deepEqual(
      mockSettings.topbarCapsuleSlots,
      ['ttft', 'gemini_5h', 'cost'],
      'Settings API not spammed mid-drag before pointerup'
    );
    assert.equal(
      previewCapsuleSlots[0].getAttribute('data-metric'),
      'gemini_5h',
      'Real CapsuleBarWidget preview updates live during mouse drag'
    );
    assert.equal(
      previewCapsuleSlots[2].getAttribute('data-metric'),
      'ttft',
      'Dragged metric moved to slot 2 in live preview'
    );
    mockDocument.dispatchEvent({ type: 'pointerup', clientY: 78 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(capSlotListEl.classList.contains('is-dragging-list'), false, 'Dragging state cleared on pointerup');
    assert.deepEqual(
      mockSettings.topbarCapsuleSlots,
      ['gemini_5h', 'cost', 'ttft'],
      'Mouse drag order persisted once on pointerup'
    );
    assert.equal(capSlots[0].getAttribute('data-metric'), 'gemini_5h');
    assert.equal(capSlots[1].getAttribute('data-metric'), 'cost');
    assert.equal(capSlots[2].getAttribute('data-metric'), 'ttft');

    // Click `+ 添加指标` three times to expand from 3 -> 6 slots
    const capAddBtn = capSlotWrap.querySelector('.slot-add-btn');
    capAddBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    capAddBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    capAddBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.topbarCapsuleSlots.length, 6, 'Expanded to maximum 6 capsule slots');
    assert.equal(capAddBtn.hasAttribute('disabled'), true, '+ button disabled at max 6 slots');
    assert.equal(capSlots[3].hasAttribute('hidden'), false, 'Slot 4 now visible');
    assert.equal(capSlots[4].hasAttribute('hidden'), false, 'Slot 5 now visible');
    assert.equal(capSlots[5].hasAttribute('hidden'), false, 'Slot 6 now visible');
    assert.equal(capSeps[3].hasAttribute('hidden'), false, 'Separator 4 now visible');
    assert.equal(capSeps[4].hasAttribute('hidden'), false, 'Separator 5 now visible');

    // Remove down to 1 slot using `-` button, verifying min=1 protection
    for (let r = 0; r < 5; r += 1) {
      const remBtns = capSlotWrap.querySelectorAll('.slot-remove-btn');
      remBtns[remBtns.length - 1].dispatchEvent({ type: 'click', stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(mockSettings.topbarCapsuleSlots.length, 1, 'Shrunk to minimum 1 capsule slot');
    assert.equal(capSlotWrap.querySelector('.slot-remove-btn').hasAttribute('disabled'), true, '- button disabled at min 1 slot');
    assert.equal(capSeps[0].hasAttribute('hidden'), true, 'All separators hidden when 1 slot');

    // Reset Section 0 restores default 3 slots ['tps', 'ttft', 'context']
    sec0.querySelector('.btn-ghost-sm').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(mockSettings.topbarCapsuleSlots, ['tps', 'ttft', 'context']);
    assert.equal(capSlots[0].getAttribute('data-metric'), 'tps');
    assert.equal(capSlots[1].getAttribute('data-metric'), 'ttft');
    assert.equal(capSlots[2].getAttribute('data-metric'), 'context');
    assert.equal(capSlots[2].children.length, 2, 'Ring SVG re-attached on Slot 2');
    assert.equal(capSlots[2].querySelector('.wm-ctx-pct').textContent, '50%');

    // Pane 1 (3rd-level tab 'hover'): Hover Popup Modules (0..4) + real hover UI preview
    const sec1 = accordionSections[1];
    thirdNavBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(thirdNavBtns[1].classList.contains('is-active'), true, 'Hover 3rd-level tab active');
    assert.equal(sec0.hasAttribute('hidden'), true, 'Mount pane hidden');
    assert.equal(sec1.hasAttribute('hidden'), false, 'Hover pane visible');
    const hoverPreviewTip = sec1.querySelector('.wm-hover-tip');
    const hoverPreviewWidgets = hoverPreviewTip.querySelector('.wm-hover-widgets');
    assert.equal(hoverPreviewTip.classList.contains('is-preview'), true, 'Real .wm-hover-tip mounted inline in preview');
    assert.equal(hoverPreviewWidgets.children.length, 3, 'Default 3 real hover widgets mounted in preview');

    const hoverSlotWrap = sec1.querySelector('.editable-slot-wrap');
    for (let r = 0; r < 3; r += 1) {
      const remBtns = hoverSlotWrap.querySelectorAll('.slot-remove-btn');
      remBtns[0].dispatchEvent({ type: 'click', stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(mockSettings.hoverModules, [], 'Hover modules emptied to 0 items');
    assert.equal(hoverSlotWrap.querySelector('.editable-slot-empty').hasAttribute('hidden'), false, '0-module empty hint visible');
    assert.equal(hoverPreviewTip.hasAttribute('hidden'), true, 'Hover preview tip hidden when 0 modules');
    assert.equal(sec1.querySelector('.structure-preview-empty').hasAttribute('hidden'), false, 'Empty preview state shown');
    // Temporarily set pluginUpdateMode=off via Settings UI so update banner is also absent, then close popover and hover capsuleBtn
    updateModeSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    updateModeSelectEl.querySelectorAll('.select-option')[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    ov.close();
    capsuleBtn.dispatchEvent({ type: 'mouseenter', clientX: 960, clientY: 18 });
    assert.equal(ov.isHoverOpen(), false, 'Hover popup stays suppressed when hoverModules=[] and no update banner');
    // Click popover still opens cleanly!
    capsuleBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(ov.isOpen(), true, 'Click full monitor popover still opens when hoverModules=[]');
    updateModeSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    updateModeSelectEl.querySelectorAll('.select-option')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    sec1.querySelector('.btn-ghost-sm').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(mockSettings.hoverModules, ['metrics', 'context', 'quotas']);
    assert.equal(hoverPreviewTip.hasAttribute('hidden'), false, 'Hover preview tip restored');
    assert.equal(hoverPreviewWidgets.children.length, 3, '3 real hover widgets restored in preview');

    // Pane 2 (3rd-level tab 'overview'): Live Overview Layout + real overview UI preview
    const sec2 = accordionSections[2];
    thirdNavBtns[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(thirdNavBtns[2].classList.contains('is-active'), true, 'Overview 3rd-level tab active');
    assert.equal(sec1.hasAttribute('hidden'), true);
    assert.equal(sec2.hasAttribute('hidden'), false);
    const overviewPreviewHostEl = sec2.querySelector('.overview-modules-host');
    assert.equal(overviewPreviewHostEl.children.length, 4, 'Overview preview mounts all 4 real overview widgets');
    assert.equal(
      sec2.querySelector('.structure-preview-canvas').classList.contains('is-scaled'),
      false,
      'Overview preview canvas renders 1:1 without zoom scaling'
    );
    const previewCellSubs = Array.from(overviewPreviewHostEl.children[0].querySelectorAll('.cell-sub')).map(
      (el) => el.textContent
    );
    assert.ok(previewCellSubs.includes('均值 1.4s'), 'Preview TTFT card shows populated mean TTFT');
    assert.ok(previewCellSubs.includes('有效 23/24 步'), 'Preview Avg TPS card shows populated valid sample ratio');
    assert.equal(
      overviewPreviewHostEl.children[2].querySelector('.panel-meta').textContent,
      'Google AI Ultra · Pro',
      'Preview quota badge matches real tier · plan format'
    );

    const [ovModWrap, ovMetricWrap] = sec2.querySelectorAll('.editable-slot-wrap');
    // Move row 2 ('quotas') up above 'context' -> ['metrics', 'quotas', 'context', 'live_tasks']
    ovModWrap.querySelectorAll('.slot-move-btn')[6].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(mockSettings.overviewModules, ['metrics', 'quotas', 'context', 'live_tasks']);
    // Remove 2 metrics from first-row matrix -> 2 columns ['tps', 'ttft']
    ovMetricWrap.querySelectorAll('.slot-remove-btn')[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    ovMetricWrap.querySelectorAll('.slot-remove-btn')[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(mockSettings.overviewMetrics, ['tps', 'ttft']);
    assert.equal(overviewPreviewHostEl.children[0].getAttribute('data-cols'), '2', 'Preview MetricMatrixWidget adapts to 2 columns');
    assert.ok(
      overviewPreviewHostEl.children[1].querySelector('.panel-title').children[1].textContent.includes('可用额度'),
      'Preview QuotaPoolsWidget moved above ContextWindowWidget'
    );
    pillTabs[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    const overviewHostEl = allPanes[0].querySelector('.overview-modules-host');
    assert.equal(overviewHostEl.children[0].getAttribute('data-cols'), '2', 'MetricMatrixWidget adapts to 2 columns');
    assert.ok(
      overviewHostEl.children[1].querySelector('.panel-title').children[1].textContent.includes('可用额度'),
      'QuotaPoolsWidget moved above ContextWindowWidget in LiveOverviewView'
    );
    pillTabs[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    sec2.querySelector('.btn-ghost-sm').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(mockSettings.overviewModules, ['metrics', 'context', 'quotas', 'live_tasks']);
    assert.deepEqual(mockSettings.overviewMetrics, ['tps', 'ttft', 'avg_tps', 'step_cost']);

    // Pane 3 (3rd-level tab 'steps'): Step Table Columns (2..12) + real StepTableWidget preview
    const sec3 = accordionSections[3];
    thirdNavBtns[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(thirdNavBtns[3].classList.contains('is-active'), true, 'Steps 3rd-level tab active');
    assert.equal(sec2.hasAttribute('hidden'), true);
    assert.equal(sec3.hasAttribute('hidden'), false);
    const previewStepTable = sec3.querySelector('.steps-data-table');
    assert.ok(previewStepTable, 'Real StepTableWidget mounted in Steps structure preview');
    assert.equal(previewStepTable.classList.contains('has-turn-rail'), false, 'Preview step table hides turn rail by default');
    assert.equal(previewStepTable.children[0].children[0].children.length, 7, 'Preview step table renders 7 default columns');
    assert.equal(previewStepTable.children[1].children.length, 4, 'Preview step table renders 4 simulated steps');

    const sec3SettingLabels = sec3.querySelectorAll('.form-label').map((el) => el.textContent);
    assert.ok(sec3SettingLabels.includes('对话轮次导轨'), 'Turn rail switch rendered in 调用明细字段');
    assert.ok(sec3SettingLabels.includes('主/子代理标识'), 'Main/Sub agent badge switch rendered in 调用明细字段');
    assert.ok(sec3SettingLabels.includes('输出速度多色分级'), 'Speed multi-color switch rendered in 调用明细字段');
    const sec3SegControls = sec3.querySelectorAll('.segmented');
    assert.equal(sec3SegControls.length, 3, 'Three independent switches rendered in 调用明细字段');
    const getRowSpeedClasses = (tableEl) =>
      Array.from(tableEl.children[1].children).map(
        (tr) => tr.children[2].querySelector('.cell-value')?.getAttribute('class') || ''
      );
    assert.equal(
      getRowSpeedClasses(previewStepTable).every((cls) => cls === 'cell-value'),
      true,
      'Preview step table renders monochrome speed cells by default'
    );
    // Toggle ON 对话轮次导轨 & 输出速度多色分级, and toggle OFF 主/子代理标识
    sec3SegControls[0].querySelectorAll('.seg-btn')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(mockSettings.showStepTurnRail, true, 'Turn rail switch updates showStepTurnRail to true');
    assert.equal(previewStepTable.classList.contains('has-turn-rail'), true, 'Preview step table activates turn rail immediately');
    const previewFirstTd = previewStepTable.children[1].children[0].children[0];
    previewFirstTd.onmouseenter?.({ target: previewFirstTd });
    const previewTurnTip = sec3.querySelector('.turn-prompt-tip');
    assert.equal(previewTurnTip.hasAttribute('hidden'), false, 'Hovering first cell in preview reveals turn prompt tooltip');
    assert.ok(previewTurnTip.textContent.includes('并发刷新令牌'), 'Preview turn tooltip displays realistic engineering prompt');
    previewFirstTd.onmouseleave?.();

    sec3SegControls[1].querySelectorAll('.seg-btn')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(mockSettings.showStepAgentBadge, false, 'Agent badge switch updates showStepAgentBadge to false');
    assert.equal(
      previewStepTable.querySelector('.agent-badge').hasAttribute('hidden'),
      true,
      'Preview step table hides Main/Sub agent badge immediately'
    );
    sec3SegControls[2].querySelectorAll('.seg-btn')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(mockSettings.showStepSpeedColor, true, 'Speed multi-color switch updates showStepSpeedColor to true');
    assert.equal(
      getRowSpeedClasses(previewStepTable).some((cls) => /tone-(good|info|warn|danger)/.test(cls)),
      true,
      'Preview step table enables multi-color speed tones immediately when showStepSpeedColor is true'
    );

    const stepColWrap = sec3.querySelector('.editable-slot-wrap');
    stepColWrap.querySelector('.slot-add-btn').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    stepColWrap.querySelector('.slot-add-btn').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(mockSettings.stepTableColumns.length, 9, 'Added time and duration columns (7 -> 9)');
    assert.equal(previewStepTable.children[0].children[0].children.length, 9, 'Preview step table expands to 9 columns live');
    pillTabs[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    const stepTableWhileCustomOn = allPanes[2].querySelector('.data-table');
    assert.equal(
      stepTableWhileCustomOn.classList.contains('has-turn-rail'),
      true,
      'has-turn-rail class applied when showStepTurnRail is true'
    );
    assert.equal(
      Array.from(stepTableWhileCustomOn.children[1].children).some((tr) =>
        /tone-(good|info|warn|danger)/.test(
          tr.children[2].querySelector('.cell-value')?.getAttribute('class') || ''
        )
      ),
      true,
      'StepsDetailView applies multi-color speed classes when showStepSpeedColor is true'
    );
    const stepHeaderThs = stepTableWhileCustomOn.children[0].children[0].children;
    assert.equal(stepHeaderThs.length, 9, 'StepsDetailView thead dynamically renders 9 columns');
    pillTabs[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    sec3.querySelector('.btn-ghost-sm').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mockSettings.stepTableColumns.length, 7);
    assert.equal(mockSettings.showStepTurnRail, false, 'Section reset restores showStepTurnRail to false');
    assert.equal(mockSettings.showStepAgentBadge, true, 'Section reset restores showStepAgentBadge to true');
    assert.equal(mockSettings.showStepSpeedColor, false, 'Section reset restores showStepSpeedColor to false');
    assert.equal(previewStepTable.classList.contains('has-turn-rail'), false, 'Section reset hides turn rail in preview step table');
    assert.equal(
      getRowSpeedClasses(previewStepTable).every((cls) => cls === 'cell-value'),
      true,
      'Section reset restores monochrome speed classes in preview step table'
    );

    // --- 其他 (model format, context limits, cache rebuild, reset) ---
    subNavBtns[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(otherPane.hasAttribute('hidden'), false);
    assert.equal(thirdNavBar.hasAttribute('hidden'), true, '3rd-level menu hidden when switching to Other tab');
    const otherSelects = otherPane.querySelectorAll('.custom-select');
    assert.equal(otherSelects.length, 4);
    const modelFormatSelectEl = otherSelects[0];
    const orchestratorIdSelectEl = otherSelects[1];

    // Toggle stepModelSelect: short -> upstream -> upstream_compact -> short
    assert.ok(modelFormatSelectEl.querySelector('.select-label').textContent.includes('精简代号'));
    modelFormatSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    modelFormatSelectEl.querySelectorAll('.select-option')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.modelDisplayMode, 'upstream');
    assert.equal(mockSettings.showUpstreamModel, true);
    assert.ok(modelFormatSelectEl.querySelector('.select-label').textContent.includes('原始模型 ID'));
    modelFormatSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    modelFormatSelectEl.querySelectorAll('.select-option')[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.modelDisplayMode, 'upstream_compact');
    assert.equal(mockSettings.showUpstreamModel, true);
    assert.ok(modelFormatSelectEl.querySelector('.select-label').textContent.includes('去前缀原始 ID'));
    modelFormatSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    modelFormatSelectEl.querySelectorAll('.select-option')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.modelDisplayMode, 'short');
    assert.equal(mockSettings.showUpstreamModel, false);

    // Toggle orchestratorIdSelect: compact -> full
    assert.ok(orchestratorIdSelectEl.querySelector('.select-label').textContent.includes('精简代号'));
    orchestratorIdSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    orchestratorIdSelectEl.querySelectorAll('.select-option')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.orchestratorIdMode, 'full');
    assert.ok(orchestratorIdSelectEl.querySelector('.select-label').textContent.includes('原始完整 ID'));

    const [contextModel, contextWindow] = otherSelects.slice(2);
    const selectOption = (select, index) => {
      select.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
      select.querySelectorAll('.select-option')[index].dispatchEvent({ type: 'click', stopPropagation() {} });
    };
    const ctxRiskMask = otherPane.querySelector('.ctx-risk-mask');
    const ctxControlsBody = otherPane.querySelector('.ctx-controls-body');
    const ctxRiskAcceptBtn = otherPane.querySelector('.ctx-risk-accept-btn');
    assert.ok(ctxRiskMask && ctxControlsBody && ctxRiskAcceptBtn, 'Context window risk warning mask and accept button exist');
    assert.equal(ctxRiskMask.hasAttribute('hidden'), false, 'Risk mask visible before consent');
    assert.equal(ctxControlsBody.classList.contains('is-locked'), true, 'Context controls locked before consent');
    assert.equal(contextModel.querySelector('.select-trigger').hasAttribute('disabled'), true, 'Model select disabled before consent');
    selectOption(contextModel, 1);
    assert.equal(contextWindow.parentNode.hasAttribute('hidden'), true, 'Cannot select context model while locked');

    ctxRiskAcceptBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mockSettings.contextWindowRiskAccepted, true, 'Accepting risk persists contextWindowRiskAccepted');
    assert.equal(ctxRiskMask.hasAttribute('hidden'), true, 'Risk mask hidden after consent');
    assert.equal(ctxControlsBody.classList.contains('is-locked'), false, 'Context controls unlocked after consent');
    assert.equal(contextModel.querySelector('.select-trigger').hasAttribute('disabled'), false, 'Model select enabled after consent');

    assert.equal(contextWindow.parentNode.hasAttribute('hidden'), true);
    contextModel.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.match(contextModel.querySelectorAll('.select-option')[1].querySelector('.select-option-meta').textContent, /默认.*256,000/);
    contextModel.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    selectOption(contextModel, 1);
    selectOption(contextWindow, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(mockSettings.modelContextWindows, { 'model:gemini-4-argon': '512000' });
    contextModel.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.match(contextModel.querySelectorAll('.select-option')[1].querySelector('.select-option-meta').textContent, /512,000.*已设置/);
    contextModel.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    selectOption(contextModel, 2);
    assert.equal(contextWindow.querySelector('.select-label').textContent, '跟随宿主设置');
    selectOption(contextWindow, 1);
    await new Promise((r) => setTimeout(r, 30));
    selectOption(contextModel, 1);
    selectOption(contextWindow, 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(mockSettings.modelContextWindows, { 'model:gemini-3.8-flash': '256K' });
    selectOption(contextModel, 3);
    assert.equal(contextWindow.querySelector('.select-trigger').hasAttribute('disabled'), true);

    const maintBtns = otherPane
      .querySelectorAll('.btn-secondary')
      .filter((btn) => !btn.classList.contains('ctx-risk-accept-btn'));
    const rebuildBtn = maintBtns[0];
    const resetAllBtn = maintBtns[1];
    rebuildBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cacheRebuildCalls, 1, 'POST /api/cache/rebuild invoked cleanly');

    // Two-step confirm for Reset All Settings: 1st click arms confirm, 2nd click resets all settings
    resetAllBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(resetAllBtn.classList.contains('btn-danger-confirm'), true, '1st click arms confirmation state');
    assert.equal(mockSettings.orchestratorIdMode, 'full', 'Not yet reset on 1st click');
    resetAllBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(mockSettings.orchestratorIdMode, 'compact', '2nd click resets orchestratorIdMode to default');
    assert.equal(mockSettings.contextWindowRiskAccepted, false, 'Reset restores contextWindowRiskAccepted to false');
    assert.equal(ctxRiskMask.hasAttribute('hidden'), false, 'Risk mask re-locks after factory reset');

    // Verify ConsumptionView omits "+ 待定" / "3993 步费用待定" and StepsDetailView protects header title
    pillTabs[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    const heroCostEl = popoverEl.querySelector('.cons-hero-cost');
    assert.equal(heroCostEl.textContent, '$1.50', 'Consumption hero cost omits + 待定');
    const heroCostBaseline = heroCostEl.parentElement;
    assert.equal(
      heroCostBaseline.children[1].textContent,
      '≈ ¥11',
      'Consumption sub-label renders CNY approx instead of 步费用待定'
    );
    assert.ok(popoverEl.querySelector('.steps-panel-header'), 'Steps header flex wrapper present');
    assert.ok(popoverEl.querySelector('.steps-panel-title'), 'Steps title non-shrinking class present');

    // Verify <=90d renders flush edge-to-edge SVG line chart, while >90d ('all' = 120 days) switches to GitHub-style daily heatmap grid
    const plotStageEl = popoverEl.querySelector('.trend-plot-stage');
    const heatmapStageEl = popoverEl.querySelector('.trend-heatmap-stage');
    assert.equal(plotStageEl.hasAttribute('hidden'), false, 'Line chart visible for <=90 days');
    assert.equal(heatmapStageEl.hasAttribute('hidden'), true, 'Heatmap hidden for <=90 days');
    const consTrendTicks = popoverEl.querySelector('.trend-x-axis').querySelectorAll('.trend-x-tick');
    assert.equal(consTrendTicks[0].classList.contains('is-start'), true);
    assert.equal(consTrendTicks[0].style.getPropertyValue('--tick-x'), '0.00%', 'Consumption trend start tick flush left');
    assert.equal(consTrendTicks[consTrendTicks.length - 1].classList.contains('is-end'), true);
    assert.equal(
      consTrendTicks[consTrendTicks.length - 1].style.getPropertyValue('--tick-x'),
      '100.00%',
      'Consumption trend end tick flush right'
    );
    assert.equal(
      plotStageEl.querySelector('.trend-svg').getAttribute('viewBox'),
      '0 0 180 120',
      'TrendAreaChart dynamically adapts viewBox width to measured container width (180px in MockNode)'
    );
    assert.match(
      plotStageEl.querySelector('.trend-line').getAttribute('d') || '',
      /^M 1\.0 .* 179\.0 \d+\.\d$/,
      'Consumption trend curve spans flush edge-to-edge (1.0..179.0) across measured 180px viewBox'
    );
    assert.match(stylesCss, /\.app-shell\s*\{[^}]*max-width:\s*none;/, 'Sidecar .app-shell removes 560px width cap');
    assert.match(
      stylesCss,
      /\.models-analytics-pane\s*\{[^}]*padding:\s*var\(--space-3\)\s+0\s+2px;/,
      'Models analytics pane eliminates nested horizontal double-padding'
    );
    assert.doesNotMatch(
      stylesCss,
      /hsl\(145\s+78%\s+60%\)/,
      'Heatmap palette uses unified project blue tokens instead of hardcoded green'
    );

    // Click '全部' (option index 5 in ConsumptionView timeFilterSwitch) to load 120-day series
    const consPane = allPanes[1];
    const consTimeSegBtns = consPane.querySelectorAll('.seg-btn');
    consTimeSegBtns[5].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 35));

    assert.equal(plotStageEl.hasAttribute('hidden'), true, 'Line chart hidden when trend exceeds 90 days');
    assert.equal(heatmapStageEl.hasAttribute('hidden'), false, 'GitHub heatmap shown when trend exceeds 90 days');
    const hmGridEl = heatmapStageEl.querySelector('.trend-hm-grid');
    const realDayCells = hmGridEl.children.filter((c) => !c.classList.contains('is-pad'));
    assert.equal(realDayCells.length, 120, 'Renders exactly 1 cell per day for 120-day span');
    assert.ok(
      realDayCells.some((c) => c.classList.contains('lv-0')) &&
        realDayCells.some((c) => c.classList.contains('lv-4')),
      'Assigns empty lv-0 and peak lv-4 intensity classes across daily squares'
    );
    assert.match(
      heatmapStageEl.querySelector('.trend-hm-summary').textContent,
      /^活跃 40\/120 天 · 峰值 /
    );

    // Hovering a heatmap day square populates shared tooltip and docks away from hovered row
    const activeCell = realDayCells[0];
    hmGridEl.dispatchEvent({ type: 'mouseover', target: activeCell });
    const trendTooltipEl = popoverEl.querySelector('.trend-tooltip');
    assert.equal(trendTooltipEl.hasAttribute('hidden'), false, 'Tooltip opens on heatmap cell hover');
    assert.equal(activeCell.classList.contains('is-hovered'), true);
    assert.match(trendTooltipEl.querySelector('.trend-tip-tokens').textContent, /100\.0k tok/);

    // Crossing 2px inter-cell gaps keeps highlight/tooltip steady without flickering, and fast jumps snap to nearest cell
    const hmBodyEl = heatmapStageEl.querySelector('.trend-heatmap-body');
    const hmTotalWeeks = Number(hmBodyEl.style.getPropertyValue('--hm-weeks'));
    const origGridRectFn = hmGridEl.getBoundingClientRect;
    hmGridEl.getBoundingClientRect = () => ({
      left: 100,
      top: 200,
      width: hmTotalWeeks * 10 - 2,
      height: 7 * 10 - 2,
      right: 100 + hmTotalWeeks * 10 - 2,
      bottom: 200 + 7 * 10 - 2,
    });
    const activeCol = Number(activeCell.getAttribute('data-hm-col'));
    const activeRow = Number(activeCell.getAttribute('data-hm-row'));
    hmGridEl.dispatchEvent({ type: 'mouseover', target: hmGridEl });
    assert.equal(trendTooltipEl.hasAttribute('hidden'), false, 'Container mouseover in gap does not blink tooltip');
    hmGridEl.dispatchEvent({
      type: 'mousemove',
      target: hmGridEl,
      clientX: 100 + activeCol * 10 + 9,
      clientY: 200 + activeRow * 10 + 4,
    });
    assert.equal(trendTooltipEl.hasAttribute('hidden'), false, 'Tooltip stays visible in 2px gap beside active cell');
    assert.equal(activeCell.classList.contains('is-hovered'), true, 'Active cell stays highlighted across bordering gap');

    const snappedCol5Cell = realDayCells.find(
      (c) => c.getAttribute('data-hm-col') === '5' && c.getAttribute('data-hm-row') === '2'
    );
    assert.ok(snappedCol5Cell, 'Target cell at col=5,row=2 exists');
    hmGridEl.dispatchEvent({
      type: 'mousemove',
      target: hmGridEl,
      clientX: 100 + 5 * 10 + 8.4,
      clientY: 200 + 2 * 10 + 4,
    });
    assert.equal(trendTooltipEl.hasAttribute('hidden'), false, 'Tooltip stays visible when snapping across distant gap');
    assert.equal(activeCell.classList.contains('is-hovered'), false);
    assert.equal(snappedCol5Cell.classList.contains('is-hovered'), true, 'Fast pointer jump into distant gap snaps to nearest cell');
    hmGridEl.getBoundingClientRect = origGridRectFn;

    hmGridEl.dispatchEvent({ type: 'mouseleave' });
    assert.equal(trendTooltipEl.hasAttribute('hidden'), true, 'Tooltip hides on mouseleave');

    // Verify StepsDetailView renders '上下文 / 思考 / 正文' column header and split values
    pillTabs[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    const stepsPane = allPanes[2];
    const stepHeaders = stepsPane.querySelectorAll('.data-table')[0].children[0].children[0].children;
    assert.equal(stepHeaders[4].textContent, '上下文 / 思考 / 正文');
    const stepRows = stepsPane.querySelectorAll('.data-table')[0].children[1].children;
    assert.equal(stepRows.length, 2);
    assert.equal(stepRows[0].children[4].children[0].textContent, '37.8k / 420 / 265');
    assert.equal(stepRows[0].children[4].getAttribute('title'), '上下文 37800 · 思考 420 · 正文 265');
    assert.equal(stepRows[1].children[4].children[0].textContent, '117.7k / 14.5k / 57');

    // Verify minimalist Turn Rail (.has-turn-rail, cap & origin dots) is off by default and activates cleanly when enabled
    const stepsDataTable = stepsPane.querySelectorAll('.data-table')[0];
    assert.equal(stepsDataTable.classList.contains('has-turn-rail'), false, 'Turn rail off by default after full reset');
    assert.equal(
      Array.from(stepRows).every(
        (tr) => tr.children[2].querySelector('.cell-value')?.getAttribute('class') === 'cell-value'
      ),
      true,
      'Speed column monochrome by default after full reset'
    );
    pillTabs[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    subNavBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    thirdNavBtns[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    sec3SegControls[0].querySelectorAll('.seg-btn')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    pillTabs[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stepsDataTable.classList.contains('has-turn-rail'), true, 'Turn rail active when showStepTurnRail=true');
    const row0Rail = stepRows[0].children[0].querySelector('.turn-rail');
    const row1Rail = stepRows[1].children[0].querySelector('.turn-rail');
    assert.equal(row0Rail.hasAttribute('hidden'), false);
    assert.equal(row0Rail.classList.contains('is-latest'), true);
    assert.equal(row0Rail.classList.contains('is-cap'), true, 'Newest step in turn renders cap dot');
    assert.equal(row1Rail.classList.contains('is-origin'), true, 'First step of user turn renders hollow origin dot');

    const turnPromptTipEl = stepsPane.querySelector('.turn-prompt-tip');
    assert.equal(turnPromptTipEl.hasAttribute('hidden'), true, 'Prompt preview tooltip hidden initially');
    stepRows[0].children[0].onmouseenter({ target: stepRows[0].children[0] });
    assert.equal(turnPromptTipEl.hasAttribute('hidden'), false, 'Hovering first cell opens turn prompt preview');
    assert.equal(turnPromptTipEl.textContent, '请优化调用明细与轮次导轨');
    stepRows[0].children[0].onmouseleave();
    assert.equal(turnPromptTipEl.hasAttribute('hidden'), true, 'Leaving cell hides turn prompt preview');

    // Verify '按步查看' multi-select model filter (visible when >1 model) & '总汇总' sub-tab rename
    const stepsHeaderSegBtns = stepsPane.querySelector('.steps-header-controls').querySelectorAll('.seg-btn');
    assert.equal(stepsHeaderSegBtns[0].textContent, '按步查看 (2)');
    assert.equal(stepsHeaderSegBtns[1].textContent, '总汇总', 'Second sub-tab renamed cleanly to 总汇总');

    const stepsModelSelectEl = stepsPane.querySelector('.steps-inline-model-select');
    assert.ok(stepsModelSelectEl, 'Inline model multi-select mounted in 按步查看 header');
    assert.equal(
      stepsModelSelectEl.hasAttribute('hidden'),
      false,
      'Steps model dropdown visible when >1 model exists in 按步查看'
    );
    assert.equal(stepsModelSelectEl.classList.contains('is-multi'), true);
    stepsModelSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    const hydroStepOpt = stepsModelSelectEl
      .querySelectorAll('.select-option')
      .find((o) => o.getAttribute('data-value') === 'Gemini 4 Hydrogen');
    assert.ok(hydroStepOpt, 'Gemini 4 Hydrogen option present in 按步查看 model filter');
    hydroStepOpt.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(
      stepsPane.querySelectorAll('.data-table')[0].children[1].children.length,
      1,
      'Filtering 按步查看 by Gemini 4 Hydrogen narrows table to 1 matching row'
    );
    assert.equal(stepsHeaderSegBtns[0].textContent, '按步查看 (1/2)');
    // Reset 按步查看 model filter back to 全部模型
    stepsModelSelectEl
      .querySelectorAll('.select-option')
      .find((o) => o.getAttribute('data-value') === '__all__')
      .dispatchEvent({ type: 'click', stopPropagation() {} });
    stepsModelSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(stepsPane.querySelectorAll('.data-table')[0].children[1].children.length, 2);

    // Switch to '总汇总' sub-tab and verify top SessionLineChart + ModelFitChart + minimalist model cards
    stepsHeaderSegBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      stepsModelSelectEl.hasAttribute('hidden'),
      true,
      'Header model dropdown for 按步查看 hides when switching to 总汇总'
    );

    const modelsAnalyticsPane = stepsPane.querySelector('.models-analytics-pane');
    assert.ok(modelsAnalyticsPane, 'Models analytics pane rendered');
    assert.equal(
      modelsAnalyticsPane.querySelectorAll('.data-table').length,
      0,
      'Old 5-column model table replaced by minimalist model cards'
    );

    const lineCard = modelsAnalyticsPane.querySelector('.sstep-line-card');
    const fitCard = modelsAnalyticsPane.querySelector('.sstep-fit-card');
    assert.ok(lineCard && fitCard, 'Both top session line chart and top model fit chart mounted');

    const lineModelSelectEl = lineCard.querySelector('.sstep-line-model-select');
    assert.ok(lineModelSelectEl, 'SessionLineChart has its own multi-select model dropdown');
    assert.equal(
      lineModelSelectEl.hasAttribute('hidden'),
      false,
      'SessionLineChart model dropdown visible when >1 model exists'
    );
    assert.equal(lineModelSelectEl.classList.contains('is-multi'), true);
    assert.equal(lineModelSelectEl.querySelector('.select-label').textContent, '全部模型');

    // Verify SessionLineChart 5 metrics ('总Token', '上下文', 'TPS', '首字', '费用')
    const lineSegBtns = lineCard.querySelectorAll('.seg-btn');
    assert.deepEqual(
      lineSegBtns.map((b) => b.textContent),
      ['总Token', '上下文', 'TPS', '首字', '费用']
    );
    assert.match(lineCard.querySelector('.cons-badge').textContent, /^累计 155\.5k$/);
    lineSegBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} }); // 上下文
    assert.match(lineCard.querySelector('.cons-badge').textContent, /^当前 37\.8k$/);
    lineSegBtns[2].dispatchEvent({ type: 'click', stopPropagation() {} }); // TPS
    assert.match(lineCard.querySelector('.cons-badge').textContent, /^均值 72\.3 tok\/s$/);
    lineSegBtns[3].dispatchEvent({ type: 'click', stopPropagation() {} }); // 首字
    assert.match(lineCard.querySelector('.cons-badge').textContent, /^均值 10\.2s$/);
    lineSegBtns[4].dispatchEvent({ type: 'click', stopPropagation() {} }); // 费用
    assert.match(lineCard.querySelector('.cons-badge').textContent, /^累计 \$0\.046$/);

    // Verify ModelFitChart defaults to current calling model ('gemini-4-hydrogen') on view entry
    const fitModelSelectEl = fitCard.querySelector('.sstep-fit-model-select');
    assert.equal(fitModelSelectEl.hasAttribute('hidden'), false, 'Fit model dropdown visible when >1 model');
    assert.equal(fitModelSelectEl.classList.contains('is-multi'), true);
    assert.equal(
      fitModelSelectEl.querySelector('.select-label').textContent,
      'gemini-4-hydrogen',
      'Fit chart defaults to active calling model upon entering 总汇总'
    );
    const fitSegBtns = fitCard.querySelectorAll('.seg-btn');
    assert.deepEqual(
      fitSegBtns.map((b) => b.textContent),
      ['TPS', '首字', '缓存', '费用']
    );

    // Verify minimalist model summary cards (.smodel-card)
    let smodelCards = modelsAnalyticsPane.querySelectorAll('.smodel-card');
    assert.equal(smodelCards.length, 2, 'Two minimalist model summary cards rendered');
    assert.equal(smodelCards[0].classList.contains('is-fit-active'), true);
    assert.equal(smodelCards[0].querySelector('.smodel-name').textContent, 'gemini-4-hydrogen');
    assert.equal(smodelCards[0].querySelector('.smodel-calls-pill').textContent, '1次 · 50%');
    assert.match(smodelCards[0].querySelector('.smodel-perf').textContent, /均速 92\.3 tok\/s · 首字 5\.6s · 缓存 93\.3%/);
    assert.match(smodelCards[0].querySelector('.smodel-split').textContent, /入 2\.5k · 缓 34\.6k · 思 420 · 正 265/);

    // Simulate live telemetry poll where a subagent spawns on 'Gemini 3 Flash' (changing activeModelLabel)
    // while the user remains inside 总汇总 -> fit model MUST NOT jump!
    liveSubagentPollActive = true;
    const headerRefreshBtn = popoverEl.querySelector('.session-header').querySelector('.icon-btn');
    headerRefreshBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 260));

    smodelCards = modelsAnalyticsPane.querySelectorAll('.smodel-card');
    assert.equal(smodelCards.length, 3, 'Subagent model card added in aggregated scope');
    assert.equal(
      fitModelSelectEl.querySelector('.select-label').textContent,
      'gemini-4-hydrogen',
      'Fit chart model remains pinned and does NOT jump when activeModelShort switches to subagent model during polling'
    );

    // Verify checking 2 and all 3 models in SessionLineChart (会话走势) renders independent colored series without collapsing back to 全部模型
    lineModelSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    for (const modelKey of ['Gemini 4 Hydrogen', 'Claude Opus 4.6', 'Gemini 3 Flash']) {
      const opt = lineModelSelectEl
        .querySelectorAll('.select-option')
        .find((o) => o.getAttribute('data-value') === modelKey);
      assert.ok(opt, `${modelKey} option available in SessionLineChart model dropdown`);
      opt.dispatchEvent({ type: 'click', stopPropagation() {} });
    }
    assert.equal(
      lineModelSelectEl.querySelector('.select-label').textContent,
      '已选 3 模型',
      'Checking all 3 models in SessionLineChart stays in 已选 3 模型 multi-compare mode'
    );
    assert.equal(
      lineCard.querySelector('.sstep-multi-line-group').children.length,
      3,
      'All 3 checked models rendered as independent colored series on SessionLineChart'
    );
    assert.equal(
      lineCard.querySelector('.sstep-model-legend').querySelectorAll('.sstep-legend-item').length,
      3,
      'SessionLineChart legend lists all 3 checked models with matching color swatches'
    );
    // Reset SessionLineChart back to 全部模型
    lineModelSelectEl
      .querySelectorAll('.select-option')
      .find((o) => o.getAttribute('data-value') === '__all__')
      .dispatchEvent({ type: 'click', stopPropagation() {} });
    lineModelSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(lineModelSelectEl.querySelector('.select-label').textContent, '全部模型');

    // Clicking another model card ('claude-opus-4.6') updates fit target; multi-checking a second model draws 2 independent colored fit curves!
    smodelCards[1].onclick();
    assert.equal(fitModelSelectEl.querySelector('.select-label').textContent, 'claude-opus-4.6');
    assert.equal(smodelCards[1].classList.contains('is-fit-active'), true);

    fitModelSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    let fitOpts = fitModelSelectEl.querySelectorAll('.select-option');
    const hydroFitOpt = fitOpts.find((o) => o.getAttribute('data-value') === 'Gemini 4 Hydrogen');
    assert.ok(hydroFitOpt, 'Gemini 4 Hydrogen option available for multi-select comparison');
    hydroFitOpt.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(
      fitModelSelectEl.querySelector('.select-label').textContent,
      '已选 2 模型',
      'Checking two models keeps dropdown open and displays 已选 2 模型'
    );
    assert.equal(
      fitCard.querySelector('.sstep-multi-curve-group').querySelectorAll('.sstep-fit-line').length,
      2,
      'Two independent colored regression curves rendered simultaneously in multi-model compare mode'
    );
    assert.equal(
      fitCard.querySelector('.sstep-model-legend').hasAttribute('hidden'),
      false,
      'Multi-model color legend shown below fit chart when >=2 models compared'
    );

    fitOpts = fitModelSelectEl.querySelectorAll('.select-option');
    const allModelsOpt = fitOpts.find((o) => o.getAttribute('data-value') === '__all__');
    assert.ok(allModelsOpt, '全部模型 option available in fit model dropdown');
    allModelsOpt.dispatchEvent({ type: 'click', stopPropagation() {} });
    fitModelSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(fitModelSelectEl.querySelector('.select-label').textContent, '全部模型');
    assert.match(fitCard.querySelector('.cons-badge').textContent, /^3步 · 均 96\.5 tok\/s$/);
    assert.ok(fitCard.querySelector('.sstep-sci-axes'), 'Scientific L-shaped coordinate axes mounted');
    assert.ok(
      fitCard.querySelectorAll('.sstep-axis-label').length >= 5,
      'Numeric Y-axis and X-axis tick labels rendered'
    );
    assert.equal(
      fitCard.querySelector('.sstep-fit-svg').getAttribute('viewBox'),
      '0 0 180 136',
      'ModelFitChart dynamically adapts viewBox width to measured container width (180px in MockNode)'
    );
    assert.match(
      fitCard.querySelector('.sstep-ci-band').getAttribute('d') || '',
      /^M 2\.0 .* Z$/,
      'Closed 95% CI confidence band polygon rendered flush around regression fit'
    );
    assert.match(
      fitCard.querySelector('.sstep-fit-line').getAttribute('d') || '',
      /^M 2\.0 .* L 178\.0 \d+\.\d$/,
      'Model fit regression curve spans flush edge-to-edge (2.0..178.0) across measured 180px viewBox'
    );
    const fitSpineEl = fitCard.querySelector('.sstep-axis-spine');
    assert.equal(fitSpineEl.getAttribute('x1'), '0');
    assert.equal(fitSpineEl.getAttribute('x2'), '180');
    assert.ok(
      fitCard.querySelectorAll('.sstep-axis-label.is-y-inline').every((el) => el.getAttribute('x') === '0'),
      'Inline Y-axis tick labels sit flush left at x=0 with zero left dead zone'
    );
    // Simulate widening the Sidecar panel to 620px and verify dynamic re-layout edge-to-edge
    fitCard.querySelector('.sstep-plot-stage').clientWidth = 620;
    for (const fn of winListeners.get('resize') || []) fn({});
    assert.equal(fitCard.querySelector('.sstep-fit-svg').getAttribute('viewBox'), '0 0 620 136');
    assert.equal(fitCard.querySelector('.sstep-axis-spine').getAttribute('x2'), '620');
    assert.match(
      fitCard.querySelector('.sstep-fit-line').getAttribute('d') || '',
      /^M 2\.0 .* L 618\.0 \d+\.\d$/,
      'Widening Sidecar to 620px stretches regression curve flush to 2.0..618.0'
    );
    assert.equal(
      lineCard.querySelector('.sstep-chart-wrap').style.getPropertyValue('--sstep-accent'),
      'var(--ctx-cached)',
      'Session line chart uses project calm blue accent'
    );
    assert.equal(
      fitCard.querySelector('.sstep-chart-wrap').style.getPropertyValue('--sstep-fit-accent'),
      'var(--ctx-cached)',
      'Model fit chart uses project calm blue accent instead of fiery orange'
    );
    assert.match(
      fitCard.querySelector('.sstep-fit-delta').textContent,
      /^r = [+-]\d+\.\d{2} · R² = \d+\.\d{2}$/,
      'Statistical r and R² diagnostics rendered in footer'
    );

    // Filter to Subagent #1 via multi-select inlineScopeSelect -> single-model scope auto-hides model dropdowns!
    const inlineScopeSelectEl = stepsPane.querySelector('.steps-inline-scope-select');
    assert.equal(inlineScopeSelectEl.hasAttribute('hidden'), false, 'Inline agent scope selector visible when subagents exist');
    assert.equal(inlineScopeSelectEl.classList.contains('is-multi'), true);
    inlineScopeSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    const subScopeOpt = inlineScopeSelectEl
      .querySelectorAll('.select-option')
      .find((o) => o.getAttribute('data-value') === 'sub-fast-1');
    assert.ok(subScopeOpt, 'Subagent scope option rendered');
    subScopeOpt.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    smodelCards = modelsAnalyticsPane.querySelectorAll('.smodel-card');
    assert.equal(smodelCards.length, 1, 'Scoped to subagent #1 model only');
    assert.equal(smodelCards[0].querySelector('.smodel-name').textContent, 'gemini-3-flash');
    assert.match(fitCard.querySelector('.cons-badge').textContent, /^1步 · 均 145\.0 tok\/s$/);
    assert.equal(
      lineModelSelectEl.hasAttribute('hidden'),
      true,
      'SessionLineChart model dropdown auto-hidden when only 1 model exists'
    );
    assert.equal(
      fitModelSelectEl.hasAttribute('hidden'),
      true,
      'ModelFitChart model dropdown auto-hidden when only 1 model exists'
    );

    // Restore sub-tab to 'steps', reset scope to 'all', and verify multi-agent rootTurnIndex rail + decoupled [主]/[子] badge toggle
    stepsHeaderSegBtns[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    inlineScopeSelectEl
      .querySelectorAll('.select-option')
      .find((o) => o.getAttribute('data-value') === 'all')
      .dispatchEvent({ type: 'click', stopPropagation() {} });
    inlineScopeSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));

    const multiStepRows = stepsPane.querySelectorAll('.data-table')[0].children[1].children;
    assert.equal(multiStepRows.length, 3, 'All 3 interleaved main + subagent steps rendered in 全部代理');
    assert.equal(
      multiStepRows[0].children[0].querySelector('.agent-badge').hasAttribute('hidden'),
      false,
      '[子1] badge visible when showStepAgentBadge is true'
    );
    assert.equal(multiStepRows[0].children[0].querySelector('.agent-badge').textContent, '子1');
    assert.equal(multiStepRows[1].children[0].querySelector('.agent-badge').textContent, '主');
    assert.equal(
      multiStepRows[0].children[0].querySelector('.turn-rail').classList.contains('is-cap'),
      true,
      'Interleaved subagent step at top joins unified rootTurnIndex rail as cap'
    );
    assert.equal(
      multiStepRows[1].children[0].querySelector('.turn-rail').classList.contains('is-cap') ||
        multiStepRows[1].children[0].querySelector('.turn-rail').classList.contains('is-origin'),
      false,
      'Middle main step connects continuously along unified rootTurnIndex rail'
    );
    assert.equal(
      multiStepRows[2].children[0].querySelector('.turn-rail').classList.contains('is-origin'),
      true,
      'Earliest main step anchors unified rootTurnIndex rail origin'
    );

    // Hide [主]/[子] badge independently via settings switch while keeping step numbers (#4, #35, #20) and turn rail intact
    pillTabs[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    subNavBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    sec3SegControls[1].querySelectorAll('.seg-btn')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));
    pillTabs[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(
      multiStepRows[0].children[0].querySelector('.agent-badge').hasAttribute('hidden'),
      true,
      '[子1] badge hidden when showStepAgentBadge=false'
    );
    assert.equal(
      multiStepRows[1].children[0].querySelector('.agent-badge').hasAttribute('hidden'),
      true,
      '[主] badge hidden when showStepAgentBadge=false'
    );
    assert.equal(
      multiStepRows[0].children[0].children.at(-1).textContent,
      '#4',
      'Step index remains intact when [主]/[子] badge is hidden'
    );
    assert.equal(
      multiStepRows[0].children[0].querySelector('.turn-rail').hasAttribute('hidden'),
      false,
      'Turn rail remains visible independently of [主]/[子] badge switch'
    );

    // Restore showStepAgentBadge=true and verify [主]/[子] badge + Turn Rail still render in col 0 even when 'step' (步序) column is replaced!
    pillTabs[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    sec3SegControls[1].querySelectorAll('.seg-btn')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));

    // Remove first column 'step' (步序) via .slot-remove-btn[0] so 'model' (模型) becomes column 0
    sec3
      .querySelector('.editable-slot-wrap')
      .querySelectorAll('.slot-remove-btn')[0]
      .dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));

    pillTabs[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    const headerCellsNoStep = stepsPane.querySelectorAll('.data-table')[0].children[0].children[0].children;
    assert.equal(headerCellsNoStep[0].textContent, '模型', 'First column is now 模型 after removing 步序');
    assert.equal(
      multiStepRows[0].children[0].querySelector('.agent-badge').hasAttribute('hidden'),
      false,
      '[子1] badge stays visible in leading 模型 column even when 步序 (step) column is absent!'
    );
    assert.equal(multiStepRows[0].children[0].querySelector('.agent-badge').textContent, '子1');
    assert.equal(multiStepRows[1].children[0].querySelector('.agent-badge').textContent, '主');
    assert.equal(
      multiStepRows[0].children[0].querySelector('.turn-rail').hasAttribute('hidden'),
      false,
      'Turn rail also stays visible in leading 模型 column'
    );

    // Reset section 4 back to default columns before subsequent route tests
    pillTabs[3].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    sec3.querySelector('.btn-ghost-sm').dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 260));
    pillTabs[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    liveSubagentPollActive = false;

    // Verify bundle version bump NEVER calls window.location.reload() in overlay mode
    currentBundleVer = 'ver-200';
    currentAccountEmail = 'next@example.com';
    mockLocation.pathname = '/c/cccccccc-4444-5555-6666-dddddddddddd';
    for (const fn of winListeners.get('popstate') || []) fn({});
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(reloadCalled, false, 'Host window must never reload on bundle version change');
    assert.ok(
      fetchedUrls.some((u) => u.includes('conversationId=cccccccc-4444-5555-6666-dddddddddddd')),
      'Navigated host route immediately tracked'
    );
    // Verify fallback to CDP RPC relay when browser fetch fails (e.g. CSP connect-src or proxy block)
    let fetchShouldFail = true;
    const origFetch = mockWindow.fetch;
    mockWindow.fetch = async (url, opts) => {
      if (fetchShouldFail) {
        throw new TypeError('Failed to fetch');
      }
      return origFetch(url, opts);
    };
    mockLocation.pathname = '/c/dddddddd-7777-8888-9999-eeeeeeeeeeee';
    for (const fn of winListeners.get('popstate') || []) fn({});
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(mockWindow.__AGUsageMonitorBridge.transportMode, 'cdp');
    assert.equal(Array.isArray(mockWindow.__AGUsageMonitorBridge.rpcQueue), true);
    assert.equal(mockWindow.__AGUsageMonitorBridge.rpcQueue.length, 1);
    const queuedItem = mockWindow.__AGUsageMonitorBridge.rpcQueue.shift();
    const delivered = ov.deliverRpc([
      {
        id: queuedItem.id,
        ok: true,
        status: 200,
        data: {
          uiBundleVersion: 'ver-200',
          settings: { weeklyLimitMode: 'official', weeklyTokenBudget: 150000000, weeklyCostBudget: 100, enableWindowOverlay: true },
          activeConversation: {
            cascadeId: 'dddddddd-7777-8888-9999-eeeeeeeeeeee',
            title: 'CDP Relay Session',
            isRunning: false,
            stepCount: 8,
            latestTokPerSec: 120.5,
            context: { totalTokens: 64000, compactionLimitTokens: 256000, limitTokens: 256000 },
            recentSteps: [],
          },
          consumption: { selectedRange: { key: 'today', label: '今天', startMs: 1, endMs: 2 }, session: {}, account: {}, trendSeries: [], monthlySeries: [] },
          quotas: null,
          modelBreakdown: [],
        },
      },
    ]);
    assert.equal(delivered, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      defaultCapSlots[2].querySelector('.wm-ctx-pct').textContent,
      '25%',
      'CDP relay delivered live telemetry without HTTP'
    );
    assert.equal(defaultCapSlots[0].children[0].textContent, '121 t/s');
    assert.equal(defaultCapSlots[1].hasAttribute('hidden'), false, 'TTFT slot stays pre-reserved even when latestTtftSec is absent');
    assert.equal(defaultCapSlots[1].children[0].textContent, '--s');
    assert.equal(
      hoverLegendGrid.children[0],
      firstLegendSlotBefore,
      'Hover legend updates strictly in-place without DOM node replacement or appendChild'
    );

    assert.equal(createdForms.some((form) => form.className.includes('settings-account-form')), false);
    assert.equal(fetchedUrls.some((url) => url.includes('/api/accounts')), false);

    // Verify in-place bridge port rotation preserves exact DOM host nodes without remount
    fetchShouldFail = false;
    assert.equal(ov.updateBridge({ port: 51234, token: 'rotated-token-456' }), true);
    assert.equal(mockWindow.__AGUsageMonitorBridge.port, 51234);
    assert.equal(mockDocument.getElementById('ag-usage-monitor-capsule'), capsuleHost);
  } finally {
    mockWindow.__AGUsageMonitorOverlay?.dispose?.();
    assert.equal(mockDocument.getElementById('ag-usage-monitor-capsule'), null);
    assert.equal(mockDocument.getElementById('ag-usage-monitor-portal'), null);
  }
});

test('Antigravity IDE argv.json JSONC auto-provisioning preserves comments, upgrades numeric ports to string, and rejects invalid JSONC', () => {
  assert.equal(
    resolveIdeArgvPath({ VSCODE_PORTABLE: 'D:\\PortableIDE' }, 'C:\\Users\\Dev'),
    path.join('D:\\PortableIDE', 'argv.json')
  );
  assert.equal(
    resolveIdeArgvPath({}, 'C:\\Users\\Dev'),
    path.join('C:\\Users\\Dev', '.antigravity-ide', 'argv.json')
  );

  // 1. Empty / missing file produces valid commented JSONC with string "0"
  const fromEmpty = ensureRemoteDebuggingInArgvText('');
  assert.equal(fromEmpty.valid, true);
  assert.equal(fromEmpty.changed, true);
  assert.equal(fromEmpty.portValue, '0');
  assert.match(fromEmpty.text, /"remote-debugging-port":\s*"0"/);

  // 2. Realistic commented VS Code / Antigravity IDE argv.json with inline & trailing comments + CRLF
  const sampleJsonc = [
    '// This configuration file allows you to pass permanent command line arguments to Antigravity IDE.',
    '{',
    '\t/* Hardware acceleration toggle */',
    '\t// "disable-hardware-acceleration": true,',
    '\t"enable-crash-reporter": true,',
    '\t"crash-reporter-id": "12345678-1234-1234-1234-123456789abc" // keep crash id',
    '\t// bottom comment before closing brace',
    '}',
    '',
  ].join('\r\n');

  const patched = ensureRemoteDebuggingInArgvText(sampleJsonc);
  assert.equal(patched.valid, true);
  assert.equal(patched.changed, true);
  assert.equal(patched.portValue, '0');
  assert.ok(
    patched.text.includes('"crash-reporter-id": "12345678-1234-1234-1234-123456789abc", // keep crash id'),
    'Comma inserted right after property value before inline comment'
  );
  assert.ok(patched.text.includes('// bottom comment before closing brace'), 'Bottom comment preserved');
  assert.ok(patched.text.includes('\t"remote-debugging-port": "0"\r\n}'), 'String port inserted with matching tab indent and CRLF');

  // Idempotent on second pass
  const secondPass = ensureRemoteDebuggingInArgvText(patched.text);
  assert.equal(secondPass.valid, true);
  assert.equal(secondPass.changed, false);
  assert.equal(secondPass.alreadyConfigured, true);
  assert.equal(secondPass.text, patched.text);

  // 3. Upgrades numeric 0 or 9222 (which IDE silently ignores!) to string "0" / "9222"
  const numericZero = '{\n\t// user wrote number\n\t"remote-debugging-port": 0,\n\t"enable-crash-reporter": true\n}\n';
  const upgradedZero = ensureRemoteDebuggingInArgvText(numericZero);
  assert.equal(upgradedZero.valid, true);
  assert.equal(upgradedZero.changed, true);
  assert.equal(upgradedZero.portValue, '0');
  assert.ok(upgradedZero.text.includes('"remote-debugging-port": "0",'));
  assert.ok(upgradedZero.text.includes('// user wrote number'));

  const numericCustom = '{\n\t"remote-debugging-port": 9229\n}\n';
  const upgradedCustom = ensureRemoteDebuggingInArgvText(numericCustom);
  assert.equal(upgradedCustom.valid, true);
  assert.equal(upgradedCustom.changed, true);
  assert.equal(upgradedCustom.portValue, '9229');
  assert.ok(upgradedCustom.text.includes('"remote-debugging-port": "9229"'));

  // 4. Malformed JSONC is never overwritten
  const broken = '{\n\t"enable-crash-reporter": \n}';
  const brokenRes = ensureRemoteDebuggingInArgvText(broken);
  assert.equal(brokenRes.valid, false);
  assert.equal(brokenRes.changed, false);
  assert.equal(brokenRes.text, broken);

  // 5. Filesystem helper skips missing ~/.antigravity-ide and updates existing ~/.antigravity-ide/argv.json
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ide-argv-test-'));
  try {
    const missingRes = ensureIdeRemoteDebuggingArgv({ env: {}, homeDir: tmpHome, enabled: true });
    assert.equal(missingRes.updated, false);
    assert.equal(missingRes.reason, 'ide_dir_missing');
    assert.equal(fs.existsSync(path.join(tmpHome, '.antigravity-ide')), false, 'Never creates .antigravity-ide if IDE is not installed');

    const ideDir = path.join(tmpHome, '.antigravity-ide');
    fs.mkdirSync(ideDir, { recursive: true });
    const argvFile = path.join(ideDir, 'argv.json');
    fs.writeFileSync(argvFile, sampleJsonc, 'utf8');

    const writeRes = ensureIdeRemoteDebuggingArgv({ env: {}, homeDir: tmpHome, enabled: true });
    assert.equal(writeRes.updated, true);
    assert.equal(writeRes.portValue, '0');
    const diskText = fs.readFileSync(argvFile, 'utf8');
    assert.ok(diskText.includes('"remote-debugging-port": "0"'));

    const noopRes = ensureIdeRemoteDebuggingArgv({ env: {}, homeDir: tmpHome, enabled: true });
    assert.equal(noopRes.updated, false);
    assert.equal(noopRes.alreadyConfigured, true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Multi-port CDP discovery tolerates stale 2.0 DevToolsActivePort while injecting Antigravity IDE workbench and allowing vscode-file://vscode-app origin', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wm-multiport-'));
  const roamingDir = path.join(tmpDir, 'Roaming');
  const localDir = path.join(tmpDir, 'Local');
  fs.mkdirSync(path.join(roamingDir, 'Antigravity'), { recursive: true });
  fs.mkdirSync(path.join(roamingDir, 'Antigravity IDE'), { recursive: true });

  // Reserve and immediately close a port to simulate a stale Antigravity 2.0 DevToolsActivePort file
  const deadServer = http.createServer();
  await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
  const stalePort = deadServer.address().port;
  await new Promise((resolve) => deadServer.close(resolve));
  fs.writeFileSync(
    path.join(roamingDir, 'Antigravity', 'DevToolsActivePort'),
    `${stalePort}\n/devtools/browser/stale-20`,
    'utf8'
  );

  // Live Antigravity IDE CDP server exposing workbench.html + workbench-jetski-agent.html + ignored sharedProcess.html
  const ideContextObj = {
    location: { pathname: '/out/vs/code/electron-browser/workbench/workbench.html' },
    setTimeout,
    document: {
      querySelector(sel) {
        if (sel.includes('conversation-view')) {
          return {
            getAttribute(k) {
              return k === 'data-cascade-id' ? '99999999-aaaa-bbbb-cccc-888888888888' : null;
            },
          };
        }
        return null;
      },
    },
  };
  ideContextObj.window = ideContextObj;
  ideContextObj.globalThis = ideContextObj;
  const ideVm = vm.createContext(ideContextObj);

  const jetskiObj = { location: { pathname: '/out/vs/code/electron-browser/workbench/workbench-jetski-agent.html' } };
  jetskiObj.window = jetskiObj;
  jetskiObj.globalThis = jetskiObj;
  const jetskiVm = vm.createContext(jetskiObj);

  const modelId = 'MODEL_PLACEHOLDER_M430';
  const chat = {
    location: new URL('http://127.0.0.1:50234/?extensionView=true'),
    __APP_CONFIG__: { csrfToken: 'chat-test' },
    fetch: async () => ({ ok: true, json: async () => ({ userStatus: { cascadeModelConfigData: {
      clientModelConfigs: [{ modelOrAlias: { model: modelId }, contextWindowOptions: [{ name: '900K' }] }],
    } } }) }),
  };
  chat.window = chat;
  const chatVm = vm.createContext({ ...chat, window: chat, TextEncoder, TextDecoder, AbortSignal, setTimeout, clearTimeout });
  const vmMap = new Map([
    ['ide-main', ideVm],
    ['ide-jetski', jetskiVm],
    ['ide-chat', chatVm],
  ]);

  class MockIdeWebSocket {
    constructor(url) {
      this.targetId = url.split('/').pop();
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.evaluate') {
        const ctx = vmMap.get(this.targetId);
        const value = vm.runInContext(msg.params.expression, ctx);
        Promise.resolve(value).then((result) =>
          this._emit('message', {
            data: JSON.stringify({ id: msg.id, result: { result: { value: result } } }),
          })
        );
      }
    }
    close() {}
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }

  const ideCdpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const p = ideCdpServer.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'ide-main',
            type: 'page',
            url: 'vscode-file://vscode-app/c:/Program%20Files/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/ide-main`,
          },
          {
            type: 'page',
            url: 'vscode-file://vscode-app/c:/Program%20Files/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench-jetski-agent.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/ide-jetski`,
          },
          {
            type: 'page',
            url: 'vscode-file://vscode-app/c:/Program%20Files/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/sharedProcess/sharedProcess.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/shared`,
          },
          {
            type: 'iframe',
            parentId: 'ide-main',
            url: chat.location.href,
            webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/ide-chat`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => ideCdpServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(roamingDir, 'Antigravity IDE', 'DevToolsActivePort'),
    `${ideCdpServer.address().port}\n/devtools/browser/live-ide`,
    'utf8'
  );

  const prefetchedConvIds = [];
  const settings = { enableWindowOverlay: true, modelContextWindows: { [modelId]: '900K' } };
  const mockAppJs = `
    (() => {
      const br = window.__AGUsageMonitorBridge;
      let alive = true;
      window.__AGUsageMonitorOverlay = {
        bundleVersion: br.bundleVersion,
        ensureAlive: () => alive,
        dispose: () => { alive = false; },
      };
    })();
  `;

  const controller = createWindowBridgeController({
    handleApiRequest: async (pathname, _method, data) => {
      if (pathname === '/api/telemetry') {
        prefetchedConvIds.push(data.conversationId || '');
      }
      return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) };
    },
    readAssetFn: async (rel) => (rel === 'styles.css' ? ':host{}' : mockAppJs),
    getSettingsFn: () => settings,
    getBundleVersionFn: () => 'ide-v1',
    env: { APPDATA: roamingDir, LOCALAPPDATA: localDir },
    platform: 'win32',
    homeDir: tmpDir,
    WebSocketImpl: MockIdeWebSocket,
  });

  try {
    const syncRes = await controller.syncAllWindows();
    assert.equal(syncRes.ok, true, 'Stale 2.0 port did not block live Antigravity IDE port');
    assert.equal(syncRes.targets, 2, 'Matched workbench.html and workbench-jetski-agent.html while excluding sharedProcess.html');
    assert.equal(syncRes.injected, 2);
    assert.equal(chat.__AGUsageMonitorContextWindows?.rules[modelId], '900K');
    assert.equal(ideContextObj.__AGUsageMonitorContextWindows, undefined);
    assert.ok(
      prefetchedConvIds.includes('99999999-aaaa-bbbb-cccc-888888888888'),
      'Initial telemetry prefetch extracted active IDE conversation UUID from DOM'
    );

    // Verify loopback HTTP bridge accepts Origin: vscode-file://vscode-app
    const { port, token } = controller.getBridgeInfo();
    const ideOriginRes = await fetch(`http://127.0.0.1:${port}/api/telemetry?range=today`, {
      headers: {
        Origin: 'vscode-file://vscode-app',
        'X-Usage-Monitor-Token': token,
      },
    });
    assert.equal(ideOriginRes.status, 200);

    settings.modelContextWindows = {};
    await controller.syncAllWindows();
    assert.equal(chat.__AGUsageMonitorContextWindows, undefined);
  } finally {
    await controller.stop({ disposeWindows: true });
    await new Promise((resolve) => ideCdpServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Compiled app.js in Antigravity IDE workbench.html docks into .part.titlebar, manages .action-toolbar-container margin, tracks DOM cascade IDs, and mirrors --vscode-* theme tokens', async () => {
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  const {
    docRoot,
    body,
    document: mockDocument,
    makeElement: makeIdeNode,
  } = createMockDom({
    defaultRect: { left: 0, right: 1440, top: 0, bottom: 35, width: 1440, height: 35 },
    inheritAncestorRect: true,
  });

  // Build Antigravity IDE .monaco-workbench with BOTH top window .part.titlebar AND inner chat @container/titlebar
  const workbench = makeIdeNode('div');
  workbench.className = 'monaco-workbench vs-dark';

  const partTitlebar = makeIdeNode('div');
  partTitlebar.className = 'part titlebar';
  const tbContainer = makeIdeNode('div');
  tbContainer.className = 'titlebar-container has-center';
  const tbLeft = makeIdeNode('div', { left: 0, right: 60, top: 0, bottom: 35, width: 60, height: 35 });
  tbLeft.className = 'titlebar-left';
  const tbCenter = makeIdeNode('div', { left: 540, right: 900, top: 0, bottom: 35, width: 360, height: 35 });
  tbCenter.className = 'titlebar-center';
  const tbRight = makeIdeNode('div', { left: 900, right: 1440, top: 0, bottom: 35, width: 540, height: 35 });
  tbRight.className = 'titlebar-right';

  const actionToolbar = makeIdeNode('div', { left: 1170, right: 1300, top: 0, bottom: 35, width: 130, height: 35 });
  actionToolbar.className = 'action-toolbar-container';
  actionToolbar.style.marginLeft = 'auto';

  const winControls = makeIdeNode('div', { left: 1300, right: 1440, top: 0, bottom: 35, width: 140, height: 35 });
  winControls.className = 'window-controls-container';

  tbRight.appendChild(actionToolbar);
  tbRight.appendChild(winControls);
  tbContainer.appendChild(tbLeft);
  tbContainer.appendChild(tbCenter);
  tbContainer.appendChild(tbRight);
  partTitlebar.appendChild(tbContainer);
  workbench.appendChild(partTitlebar);

  // Inner chat pane header + conversation view
  const innerChatHeader = makeIdeNode('div');
  innerChatHeader.className = 'flex items-center @container/titlebar';
  const innerChatRight = makeIdeNode('div');
  innerChatRight.className = 'shrink-0 flex items-center';
  innerChatHeader.appendChild(makeIdeNode('div'));
  innerChatHeader.appendChild(innerChatRight);
  workbench.appendChild(innerChatHeader);

  const convView = makeIdeNode('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', '12345678-aaaa-bbbb-cccc-1234567890ab');
  workbench.appendChild(convView);

  body.appendChild(workbench);

  const vscodeVars = new Map([
    ['--vscode-sideBar-background', '#181818'],
    ['--vscode-editorWidget-background', '#202020'],
    ['--vscode-foreground', '#cccccc'],
    ['--vscode-descriptionForeground', '#9d9d9d'],
    ['--vscode-widget-border', '#303031'],
    ['--vscode-textLink-foreground', '#4daafc'],
    ['--vscode-errorForeground', '#f14c4c'],
  ]);

  const mutationObservers = [];
  class IdeMutationObserver extends MockMutationObserver {
    constructor(cb) {
      super(cb, mutationObservers);
    }
  }
  const fetchedUrls = [];

  const mockWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    location: {
      pathname: '/out/vs/code/electron-browser/workbench/workbench.html',
      reload() {},
    },
    document: mockDocument,
    __AGUsageMonitorBridge: {
      port: 49200,
      token: 'ide-bridge-token',
      bundleVersion: 'ide-ver-1',
      stylesCss,
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle(el) {
      if (el === workbench) {
        return {
          paddingLeft: '0px',
          paddingRight: '0px',
          getPropertyValue: (k) => vscodeVars.get(k) || '',
        };
      }
      return {
        paddingLeft: '0px',
        paddingRight: '0px',
        getPropertyValue: () => '',
      };
    },
    fetch: async (url) => {
      fetchedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          uiBundleVersion: 'ide-ver-1',
          settings: {
            enableWindowOverlay: true,
            showTopbarMultiSession: true,
            topbarCapsuleSlots: ['context', 'tps', 'quota_auto'],
          },
          activeConversation: {
            cascadeId: convView.getAttribute('data-cascade-id'),
            title: 'IDE Session',
            isRunning: false,
            stepCount: 3,
            latestTokPerSec: 84.5,
            context: { totalTokens: 64000, compactionLimitTokens: 256000, limitTokens: 256000 },
            recentSteps: [],
          },
          consumption: { selectedRange: { key: 'today', label: '今天', startMs: 1, endMs: 2 }, session: {}, account: {}, trendSeries: [], monthlySeries: [] },
          quotas: null,
          modelBreakdown: [],
        }),
      };
    },
  };
  mockWindow.window = mockWindow;
  mockWindow.globalThis = mockWindow;

  const sandbox = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: mockDocument,
    location: mockWindow.location,
    navigator: {},
    MutationObserver: IdeMutationObserver,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: mockWindow.fetch,
    console,
  });

  vm.runInContext(appJs, sandbox);
  await new Promise((r) => setTimeout(r, 35));

  try {
    const ov = mockWindow.__AGUsageMonitorOverlay;
    assert.ok(ov, 'Overlay mounted in Antigravity IDE');
    const capsuleHost = mockDocument.getElementById('ag-usage-monitor-capsule');
    const portalHost = mockDocument.getElementById('ag-usage-monitor-portal');

    // 1. Prioritizes IDE window .part.titlebar > .titlebar-right over inner chat @container/titlebar
    assert.equal(capsuleHost.getAttribute('data-dock'), 'ide-titlebar');
    assert.equal(capsuleHost.parentNode, tbRight);
    assert.equal(tbRight.firstChild, capsuleHost, 'Capsule inserted before .action-toolbar-container');
    assert.equal(innerChatRight.children.includes(capsuleHost), false, 'Does not dock into narrower inner chat header when IDE titlebar is visible');
    assert.equal(actionToolbar.style.marginLeft, '0px', 'Transfers margin-left:auto to capsuleHost while docked');
    assert.equal(ov.getLayoutMode(), 'wide');

    // 2. Mirrors --vscode-* theme variables onto body portalHost when :root lacks --background
    assert.equal(portalHost.style.getPropertyValue('--background'), '#181818');
    assert.equal(portalHost.style.getPropertyValue('--card'), '#202020');
    assert.equal(portalHost.style.getPropertyValue('--foreground'), '#cccccc');
    assert.equal(portalHost.style.getPropertyValue('--muted-foreground'), '#9d9d9d');
    assert.equal(portalHost.style.getPropertyValue('--border'), '#303031');
    assert.equal(portalHost.style.getPropertyValue('--primary'), '#4daafc');
    assert.equal(portalHost.style.getPropertyValue('--destructive'), '#f14c4c');

    // Live theme switch updates portalHost variables
    vscodeVars.set('--vscode-sideBar-background', '#f8f8f8');
    vscodeVars.set('--vscode-foreground', '#1f1f1f');
    for (const mo of mutationObservers) {
      if (mo.targets.some((t) => t.target === workbench)) {
        mo.cb([{ target: workbench, type: 'attributes', attributeName: 'class' }]);
      }
    }
    assert.equal(portalHost.style.getPropertyValue('--background'), '#f8f8f8');
    assert.equal(portalHost.style.getPropertyValue('--foreground'), '#1f1f1f');

    // 3. Extracts active conversation UUID from [data-testid="conversation-view"][data-cascade-id] and reacts to session switch
    assert.ok(
      fetchedUrls.some((u) => u.includes('conversationId=12345678-aaaa-bbbb-cccc-1234567890ab')),
      'Initial IDE conversation UUID tracked from DOM'
    );
    convView.setAttribute('data-cascade-id', '87654321-dddd-eeee-ffff-0987654321fe');
    for (const mo of mutationObservers) {
      if (mo.targets.some((t) => t.target === body)) {
        mo.cb([{ target: convView, type: 'attributes', attributeName: 'data-cascade-id' }]);
      }
    }
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(
      fetchedUrls.some((u) => u.includes('conversationId=87654321-dddd-eeee-ffff-0987654321fe')),
      'Switching conversation in IDE immediately fetches new conversation telemetry'
    );

    // 4. Fullscreen / hidden .part.titlebar gracefully falls back to inner chat @container/titlebar and restores .action-toolbar-container margin
    partTitlebar._rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    ov.ensureAlive();
    assert.equal(capsuleHost.getAttribute('data-dock'), 'flow');
    assert.equal(capsuleHost.parentNode, innerChatRight);
    assert.equal(actionToolbar.style.marginLeft, 'auto', 'Restored original marginLeft when undocking from IDE titlebar');

    // Re-showing .part.titlebar re-docks into IDE titlebar
    partTitlebar._rect = { left: 0, right: 1440, top: 0, bottom: 35, width: 1440, height: 35 };
    ov.ensureAlive();
    assert.equal(capsuleHost.getAttribute('data-dock'), 'ide-titlebar');
    assert.equal(actionToolbar.style.marginLeft, '0px');

    // 5. Tracks external IDE child iframe route updates pushed via window.__AGUsageMonitorBridge.hostRouteCascadeId
    mockWindow.__AGUsageMonitorBridge.hostRouteCascadeId =
      'a4206937-54dd-4d4e-a161-813719bf7107';
    ov.syncHostRoute();
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(
      fetchedUrls.some((u) =>
        u.includes('conversationId=a4206937-54dd-4d4e-a161-813719bf7107')
      ),
      'External IDE iframe route sync immediately fetches matching conversation telemetry'
    );
  } finally {
    mockWindow.__AGUsageMonitorOverlay?.dispose?.();
    assert.equal(actionToolbar.style.marginLeft, 'auto', 'dispose() cleanly restores .action-toolbar-container marginLeft');
  }
});

test('Antigravity IDE iframe route association, LS process discovery, and 0-tool MCP stdio protocol', async () => {
  // 1. IDE extensionView iframe route extraction & parentId multi-window isolation
  assert.equal(
    extractIdeExtensionCascadeId(
      'http://127.0.0.1:41362/c/a4206937-54dd-4d4e-a161-813719bf7107?extensionView=true&extensionVariant=vs-code'
    ),
    'a4206937-54dd-4d4e-a161-813719bf7107'
  );
  assert.equal(
    extractIdeExtensionCascadeId('http://127.0.0.1:41362/?extensionView=true'),
    ''
  );

  const rawTargets = [
    {
      id: 'WB-1',
      type: 'page',
      url: 'vscode-file://vscode-app/c:/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1648/devtools/page/WB-1',
    },
    {
      id: 'WB-2',
      type: 'page',
      url: 'vscode-file://vscode-app/c:/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html?windowId=2',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1648/devtools/page/WB-2',
    },
    {
      id: 'WV-1',
      parentId: 'WB-1',
      type: 'iframe',
      url: 'vscode-webview://1234/index.html?purpose=webviewView',
    },
    {
      id: 'CHAT-1',
      parentId: 'WV-1',
      type: 'iframe',
      url: 'http://127.0.0.1:41362/c/11111111-2222-3333-4444-555555555555?extensionView=true',
    },
    {
      id: 'WV-2',
      parentId: 'WB-2',
      type: 'iframe',
      url: 'vscode-webview://5678/index.html?purpose=webviewView',
    },
    {
      id: 'CHAT-2',
      parentId: 'WV-2',
      type: 'iframe',
      url: 'http://127.0.0.1:41999/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?extensionView=true',
    },
  ];
  const mainTargets = rawTargets.filter(isAntigravityMainPageTarget);
  const associated = associateIdeIframeRoutes(rawTargets, mainTargets);
  assert.equal(associated.length, 2);
  assert.equal(associated[0].isIdeWorkbench, true);
  assert.equal(associated[0].ideRouteCascadeId, '11111111-2222-3333-4444-555555555555');
  assert.equal(associated[1].ideRouteCascadeId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  // Single IDE window fallback when parentId is absent
  const noParentRaw = [
    rawTargets[0],
    {
      id: 'CHAT-SOLO',
      type: 'iframe',
      url: 'http://127.0.0.1:41362/c/a4206937-54dd-4d4e-a161-813719bf7107?extensionView=true',
    },
  ];
  const soloAssoc = associateIdeIframeRoutes(
    noParentRaw,
    noParentRaw.filter(isAntigravityMainPageTarget)
  );
  assert.equal(soloAssoc[0].ideRouteCascadeId, 'a4206937-54dd-4d4e-a161-813719bf7107');

  // 2. Language Server / Hub CLI parsing & ancestor PID prioritization
  const parsedWinHub = parseLsArgsFromCommandLine(
    '"C:\\Users\\Admin\\.gemini\\bin\\agy.exe" --hub --hub-port=41362 --app_data_dir=antigravity --csrf_token=0759efca-5597-49d9-bcc1-347cfbca99c2'
  );
  assert.equal(parsedWinHub.isHub, true);
  assert.equal(parsedWinHub.hubPort, 41362);
  assert.equal(parsedWinHub.csrfToken, '0759efca-5597-49d9-bcc1-347cfbca99c2');

  const discovered = await discoverAntigravityLsEndpoint({
    ppid: 6832,
    platform: 'win32',
    execCmdFn: async () =>
      JSON.stringify([
        {
          ProcessId: 5100,
          ParentProcessId: 1000,
          CommandLine: 'agy.exe --hub --hub-port=39000 --csrf_token=other-tok',
        },
        {
          ProcessId: 6832,
          ParentProcessId: 2000,
          CommandLine:
            '"C:\\Users\\Admin\\.gemini\\bin\\agy.exe" --hub --hub-port=41362 --csrf_token=parent-tok',
        },
      ]),
    fetchFn: async (url, opts) => ({
      ok:
        String(url).startsWith('http://127.0.0.1:41362/') &&
        opts?.headers?.['x-codeium-csrf-token'] === 'parent-tok',
    }),
  });
  assert.deepEqual(discovered, {
    addr: '127.0.0.1:41362',
    baseUrl: 'http://127.0.0.1:41362',
    csrfToken: 'parent-tok',
    pid: 6832,
  });

  // 3. Zero-tool MCP JSON-RPC 2.0 protocol responses
  const initResp = handleMcpJsonRpcMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    },
    '1.4.4'
  );
  assert.equal(initResp.result.protocolVersion, '2025-03-26');
  assert.equal(initResp.result.serverInfo.name, 'usage-monitor-host');

  assert.equal(
    handleMcpJsonRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    null
  );

  const toolsResp = handleMcpJsonRpcMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  assert.deepEqual(toolsResp.result, { tools: [] });

  const unknownResp = handleMcpJsonRpcMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
  });
  assert.equal(unknownResp.error.code, -32601);

  // 4. End-to-end child process stdio framing & clean shutdown on stdin EOF
  const mcpEntryPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '../mcp-entry.mjs'
  );
  const child = spawn(process.execPath, [mcpEntryPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    },
  });

  const stdoutLines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) stdoutLines.push(JSON.parse(line));
    }
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    })}\n`
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} })}\n`);

  const waitDeadline = Date.now() + 3000;
  while (stdoutLines.length < 2 && Date.now() < waitDeadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(stdoutLines.length, 2, 'Received initialize and tools/list responses with zero stray stdout noise');
  assert.equal(stdoutLines[0].id, 10);
  assert.equal(stdoutLines[0].result.protocolVersion, '2025-03-26');
  assert.equal(stdoutLines[1].id, 11);
  assert.deepEqual(stdoutLines[1].result, { tools: [] });

  const exitCode = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.stdin.end();
  });
  assert.equal(exitCode, 0, 'mcp-entry exits cleanly with code 0 when host closes stdin');
});

test('Composer mount mode (输入框挂载) docks capsule immediately left of Auto button, opens popups upward, and hot-switches cleanly', async () => {
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  const {
    body,
    document: mockDocument,
    makeElement: makeCompNode,
  } = createMockDom({
    rootRect: { left: 0, right: 1440, top: 0, bottom: 900, width: 1440, height: 900 },
    defaultRect: { left: 820, right: 946, top: 810, bottom: 836, width: 126, height: 26 },
    inheritAncestorRect: true,
  });

  // 1. Topbar
  const titlebar = makeCompNode('div', { left: 0, right: 1440, top: 0, bottom: 38, width: 1440, height: 38 });
  titlebar.className = 'flex items-center @container/titlebar';
  const titleLeft = makeCompNode('div', { left: 16, right: 220, top: 6, bottom: 32, width: 204, height: 26 });
  titleLeft.textContent = 'Chat Title';
  const titleRight = makeCompNode('div', { left: 1200, right: 1420, top: 6, bottom: 32, width: 220, height: 26 });
  titleRight.className = 'shrink-0 flex items-center';
  titleRight.appendChild(makeCompNode('button', { left: 1380, right: 1412, top: 6, bottom: 32, width: 32, height: 26 }));
  titlebar.appendChild(titleLeft);
  titlebar.appendChild(titleRight);
  body.appendChild(titlebar);

  // 2. Chat composer card at bottom: [+] [Gemini 4 Carbon High ^]  ...  [🛡️ Auto ^] [🎤] [→]
  const composerCard = makeCompNode('div', { left: 220, right: 1120, top: 700, bottom: 848, width: 900, height: 148 });
  composerCard.className = 'rounded-2xl border p-3';
  const editorEl = makeCompNode('textarea', { left: 236, right: 1104, top: 712, bottom: 796, width: 868, height: 84 });
  editorEl.setAttribute('role', 'textbox');
  const toolbarRow = makeCompNode('div', { left: 236, right: 1104, top: 808, bottom: 838, width: 868, height: 30 });
  toolbarRow.className = 'flex items-center justify-between';

  const leftCluster = makeCompNode('div', { left: 236, right: 446, top: 808, bottom: 838, width: 210, height: 30 });
  leftCluster.className = 'flex items-center gap-1';
  const plusBtn = makeCompNode('button', { left: 236, right: 264, top: 810, bottom: 836, width: 28, height: 26 });
  plusBtn.textContent = '+';
  const modelBtn = makeCompNode('button', { left: 270, right: 446, top: 810, bottom: 836, width: 176, height: 26 });
  modelBtn.textContent = 'Gemini 4 Carbon High ^';
  leftCluster.appendChild(plusBtn);
  leftCluster.appendChild(modelBtn);

  const rightCluster = makeCompNode('div', { left: 950, right: 1104, top: 808, bottom: 838, width: 154, height: 30 });
  rightCluster.className = 'flex items-center gap-1.5';
  const autoWrap = makeCompNode('div', { left: 950, right: 1028, top: 810, bottom: 836, width: 78, height: 26 });
  autoWrap.className = 'relative';
  const autoBtn = makeCompNode('button', { left: 950, right: 1028, top: 810, bottom: 836, width: 78, height: 26 });
  const shieldSvg = makeCompNode('svg');
  const shieldTitle = makeCompNode('title');
  shieldTitle.textContent = 'Shield Icon';
  shieldSvg.appendChild(shieldTitle);
  const autoLabel = makeCompNode('span');
  autoLabel.textContent = 'Auto';
  const chevronSvg = makeCompNode('svg');
  autoBtn.appendChild(shieldSvg);
  autoBtn.appendChild(autoLabel);
  autoBtn.appendChild(chevronSvg);
  autoWrap.appendChild(autoBtn);

  const micBtn = makeCompNode('button', { left: 1034, right: 1062, top: 810, bottom: 836, width: 28, height: 26 });
  micBtn.setAttribute('aria-label', 'Voice input');
  const sendBtn = makeCompNode('button', { left: 1068, right: 1100, top: 808, bottom: 838, width: 32, height: 30 });
  sendBtn.setAttribute('aria-label', 'Send message');

  rightCluster.appendChild(autoWrap);
  rightCluster.appendChild(micBtn);
  rightCluster.appendChild(sendBtn);
  toolbarRow.appendChild(leftCluster);
  toolbarRow.appendChild(rightCluster);
  composerCard.appendChild(editorEl);
  composerCard.appendChild(toolbarRow);
  body.appendChild(composerCard);

  const mockSettings = {
    weeklyLimitMode: 'official',
    weeklyTokenBudget: 150000000,
    weeklyCostBudget: 100,
    showUpstreamModel: false,
    orchestratorIdMode: 'compact',
    pluginUpdateMode: 'manual',
    autoUpdatePlugin: false,
    windowMountMode: 'composer',
    enableWindowOverlay: true,
    showTopbarMultiSession: true,
    topbarCapsuleSlots: ['context', 'tps', 'quota_auto'],
  };

  const mockWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    location: { pathname: '/c/cccccccc-1111-2222-3333-dddddddddddd', reload() {} },
    document: mockDocument,
    __AGUsageMonitorBridge: {
      port: 49152,
      token: 'composer-token-456',
      bundleVersion: 'ver-composer-1',
      stylesCss,
      initialTelemetry: {
        uiBundleVersion: 'ver-composer-1',
        settings: { ...mockSettings },
        cloudStatus: { updateAvailable: false, currentPluginVersion: '1.4.5' },
        account: { tierName: 'Google AI Ultra', planName: 'Pro' },
        runningConversations: [],
        conversations: [],
        activeConversation: {
          cascadeId: 'cccccccc-1111-2222-3333-dddddddddddd',
          title: 'Composer Test',
          isRunning: false,
          stepCount: 2,
          latestTokPerSec: 61.5,
          latestTtftSec: 1.4,
          context: { totalTokens: 64000, limitTokens: 256000 },
          recentSteps: [],
          modelBreakdown: [],
        },
        consumption: { session: {}, account: {}, trendSeries: [], monthlySeries: [] },
        quotas: { pools: [], weekly: {} },
        modelBreakdown: [],
      },
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ display: 'flex', flexDirection: 'row', justifyContent: 'flex-start', getPropertyValue: () => '' }),
    fetch: async (url, opts = {}) => {
      if (String(url).includes('/api/settings') && String(opts.method || '').toUpperCase() === 'POST') {
        Object.assign(mockSettings, JSON.parse(opts.body || '{}'));
        return { ok: true, status: 200, json: async () => ({ ...mockSettings }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          uiBundleVersion: 'ver-composer-1',
          settings: { ...mockSettings },
          cloudStatus: { updateAvailable: false, currentPluginVersion: '1.4.5' },
          account: { tierName: 'Google AI Ultra', planName: 'Pro' },
          runningConversations: [],
          conversations: [],
          activeConversation: {
            cascadeId: 'cccccccc-1111-2222-3333-dddddddddddd',
            title: 'Composer Test',
            isRunning: false,
            stepCount: 2,
            latestTokPerSec: 61.5,
            latestTtftSec: 1.4,
            context: { totalTokens: 64000, limitTokens: 256000 },
            recentSteps: [],
            modelBreakdown: [],
          },
          consumption: { session: {}, account: {}, trendSeries: [], monthlySeries: [] },
          quotas: { pools: [], weekly: {} },
          modelBreakdown: [],
        }),
      };
    },
  };
  mockWindow.window = mockWindow;
  mockWindow.globalThis = mockWindow;

  const sandbox = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: mockDocument,
    location: mockWindow.location,
    navigator: {},
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: mockWindow.fetch,
    console,
  });

  vm.runInContext(appJs, sandbox);
  await new Promise((r) => setTimeout(r, 30));

  try {
    const ov = mockWindow.__AGUsageMonitorOverlay;
    assert.ok(ov, 'Overlay registered');
    const capsuleHost = mockDocument.getElementById('ag-usage-monitor-capsule');
    const portalHost = mockDocument.getElementById('ag-usage-monitor-portal');

    // 1. Capsule docks inside rightCluster immediately before autoWrap (to the left of Auto), ignoring SVG <title>
    assert.equal(capsuleHost.getAttribute('data-dock'), 'composer');
    assert.equal(capsuleHost.parentNode, rightCluster);
    assert.equal(capsuleHost.nextElementSibling, autoWrap, 'Capsule sits immediately to the left of Auto wrapper');

    // 2. Switching mode label from "Auto" to "Ask" preserves composer docking next to that mode button
    autoLabel.textContent = 'Ask';
    assert.equal(ov.ensureAlive(), true);
    assert.equal(capsuleHost.getAttribute('data-dock'), 'composer');
    assert.equal(capsuleHost.nextElementSibling, autoWrap);

    // 3. Opening popover when docked at bottom opens UPWARD (.is-above) above capsuleBtn.top (810)
    ov.open();
    const popoverEl = portalHost.shadowRoot.querySelector('.wm-popover-panel');
    assert.ok(popoverEl.classList.contains('is-above'), 'Popover gets upward is-above class');
    const popTop = parseInt(popoverEl.style.top, 10);
    assert.ok(Number.isFinite(popTop) && popTop < 810 - 200, `Popover opens above composer (top=${popTop})`);

    // 4. Live hot-switch inside SettingsView (结构 sub-tab) from composer -> dual moves capsule back to topbar immediately
    const pillTabs = popoverEl.querySelectorAll('.pill-tab');
    pillTabs[pillTabs.length - 1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    const settingsRoot = popoverEl.querySelector('.settings-view-root');
    settingsRoot.querySelector('.settings-subnav-bar').querySelectorAll('.seg-btn')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    const structurePane = settingsRoot.querySelectorAll('.settings-tab-stack')[1];
    const mountSelectEl = structurePane.querySelectorAll('.custom-select')[0];
    mountSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    mountSelectEl.querySelectorAll('.select-option')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(mockSettings.windowMountMode, 'dual');
    assert.equal(capsuleHost.getAttribute('data-dock'), 'flow');
    assert.equal(capsuleHost.parentNode, titleRight, 'Capsule immediately hot-switched back to topbar');
    assert.equal(popoverEl.classList.contains('is-above'), false, 'Popover returns to downward mode in topbar');

    // 5. Also verify flat ml-auto toolbar layout transfers margin-left: auto to capsuleHost and restores on switch
    toolbarRow.removeChild(rightCluster);
    autoWrap.className = 'relative ml-auto';
    autoWrap.style.marginLeft = 'auto';
    toolbarRow.appendChild(autoWrap);
    toolbarRow.appendChild(micBtn);
    toolbarRow.appendChild(sendBtn);

    mountSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    mountSelectEl.querySelectorAll('.select-option')[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(mockSettings.windowMountMode, 'composer');
    assert.equal(capsuleHost.getAttribute('data-dock'), 'composer');
    assert.equal(capsuleHost.getAttribute('data-composer-push'), '1', 'ml-auto transferred to capsuleHost');
    assert.equal(autoWrap.style.marginLeft, '0px', 'Host Auto wrapper marginLeft zeroed while capsule absorbs auto push');
    assert.equal(capsuleHost.nextElementSibling, autoWrap);

    mountSelectEl.querySelector('.select-trigger').dispatchEvent({ type: 'click', stopPropagation() {} });
    mountSelectEl.querySelectorAll('.select-option')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(autoWrap.style.marginLeft, 'auto', 'Host Auto wrapper marginLeft cleanly restored when switching back to dual');
  } finally {
    mockWindow.__AGUsageMonitorOverlay?.dispose();
  }
});

test('Antigravity IDE composer mount mode (输入框挂载) docks inside extensionView iframe (without Auto button) and coordinates workbench.html disposal', async () => {
  // 1. Verify strict target classification for IDE extension chat iframes vs unrelated localhost iframes
  assert.equal(
    isIdeExtensionChatTarget({
      type: 'iframe',
      url: 'http://127.0.0.1:41362/c/a4206937-54dd-4d4e-a161-813719bf7107?extensionView=true',
    }),
    true
  );
  assert.equal(
    isIdeExtensionChatTarget(
      { type: 'iframe', url: 'http://127.0.0.1:41362/?panel=chat' },
      '127.0.0.1:41362'
    ),
    true
  );
  assert.equal(
    isIdeExtensionChatTarget(
      { type: 'iframe', url: 'http://127.0.0.1:53199/sidecar/panel' },
      '127.0.0.1:41362'
    ),
    false,
    'Unrelated localhost sidecar/preview iframe without extensionView or LS hub port must be excluded'
  );

  // 2. Verify compiled app.js inside Antigravity IDE extensionView chat iframe (NO Auto button, only [+] [Model] ... [->])
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  const {
    body,
    document: mockDoc,
    makeElement: makeChatNode,
  } = createMockDom({
    rootRect: { left: 0, right: 980, top: 0, bottom: 900, width: 980, height: 900 },
    defaultRect: { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 },
    resolveRect: (node) =>
      node.id === 'ag-usage-monitor-capsule' || node.classList.contains('wm-capsule-btn')
        ? { left: 680, right: 830, top: 824, bottom: 850, width: 150, height: 26 }
        : null,
  });

  // Header inside IDE chat pane (must NEVER be docked into inside extensionView iframe!)
  const paneHeader = makeChatNode('header', { left: 0, right: 980, top: 0, bottom: 36, width: 980, height: 36 });
  paneHeader.className = '@container/titlebar flex h-9 w-full items-center justify-between';
  body.appendChild(paneHeader);

  // Antigravity IDE Composer Card: outer role="button" focus wrapper + Lexical/Monaco editor + [+] [Gemini 4 Carbon High ^] ... [->]
  const outerFocusCard = makeChatNode('div', { left: 130, right: 882, top: 770, bottom: 862, width: 752, height: 92 });
  outerFocusCard.setAttribute('role', 'button');
  const editorEl = makeChatNode('div', { left: 146, right: 866, top: 782, bottom: 816, width: 720, height: 34 });
  editorEl.setAttribute('contenteditable', 'true');
  editorEl.setAttribute('data-lexical-editor', 'true');

  const toolbarRow = makeChatNode('div', { left: 146, right: 866, top: 822, bottom: 852, width: 720, height: 30 });
  toolbarRow.className = 'flex items-center justify-between';
  const leftCluster = makeChatNode('div', { left: 146, right: 340, top: 822, bottom: 852, width: 194, height: 30 });
  const plusBtn = makeChatNode('button', { left: 146, right: 172, top: 824, bottom: 850, width: 26, height: 26 });
  plusBtn.textContent = '+';
  const modelBtn = makeChatNode('div', { left: 178, right: 336, top: 824, bottom: 850, width: 158, height: 26 });
  modelBtn.setAttribute('aria-haspopup', 'menu');
  modelBtn.textContent = 'Gemini 4 Carbon High';
  leftCluster.appendChild(plusBtn);
  leftCluster.appendChild(modelBtn);

  const rightCluster = makeChatNode('div', { left: 836, right: 866, top: 822, bottom: 852, width: 30, height: 30 });
  const sendBtn = makeChatNode('button', { left: 838, right: 866, top: 823, bottom: 851, width: 28, height: 28 });
  const arrowIcon = makeChatNode('span');
  arrowIcon.className = 'codicon codicon-arrow-right';
  arrowIcon.textContent = 'arrow_forward';
  sendBtn.appendChild(arrowIcon);
  rightCluster.appendChild(sendBtn);

  toolbarRow.appendChild(leftCluster);
  toolbarRow.appendChild(rightCluster);
  outerFocusCard.appendChild(editorEl);
  outerFocusCard.appendChild(toolbarRow);
  body.appendChild(outerFocusCard);

  const ideChatSettings = {
    windowMountMode: 'composer',
    enableWindowOverlay: true,
    showTopbarMultiSession: true,
    topbarCapsuleSlots: ['context', 'tps', 'quota_auto'],
  };

  const chatConvId = 'a4206937-54dd-4d4e-a161-813719bf7107';
  const buildIdeChatTelemetry = () => ({
    uiBundleVersion: 'ver-ide-comp-1',
    settings: { ...ideChatSettings },
    cloudStatus: { updateAvailable: false, currentPluginVersion: '1.4.5' },
    account: { tierName: 'Google AI Ultra', planName: 'Pro' },
    runningConversations: [],
    conversations: [],
    activeConversation: {
      cascadeId: chatConvId,
      title: 'IDE Composer Chat',
      isRunning: false,
      stepCount: 4,
      latestTokPerSec: 55.2,
      latestTtftSec: 1.1,
      context: { totalTokens: 48000, limitTokens: 256000 },
      recentSteps: [],
      modelBreakdown: [],
    },
    consumption: { session: {}, account: {}, trendSeries: [], monthlySeries: [] },
    quotas: { pools: [], weekly: {} },
    modelBreakdown: [],
  });
  const mockWin = {
    innerWidth: 980,
    innerHeight: 900,
    location: {
      pathname: `/c/${chatConvId}`,
      search: '?extensionView=true&extensionVariant=vs-code',
      reload() {},
    },
    document: mockDoc,
    __AGUsageMonitorBridge: {
      port: 49153,
      token: 'ide-chat-tok',
      bundleVersion: 'ver-ide-comp-1',
      mountMode: 'composer',
      hostRouteCascadeId: chatConvId,
      isIdeChatFrame: true,
      stylesCss,
      initialTelemetry: buildIdeChatTelemetry(),
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'space-between',
      getPropertyValue: (k) => (k === '--background' ? '0 0% 9%' : ''),
    }),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => buildIdeChatTelemetry(),
    }),
  };
  mockWin.window = mockWin;
  mockWin.globalThis = mockWin;

  const chatSandbox = vm.createContext({
    window: mockWin,
    globalThis: mockWin,
    document: mockDoc,
    location: mockWin.location,
    navigator: {},
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: mockWin.fetch,
    console,
  });

  vm.runInContext(appJs, chatSandbox);
  await new Promise((r) => setTimeout(r, 30));

  try {
    const ov = mockWin.__AGUsageMonitorOverlay;
    assert.ok(ov, 'Overlay initialized inside IDE extensionView iframe');
    const capsuleHost = mockDoc.getElementById('ag-usage-monitor-capsule');

    // Tier 3: Docks inside rightCluster immediately to the left of [->] send button even with outer role="button" card and no Auto button!
    assert.equal(ov.getDockKind(), 'composer');
    assert.equal(capsuleHost.parentNode, rightCluster);
    assert.equal(capsuleHost.nextElementSibling, sendBtn, 'Capsule docks immediately left of IDE send button');
    assert.equal(capsuleHost.style.display, '');

    // Tier 4: When input is cleared and sendBtn unmounts temporarily, capsule docks cleanly into empty rightCluster
    rightCluster.removeChild(sendBtn);
    assert.equal(ov.ensureAlive(), true);
    assert.equal(ov.getDockKind(), 'composer');
    assert.equal(capsuleHost.parentNode, rightCluster, 'Stays right-aligned in composer toolbar when send button unmounts');

    // Re-adding sendBtn re-anchors capsule immediately before sendBtn
    rightCluster.appendChild(sendBtn);
    assert.equal(ov.ensureAlive(), true);
    assert.equal(capsuleHost.nextElementSibling, sendBtn);

    // Switching mount mode to 'dual' inside extensionView iframe hides iframe capsule immediately (no header/fixed fallback!)
    ov.applyMountMode('dual');
    assert.equal(ov.getDockKind(), 'pending-composer');
    assert.equal(capsuleHost.style.display, 'none');
    assert.notEqual(capsuleHost.parentNode, paneHeader);

    // Switching back to 'composer' restores capsule inside composer immediately
    ov.applyMountMode('composer');
    assert.equal(ov.getDockKind(), 'composer');
    assert.equal(capsuleHost.style.display, '');
    assert.equal(capsuleHost.nextElementSibling, sendBtn);
  } finally {
    mockWin.__AGUsageMonitorOverlay?.dispose();
  }

  // 3. Verify coordinated WB-1 (workbench.html) <-> CHAT-1 (extensionView iframe) orchestration in window-bridge.mjs
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ide-comp-bridge-'));
  const roamingDir = path.join(tmpDir, 'Roaming');
  fs.mkdirSync(path.join(roamingDir, 'Antigravity IDE'), { recursive: true });

  const wbCtx = vm.createContext({
    window: { innerWidth: 1440, innerHeight: 900, location: { pathname: '/' } },
    document: { hidden: false, querySelector: () => null },
  });
  wbCtx.window.window = wbCtx.window;
  wbCtx.window.document = wbCtx.document;

  const chatFrameCtx = vm.createContext({
    window: {
      innerWidth: 960,
      innerHeight: 880,
      location: { pathname: `/c/${chatConvId}`, search: '?extensionView=true' },
    },
    document: { hidden: false, querySelector: () => null },
  });
  chatFrameCtx.window.window = chatFrameCtx.window;
  chatFrameCtx.window.document = chatFrameCtx.document;

  const ctxByTarget = new Map([
    ['WB-1', wbCtx],
    ['CHAT-1', chatFrameCtx],
  ]);

  class CoordinatedMockWS {
    constructor(url) {
      this.targetId = decodeURIComponent(url.split('/').pop());
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.evaluate') {
        const ctx = ctxByTarget.get(this.targetId);
        const value = vm.runInContext(msg.params.expression, ctx);
        queueMicrotask(() =>
          this._emit('message', {
            data: JSON.stringify({ id: msg.id, result: { result: { value } } }),
          })
        );
      }
    }
    close() {}
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }

  const cdpSrv = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const p = cdpSrv.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'WB-1',
            type: 'page',
            url: 'vscode-file://vscode-app/c:/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/WB-1`,
          },
          {
            id: 'WV-1',
            parentId: 'WB-1',
            type: 'iframe',
            url: 'vscode-webview://1234/index.html?purpose=webviewView',
          },
          {
            id: 'CHAT-1',
            parentId: 'WV-1',
            type: 'iframe',
            url: `http://127.0.0.1:41362/c/${chatConvId}?extensionView=true`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/page/CHAT-1`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => cdpSrv.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(roamingDir, 'Antigravity IDE', 'DevToolsActivePort'),
    `${cdpSrv.address().port}\n/devtools/browser/ide-comp`,
    'utf8'
  );

  let activeMountMode = 'dual';
  const mockCoordAppJs = `
    (() => {
      const br = window.__AGUsageMonitorBridge;
      let alive = true;
      let mode = br.initialTelemetry?.settings?.windowMountMode || 'dual';
      const computeDock = () => {
        if (br.isIdeChatFrame) {
          return mode === 'composer' && window.innerWidth > 80 ? 'composer' : 'pending-composer';
        }
        return 'ide-titlebar';
      };
      window.__AGUsageMonitorOverlay = {
        bundleVersion: br.bundleVersion,
        ensureAlive: () => alive,
        getDockKind: () => computeDock(),
        getMountMode: () => mode,
        applyMountMode: (next) => { mode = next; return alive; },
        dispose: () => { alive = false; },
      };
    })();
  `;

  const bridgeCtrl = createWindowBridgeController({
    handleApiRequest: async () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        settings: {
          windowMountMode: activeMountMode,
          enableWindowOverlay: activeMountMode !== 'sidebar',
        },
      }),
    }),
    readAssetFn: async (rel) => (rel === 'styles.css' ? ':host{}' : mockCoordAppJs),
    getSettingsFn: () => ({
      windowMountMode: activeMountMode,
      enableWindowOverlay: activeMountMode !== 'sidebar',
    }),
    getBundleVersionFn: () => 'coord-v1',
    env: { APPDATA: roamingDir, LOCALAPPDATA: tmpDir },
    platform: 'win32',
    homeDir: tmpDir,
    WebSocketImpl: CoordinatedMockWS,
  });

  try {
    // Phase A: 'dual' mode -> WB-1 injected, CHAT-1 NOT injected
    await bridgeCtrl.syncAllWindows();
    assert.equal(Boolean(wbCtx.window.__AGUsageMonitorOverlay), true, 'WB-1 mounted in dual mode');
    assert.equal(Boolean(chatFrameCtx.window.__AGUsageMonitorOverlay), false, 'CHAT-1 untouched in dual mode');

    // Phase B: Switch to 'composer' mode -> CHAT-1 mounted in composer, WB-1 disposed (zero duplicate capsules!)
    activeMountMode = 'composer';
    await bridgeCtrl.notifySettingChanged(true);
    assert.equal(Boolean(chatFrameCtx.window.__AGUsageMonitorOverlay), true, 'CHAT-1 mounted in composer mode');
    assert.equal(chatFrameCtx.window.__AGUsageMonitorOverlay.getDockKind(), 'composer');
    assert.equal(Boolean(wbCtx.window.__AGUsageMonitorOverlay), false, 'WB-1 titlebar capsule disposed while CHAT-1 composer is active');

    // Verify dynamic Origin whitelist allows CHAT-1's http://127.0.0.1:41362 origin while rejecting unassociated http://127.0.0.1:59999
    const { port, token } = bridgeCtrl.getBridgeInfo();
    const chatOriginOk = await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
      headers: { Origin: 'http://127.0.0.1:41362', 'X-Usage-Monitor-Token': token },
    });
    assert.equal(chatOriginOk.status, 200);
    const randomHttpOrigin = await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
      headers: { Origin: 'http://127.0.0.1:59999', 'X-Usage-Monitor-Token': token },
    });
    assert.equal(randomHttpOrigin.status, 403);

    // Phase C: Chat pane collapsed (innerWidth = 0) -> WB-1 automatically mounts back as fallback!
    chatFrameCtx.window.innerWidth = 0;
    await bridgeCtrl.syncAllWindows();
    assert.equal(Boolean(wbCtx.window.__AGUsageMonitorOverlay), true, 'WB-1 mounts as fallback when IDE chat pane is collapsed');

    // Chat pane reopened -> WB-1 disposed again
    chatFrameCtx.window.innerWidth = 960;
    await bridgeCtrl.syncAllWindows();
    assert.equal(Boolean(wbCtx.window.__AGUsageMonitorOverlay), false);

    // Phase D: Switch back to 'dual' mode -> CHAT-1 disposed, WB-1 mounted
    activeMountMode = 'dual';
    await bridgeCtrl.notifySettingChanged(true);
    assert.equal(Boolean(chatFrameCtx.window.__AGUsageMonitorOverlay), false, 'CHAT-1 disposed on switch back to dual');
    assert.equal(Boolean(wbCtx.window.__AGUsageMonitorOverlay), true, 'WB-1 mounted on switch back to dual');

    // Phase E: Switch to 'sidebar' -> both disposed
    activeMountMode = 'sidebar';
    await bridgeCtrl.notifySettingChanged(false);
    assert.equal(Boolean(chatFrameCtx.window.__AGUsageMonitorOverlay), false);
    assert.equal(Boolean(wbCtx.window.__AGUsageMonitorOverlay), false);
  } finally {
    await bridgeCtrl.stop({ disposeWindows: true });
    await new Promise((resolve) => cdpSrv.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step table semantic tone classes (speed/cache/ttft/cost) and domain-aligned overview metric subtexts', () => {
  // 1. Speed 4-tier + muted semantic grading
  assert.equal(getSpeedToneClass(null), 'tone-muted');
  assert.equal(getSpeedToneClass(0), 'tone-muted');
  assert.equal(getSpeedToneClass(86.1), 'tone-good');
  assert.equal(getSpeedToneClass(54.9), 'tone-info');
  assert.equal(getSpeedToneClass(24.3), 'tone-warn');
  assert.equal(getSpeedToneClass(7.6), 'tone-danger');

  // 2. Cache hit 4-tier + 0-prompt muted grading
  assert.equal(getCacheToneClass(null), 'tone-muted');
  assert.equal(getCacheToneClass(0, 0), 'tone-muted');
  assert.equal(getCacheToneClass(0, 208700), 'tone-danger');
  assert.equal(getCacheToneClass(59.8, 75400), 'tone-warn');
  assert.equal(getCacheToneClass(77.6, 96400), 'tone-info');
  assert.equal(getCacheToneClass(96.8, 155212), 'tone-good');

  // 3. Step cost & TTFT alert grading
  assert.equal(getStepCostToneClass(0.056), '');
  assert.equal(getStepCostToneClass(0.18), 'tone-warn');
  assert.equal(getStepCostToneClass(0.421), 'tone-danger');
  assert.equal(getTtftToneClass(12.1), '');
  assert.equal(getTtftToneClass(22.3), 'tone-warn');
  assert.equal(getTtftToneClass(34.0), 'tone-danger');

  // 4. Overview metric cells: current step in primary value, strictly domain-aligned subtexts
  setI18nLanguage('zh-CN');
  const mockActive = {
    stepCount: 787,
    isRunning: false,
    activeAgentBadge: '主',
    activeModelShort: 'gemini-4-carbon',
    latestTokPerSec: 54.9,
    latestTtftSec: 12.1,
    ttftSummary: { avgSec: 14.4 },
    avgTokPerSec: 57.3,
    speedSummary: { sampleCount: 787, excludedCount: 0 },
    latestStepCostUsd: 0.056,
    sessionCostUsd: 46.9,
    sessionUnpricedCalls: 0,
    latestCacheHitPct: 96.8,
    sessionCacheHitPct: 92.4,
    latestPromptTokens: 155212,
    inputTokens: 1_200_000,
    cacheReadTokens: 23_900_000,
    outputTokens: 400_000,
    totalTokens: 25_500_000,
    context: { totalTokens: 158328, compactionLimitTokens: 256000, limitTokens: 256000 },
  };
  const mockQuotas = {
    activePool: {
      poolLabel: 'Carbon',
      family: 'Carbon',
      remainingPct: 42,
      weeklyRemainingPct: 85,
    },
  };

  const stepCostCell = resolveOverviewMetricCell('step_cost', {
    active: mockActive,
    hasSubagents: true,
  });
  assert.equal(stepCostCell.valueText, '$0.056');
  assert.equal(stepCostCell.subText, '累计 $46.90', 'No unrelated cache % inside 本次费用');
  assert.equal(stepCostCell.subClass, 'cell-sub', 'Neutral subtext color instead of green accent-ok');

  const sessCostCell = resolveOverviewMetricCell('session_cost', {
    active: mockActive,
    hasSubagents: true,
  });
  assert.equal(sessCostCell.valueText, '$46.90');
  assert.equal(sessCostCell.subText, '本次 $0.056', 'No unrelated cache % inside 累计费用');
  assert.equal(sessCostCell.subClass, 'cell-sub');

  const cacheCell = resolveOverviewMetricCell('cache_hit', {
    active: mockActive,
    hasSubagents: true,
  });
  assert.equal(cacheCell.valueText, '96.8%', 'Current step cache hit shown as primary big value');
  assert.equal(cacheCell.valueClass, 'cell-value tone-good');
  assert.equal(cacheCell.subText, '均值 92.4%', 'Session average shown cleanly in subtext without repetition');

  const coldCacheCell = resolveOverviewMetricCell('cache_hit', {
    active: { ...mockActive, latestCacheHitPct: 0, latestPromptTokens: 208700 },
  });
  assert.equal(coldCacheCell.valueText, '0%');
  assert.equal(coldCacheCell.valueClass, 'cell-value tone-danger', '0% cold cache miss turns danger red');

  const tokCell = resolveOverviewMetricCell('session_tokens', { active: mockActive });
  assert.equal(tokCell.valueText, '25.5M');
  assert.equal(tokCell.subText, '入 25.1M · 出 400.0k');

  const quotaCell = resolveOverviewMetricCell('quota_tightest', {
    active: mockActive,
    quotas: mockQuotas,
  });
  assert.equal(quotaCell.valueText, '余 42%');
  assert.equal(quotaCell.subText, 'Carbon 5h · 周 85%', 'Identifies pool/window without repeating 余 42%');

  const avgTpsCell = resolveOverviewMetricCell('avg_tps', { active: mockActive });
  assert.equal(avgTpsCell.valueClass, 'cell-value tone-info', 'avg_tps 57.3 tok/s uses same speed tone-info');

  // 5. Capsule metric slots strictly match overview/hover/steps semantic tones
  const capBaseCtx = {
    hasTelemetry: true,
    usedPct: 55.8,
    dashOffset: 14,
    isRunning: false,
    tps: 43.7,
    avgTps: 57.3,
    ttft: 22.3,
    stepCost: 0.198,
    sessionCost: 46.9,
    cacheHitPct: 98.5,
    latestPromptTokens: 155212,
    sessionTokens: 25_500_000,
    quotas: mockQuotas,
  };
  assert.equal(
    resolveCapsuleMetricPresentation('tps', capBaseCtx, 32.67).toneClass,
    'tone-info',
    'Idle capsule 43.7 t/s matches hover card tone-info cyan'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('tps', { ...capBaseCtx, isRunning: true, tps: 68.4 }, 32.67).toneClass,
    'tone-good',
    'Running capsule 68.4 t/s matches overview/hover tone-good green instead of legacy orange'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('avg_tps', capBaseCtx, 32.67).toneClass,
    'tone-info'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('cache_hit', capBaseCtx, 32.67).toneClass,
    'tone-good',
    'Capsule cache_hit 98.5% matches hover card tone-good green'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('cache_hit', { ...capBaseCtx, cacheHitPct: 77.6 }, 32.67).toneClass,
    'tone-info'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('ttft', capBaseCtx, 32.67).toneClass,
    'tone-warn',
    'Capsule ttft 22.3s uses unified >=18s tone-warn threshold'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('ttft', { ...capBaseCtx, ttft: 16.0 }, 32.67).toneClass,
    '',
    'Capsule ttft 16.0s stays neutral (<18s) matching overview/step table'
  );
  assert.equal(
    resolveCapsuleMetricPresentation('cost', capBaseCtx, 32.67).toneClass,
    'tone-warn',
    'Capsule step cost $0.198 matches tone-warn'
  );
});

test('Headless CLI LS discovery reads daemon/hub_*.json without subprocesses and falls back to Linux /proc + ss without lsof', async () => {
  // 1. CLI command line parsing covers agy remote-control serve & antigravity-cli
  const rcParsed = parseLsArgsFromCommandLine(
    '/home/ubuntu/.local/bin/agy remote-control serve --http-port=43120 --csrf-token rc-token-99'
  );
  assert.equal(rcParsed.isHub, true);
  assert.equal(rcParsed.hubPort, 43120);
  assert.equal(rcParsed.csrfToken, 'rc-token-99');

  const cliBinParsed = parseLsArgsFromCommandLine(
    '/usr/local/bin/antigravity-cli --hub --hub-port 51200 --csrf_token=cli-tok'
  );
  assert.equal(cliBinParsed.isHub, true);
  assert.equal(cliBinParsed.hubPort, 51200);
  assert.equal(cliBinParsed.csrfToken, 'cli-tok');

  // 2. Stage 1: daemon/hub_*.json zero-subprocess discovery skips dead PIDs and prefers plain HTTP port
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-um-daemon-test-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'hub_dead.json'),
      JSON.stringify({
        pid: 99991,
        httpPort: 19001,
        httpsPort: 19000,
        csrfToken: 'dead-token',
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'hub_13019.json'),
      JSON.stringify({
        pid: 42424,
        httpPort: 13019,
        httpsPort: 13018,
        lsVersion: '2.32.1',
        csrfToken: 'live-hub-token',
      }),
      'utf8'
    );

    let subprocessCalled = false;
    const probedUrls = [];
    const foundViaDaemon = await discoverAntigravityLsEndpoint({
      platform: 'linux',
      daemonDirs: [tmpDir],
      isPidAliveFn: (pid) => pid === 42424,
      execCmdFn: async () => {
        subprocessCalled = true;
        return '';
      },
      fetchFn: async (url, init) => {
        probedUrls.push({ url, token: init?.headers?.['x-codeium-csrf-token'] });
        return { ok: url.startsWith('http://127.0.0.1:13019/') };
      },
    });

    assert.equal(subprocessCalled, false, 'daemon/hub_*.json hits without spawning ps/ss/lsof');
    assert.equal(probedUrls.length, 1, 'Dead PID hub_dead.json skipped; httpPort probed first');
    assert.equal(foundViaDaemon?.addr, '127.0.0.1:13019');
    assert.equal(foundViaDaemon?.baseUrl, 'http://127.0.0.1:13019');
    assert.equal(foundViaDaemon?.csrfToken, 'live-hub-token');
    assert.equal(foundViaDaemon?.pid, 42424);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. Linux /proc/<pid>/fd + /proc/net/tcp parser (0xA4D3 = 42195, state 0A = LISTEN)
  const tcpSample = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:A4D3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 554433 1 0 100 0',
    '   1: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 554434 1 0 100 0',
  ].join('\n');
  assert.deepEqual(parseLinuxProcNetTcpPorts(tcpSample, new Set(['554433', '554434'])), [42195]);

  const foundViaProcFs = await discoverAntigravityLsEndpoint({
    platform: 'linux',
    daemonDirs: [],
    procFs: {
      existsSync: (p) => p === '/proc/7788/fd' || p === '/proc/7788/net/tcp',
      readdirSync: (p) => (p === '/proc/7788/fd' ? ['3', '4'] : []),
      readlinkSync: (p) => (p === '/proc/7788/fd/4' ? 'socket:[554433]' : '/dev/null'),
      readFileSync: () => tcpSample,
    },
    execCmdFn: async (cmd) => {
      if (cmd === 'ps') {
        return '7788 1 /opt/agy/language_server_linux_x64 --csrf_token proc-tok-1\n';
      }
      throw new Error(`Unexpected command ${cmd}`);
    },
    fetchFn: async (url, init) => ({
      ok:
        url.startsWith('http://127.0.0.1:42195/') &&
        init?.headers?.['x-codeium-csrf-token'] === 'proc-tok-1',
    }),
  });
  assert.equal(foundViaProcFs?.addr, '127.0.0.1:42195');
  assert.equal(foundViaProcFs?.csrfToken, 'proc-tok-1');

  // 4. Linux ss -H -lntp fallback when /proc net is restricted and lsof is not installed
  const ssSample =
    'LISTEN 0 4096 127.0.0.1:38899 0.0.0.0:* users:(("language_server",pid=8899,fd=7))\n';
  assert.deepEqual(parseSsListeningPorts(ssSample, 8899), [38899]);
});

test('Standalone Web server enforces loopback/non-loopback security boundaries, serves full assets, and supports token cookie/Bearer auth', async () => {
  // 1. CLI arg & host boundary validation
  assert.equal(isLoopbackBindHost('127.0.0.1'), true);
  assert.equal(isLoopbackBindHost('localhost'), true);
  assert.equal(isLoopbackBindHost('::1'), true);
  assert.equal(isLoopbackBindHost('[::1]'), true);
  assert.equal(isLoopbackBindHost('0.0.0.0'), false);
  assert.equal(isLoopbackBindHost('192.168.1.25'), false);

  const parsedArgs = parseStandaloneCliArgs(
    ['--port', '9090', '--host=0.0.0.0', '--token', 's3cr3t'],
    {}
  );
  assert.equal(parsedArgs.port, 9090);
  assert.equal(parsedArgs.host, '0.0.0.0');
  assert.equal(parsedArgs.token, 's3cr3t');

  // Refuse non-loopback bind without --token
  assert.throws(
    () => createStandaloneWebServer({ host: '0.0.0.0', port: 0, skipStartupDiscovery: true }),
    /Refusing to bind standalone server to non-loopback host "0\.0\.0\.0" without --token/
  );

  // 2. Default 127.0.0.1 loopback server (ssh -L friendly, blocks cross-site & DNS rebinding)
  const loopSrv = createStandaloneWebServer({
    host: '127.0.0.1',
    port: 0,
    skipStartupDiscovery: true,
    readAssetFn: async (rel) => `ASSET:${rel}`,
    handleApiRequest: async (pathname, method, data) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pathname, method, data }),
    }),
  });

  try {
    const st = await loopSrv.start();
    assert.equal(st.running, true);
    assert.ok(st.port > 0);
    assert.equal(st.loopbackOnly, true);
    assert.equal(st.tokenProtected, false);

    const indexRes = await fetch(`${st.url}/`);
    assert.equal(indexRes.status, 200);
    assert.equal(await indexRes.text(), 'ASSET:index.html');

    const preloadRes = await fetch(`${st.url}/preload.js`);
    assert.equal(preloadRes.status, 200);
    assert.match(await preloadRes.text(), /standalone web mode/);

    const apiRes = await fetch(`${st.url}/api/telemetry?range=today`);
    assert.equal(apiRes.status, 200);
    const apiJson = await apiRes.json();
    assert.deepEqual(apiJson, {
      ok: true,
      pathname: '/api/telemetry',
      method: 'GET',
      data: { range: 'today' },
    });

    // Cross-site Origin blocked with 403
    const crossSiteRes = await fetch(`${st.url}/api/telemetry`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossSiteRes.status, 403);

    // DNS rebinding Host header blocked with 403
    const rebindStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: st.port,
          path: '/api/telemetry',
          method: 'GET',
          headers: { Host: `attacker.rebind.test:${st.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebindStatus, 403);
  } finally {
    await loopSrv.stop();
  }

  // 3. Token-protected mode (--token): 401 prompt, ?token= 302 -> HttpOnly cookie, Bearer header, and cross-origin POST block
  const tokenSrv = createStandaloneWebServer({
    host: '127.0.0.1',
    port: 0,
    token: 'cli-remote-secret',
    skipStartupDiscovery: true,
    readAssetFn: async (rel) => `PROTECTED:${rel}`,
    handleApiRequest: async (pathname, method, data) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pathname, method, data }),
    }),
  });

  try {
    const st = await tokenSrv.start();
    assert.equal(st.tokenProtected, true);

    // Unauthenticated browser GET / -> 401 HTML login form
    const unauthPage = await fetch(`${st.url}/`);
    assert.equal(unauthPage.status, 401);
    assert.match(await unauthPage.text(), /standalone-auth/);

    // Unauthenticated API -> 401 JSON
    const unauthApi = await fetch(`${st.url}/api/telemetry`);
    assert.equal(unauthApi.status, 401);

    // Bearer header works directly
    const bearerApi = await fetch(`${st.url}/api/telemetry?range=week`, {
      headers: { Authorization: 'Bearer cli-remote-secret' },
    });
    assert.equal(bearerApi.status, 200);

    // Browser GET /?token=cli-remote-secret sets HttpOnly cookie and 302 redirects to clean /
    const loginRedirect = await fetch(`${st.url}/?token=cli-remote-secret`, {
      redirect: 'manual',
    });
    assert.equal(loginRedirect.status, 302);
    assert.equal(loginRedirect.headers.get('location'), '/');
    const setCookie = loginRedirect.headers.get('set-cookie') || '';
    assert.match(setCookie, /ag_um_token=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\//);
    const cookiePair = setCookie.split(';')[0];

    // Cookie authenticates same-origin GET and POST, but blocks cross-origin POST CSRF
    const authedPage = await fetch(`${st.url}/`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(authedPage.status, 200);
    assert.equal(await authedPage.text(), 'PROTECTED:index.html');

    const csrfPost = await fetch(`${st.url}/api/settings`, {
      method: 'POST',
      headers: {
        Cookie: cookiePair,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'en-US' }),
    });
    assert.equal(csrfPost.status, 403);

    const validPost = await fetch(`${st.url}/api/settings`, {
      method: 'POST',
      headers: {
        Cookie: cookiePair,
        Origin: st.url,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'en-US' }),
    });
    assert.equal(validPost.status, 200);
  } finally {
    await tokenSrv.stop();
  }
});

test('v1.5 feedback E2E: sticky bridge port/token across hot-reloads, CDP->HTTP self-healing, trimmed raw model IDs, non-truncating compaction suffix, custom token combo DSL, and adaptive popover width', async () => {
  const stickyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wm-sticky-'));
  const leaseFile = path.join(stickyDir, 'window-bridge-lease.json');

  // 1. Verify sticky port + token across window-bridge restarts & /api/cache/rebuild support
  const makeCtrl = () =>
    createWindowBridgeController({
      leaseFilePath: leaseFile,
      getSettingsFn: () => ({ enableWindowOverlay: true, windowMountMode: 'dual' }),
      getBundleVersionFn: () => 'v-sticky-1',
      readAssetFn: async () => '',
      handleApiRequest: async (pathname, method) => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, pathname, method }),
      }),
    });

  const ctrl1 = makeCtrl();
  let ctrl2 = null;
  try {
    const info1 = await ctrl1.ensureBridgeServer();
    assert.ok(info1.port >= 1024 && info1.token.length === 64);

    // /api/cache/rebuild is allowed over loopback bridge
    const rebuildRes = await fetch(`http://127.0.0.1:${info1.port}/api/cache/rebuild`, {
      method: 'POST',
      headers: {
        Origin: 'https://127.0.0.1:55111',
        'Content-Type': 'application/json',
        'X-Usage-Monitor-Token': info1.token,
      },
      body: '{}',
    });
    assert.equal(rebuildRes.status, 200);
    assert.equal((await rebuildRes.json()).pathname, '/api/cache/rebuild');

    // Stop ctrl1 (simulating hot-reload) and start ctrl2 -> rebinds exact same port & token!
    await ctrl1.stop();
    ctrl2 = makeCtrl();
    const info2 = await ctrl2.ensureBridgeServer();
    assert.equal(info2.port, info1.port, 'Hot-reloaded bridge reuses exact previous port');
    assert.equal(info2.token, info1.token, 'Hot-reloaded bridge reuses exact previous token');
  } finally {
    await ctrl1.stop().catch(() => {});
    if (ctrl2) await ctrl2.stop().catch(() => {});
    fs.rmSync(stickyDir, { recursive: true, force: true });
  }

  // 2. Verify frontend formatters, non-truncating compaction cell, custom token combo, trimmed model ID, adaptive width & CDP recovery
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(stylesCss, /\.step-model-compact\s*\{[^}]*flex-shrink:\s*0;/, 'Compaction suffix never shrinks/truncates');
  assert.match(stylesCss, /\.wm-popover-panel\s*\{[^}]*--wm-popover-w,\s*540px/, 'Popover supports dynamic CSS width variable');

  const savedSettings = {
    language: 'zh-CN',
    windowMountMode: 'dual',
    enableWindowOverlay: true,
    popoverWidthMode: 'auto',
    popoverWidth: 580,
    modelDisplayMode: 'upstream_compact',
    showUpstreamModel: true,
    orchestratorIdMode: 'compact',
    stepTokenComboFormat: 'context:in:cache',
    stepTableColumns: ['step', 'model', 'tps', 'tokens_io_cache', 'tokens_custom', 'cost'],
  };

  const buildMockPayload = () => ({
    uiBundleVersion: 'ver-v15',
    settings: { ...savedSettings },
    cloudStatus: { currentPluginVersion: '1.5.0', latestPluginVersion: '1.5.0', updateAvailable: false },
    account: { planName: 'Google AI Ultra' },
    quotas: { activePool: { remainingPct: 62 }, pools: [], weekly: {} },
    runningConversations: [],
    conversations: [{ cascadeId: '11111111-2222-3333-4444-555555555555', title: 'v1.5 Test', stepCount: 3 }],
    activeConversation: {
      cascadeId: '11111111-2222-3333-4444-555555555555',
      title: 'v1.5 Test',
      isRunning: false,
      stepCount: 3,
      latestTokPerSec: 140.6,
      latestTtftSec: 1.2,
      context: { totalTokens: 50000, compactionLimitTokens: 256000, limitTokens: 256000 },
      recentSteps: [
        {
          stepIndex: 51,
          isCompactionStep: true,
          modelShort: 'hydrogen-4·压缩',
          modelLabel: 'Gemini 4 Hydrogen [自动压缩]',
          modelUpstream: 'gemini-4-hydrogen·压缩',
          tokPerSec: 191.3,
          ttftSec: null,
          contextTokens: 133100,
          inputTokens: 2500,
          cacheReadTokens: 128000,
          outputTokens: 2600,
          thinkingTokens: 698,
          responseTokens: 1902,
          cacheHitPct: 98.1,
          costUsd: 0.042,
          inCostUsd: 0.0038,
          cacheCostUsd: 0.0192,
          outCostUsd: 0.0195,
          createdAtMs: 1794800051000,
        },
        {
          stepIndex: 50,
          isCompactionStep: false,
          modelShort: 'sonnet',
          modelLabel: 'Claude Sonnet 4.6',
          modelUpstream: 'claude-sonnet-4-6',
          tokPerSec: 84.0,
          ttftSec: 1.4,
          contextTokens: 60000,
          inputTokens: 10000,
          cacheReadTokens: 49000,
          outputTokens: 1000,
          thinkingTokens: 200,
          responseTokens: 800,
          cacheHitPct: 83.1,
          costUsd: 0.059,
          inCostUsd: 0.03,
          cacheCostUsd: 0.0147,
          outCostUsd: 0.015,
          createdAtMs: 1794800020000,
        },
        {
          stepIndex: 49,
          isCompactionStep: false,
          modelShort: 'gpt-5.4-mini',
          modelLabel: 'GPT 5.4 Mini',
          modelUpstream: 'gpt-5.4-mini',
          tokPerSec: 112.0,
          ttftSec: 0.9,
          contextTokens: 40000,
          inputTokens: 5000,
          cacheReadTokens: 34000,
          outputTokens: 1000,
          thinkingTokens: 100,
          responseTokens: 900,
          cacheHitPct: 87.2,
          costUsd: 0.011,
          inCostUsd: 0.0038,
          cacheCostUsd: 0.0026,
          outCostUsd: 0.0045,
          createdAtMs: 1794800000000,
        },
      ],
      agents: [],
    },
    consumption: {
      selectedRange: { key: 'today', label: '今天', startMs: 1, endMs: 2 },
      session: {},
      account: {},
      trendSeries: [],
      monthlySeries: [],
    },
    modelBreakdown: [],
  });

  const {
    body,
    document: mockDoc,
  } = createMockDom({
    resolveRect: (el) => {
      const w = Number.parseFloat(el.style.width) || el.offsetWidth || 120;
      return { left: 900, right: 900 + w, top: 8, bottom: 36, width: w, height: 28 };
    },
  });
  let failHttpOnce = false;
  const mockWin = {
    innerWidth: 1280,
    innerHeight: 820,
    location: { pathname: '/c/11111111-2222-3333-4444-555555555555', search: '' },
    __AGUsageMonitorBridge: {
      port: 43111,
      token: 'a'.repeat(64),
      bundleVersion: 'ver-v15',
      stylesCss,
      initialTelemetry: buildMockPayload(),
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '', display: 'flex', flexDirection: 'row' }),
    fetch: async (_url, opts) => {
      if (failHttpOnce) {
        throw new TypeError('Connection refused during transient restart');
      }
      if (opts?.method === 'POST' && opts?.body) {
        Object.assign(savedSettings, JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ...savedSettings }) };
      }
      return { ok: true, status: 200, json: async () => buildMockPayload() };
    },
  };

  const sandbox = {
    window: mockWin,
    document: mockDoc,
    navigator: { language: 'zh-CN' },
    URLSearchParams,
    AbortController,
    queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    RegExp,
    Error,
    TypeError,
    parseFloat,
    parseInt,
    isNaN,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(appJs, sandbox);

  const ov = mockWin.__AGUsageMonitorOverlay;
  assert.ok(ov, 'Overlay mounted');
  try {
    ov.open();
    const portalHost = mockDoc.getElementById('ag-usage-monitor-portal');
    const popEl = portalHost.shadowRoot.querySelector('.wm-popover-panel');
    assert.equal(popEl.style.width, '540px', 'Base overview width starts at 540px');

    // Switch to Steps tab (index 2 of top pill nav)
    const navPills = popEl.querySelectorAll('.pill-tab');
    const tableViewport = popEl.querySelector('.table-viewport.is-step-table');
    const stepTable = tableViewport.querySelector('.steps-data-table');
    tableViewport.clientWidth = 506;
    popEl.offsetWidth = 540;
    stepTable.scrollWidth = 660;
    stepTable.offsetWidth = 660;

    navPills[2].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 25));

    // Adaptive width expands popover to fit wide 660px table (+ 34px chrome + 4px buffer = 698px)
    assert.equal(popEl.style.width, '698px', 'Popover adaptively widens on wide step table to eliminate horizontal scroll');

    // Verify trimmed raw IDs (hiding gemini-, claude-, gpt-) AND non-truncating compaction suffix
    const bodyRows = stepTable.querySelector('tbody').querySelectorAll('tr');
    assert.equal(bodyRows.length, 3);

    const row0ModelName = bodyRows[0].querySelector('.step-model-name').textContent;
    const row0Compact = bodyRows[0].querySelector('.step-model-compact');
    assert.equal(row0ModelName, '4-hydrogen', 'Strips gemini- prefix from gemini-4-hydrogen');
    assert.equal(row0Compact.hasAttribute('hidden'), false, 'Compaction badge visible as dedicated flex-shrink:0 span');
    assert.equal(row0Compact.textContent, '·压缩', 'Compaction suffix never merged into ellipsized span');
    assert.equal(bodyRows[0].children[1].getAttribute('title'), 'gemini-4-hydrogen·压缩', 'Hover title keeps full upstream ID');

    assert.equal(bodyRows[1].querySelector('.step-model-name').textContent, 'sonnet-4-6', 'Strips claude- prefix');
    assert.equal(bodyRows[1].querySelector('.step-model-compact').hasAttribute('hidden'), true);
    assert.equal(bodyRows[2].querySelector('.step-model-name').textContent, '5.4-mini', 'Strips gpt- prefix');

    // Verify In / Out / Cache column & Custom Combo column ('context:in:cache')
    const ths = stepTable.querySelector('thead').querySelectorAll('th');
    assert.equal(ths[3].textContent, '输入 / 输出 / 缓存');
    assert.equal(ths[4].textContent, '上下文 / 输入 / 缓存');
    assert.equal(bodyRows[0].children[3].children[0].textContent, '2.5k / 2.6k / 128.0k');
    assert.equal(
      bodyRows[0].children[3].getAttribute('title'),
      '新输入 2,500 ($0.004) · 输出 2,600 ($0.019) · 缓存读 128,000 ($0.019)'
    );
    assert.equal(bodyRows[0].children[4].children[0].textContent, '133.1k / 2.5k / 128.0k');

    // Switch back to Live Overview -> popover smoothly shrinks back to 540px
    navPills[0].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(popEl.style.width, '540px', 'Popover returns to 540px base width when leaving wide step table');

    // Verify p0-1 updateBridge resets poisoned 'cdp' transportMode back to 'http' immediately
    failHttpOnce = true;
    mockWin.location.pathname = '/c/99999999-2222-3333-4444-555555555555';
    ov.syncHostRoute();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mockWin.__AGUsageMonitorBridge.transportMode, 'cdp');
    failHttpOnce = false;
    ov.updateBridge({ port: 43222, token: 'b'.repeat(64) });
    assert.equal(mockWin.__AGUsageMonitorBridge.transportMode, 'http', 'updateBridge immediately heals transportMode back to http');
  } finally {
    ov.dispose();
  }
});

test('WindowOverlayShell macOS (darwin) adaptation: sets data-os="mac", uses 12px fixed right fallback, and reserves 80px for traffic lights', async () => {
  const panelDir = path.resolve(import.meta.dirname, '..');
  const appJs = fs.readFileSync(path.join(panelDir, 'app.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(panelDir, 'styles.css'), 'utf8');
  assert.match(stylesCss, /:host\(\.wm-capsule-host\[data-dock="fixed"\]\[data-os="mac"\]\)\s*\{\s*right:\s*12px;/);

  function runOverlayForPlatform(platformKey, { withTitlebar = false, auxLeft = 0, winWidth = 1280 } = {}) {
    const {
      body,
      document: mockDoc,
      makeElement: makeNode,
    } = createMockDom({
      defaultRect: { left: 0, right: 64, top: 6, bottom: 34, width: 64, height: 28 },
    });

    if (withTitlebar) {
      const tb = makeNode('div');
      tb.className = 'flex @container/titlebar';
      tb.setRect({ left: 0, right: winWidth, top: 0, bottom: 36, width: winWidth, height: 36 });
      const titleGroup = makeNode('div');
      const rightGroup = makeNode('div');
      rightGroup.className = 'shrink-0';
      const siblingBtn = makeNode('button');
      siblingBtn.setRect({ left: winWidth - 56, right: winWidth, top: 4, bottom: 32, width: 56, height: 28 });
      rightGroup.appendChild(siblingBtn);
      tb.appendChild(titleGroup);
      tb.appendChild(rightGroup);
      body.appendChild(tb);
    } else if (auxLeft > 0) {
      const auxBtn = makeNode('button');
      auxBtn.setAttribute('data-testid', 'toggle-aux-sidebar');
      auxBtn.setRect({ left: auxLeft, right: auxLeft + 28, top: 8, bottom: 34, width: 28, height: 26 });
      body.appendChild(auxBtn);
    }

    const payload = {
      timestamp: '2026-11-17T00:00:00Z',
      hostPlatform: platformKey,
      settings: { windowMountMode: 'dual', enableWindowOverlay: true, showTopbarMultiSession: true, topbarCapsuleSlots: ['tps', 'ttft', 'context'] },
      cloudStatus: { updateAvailable: false },
      account: { planName: 'Pro' },
      runningConversations: [],
      conversations: [],
      activeConversation: { cascadeId: '11111111-2222-3333-4444-555555555555', stepCount: 1, context: { totalTokens: 10000, limitTokens: 256000 } },
      quotas: { pools: [] },
    };

    const mockWin = {
      innerWidth: winWidth,
      innerHeight: 800,
      location: { pathname: '/c/11111111-2222-3333-4444-555555555555', search: '' },
      __AGUsageMonitorBridge: {
        port: 43111,
        token: 'c'.repeat(64),
        bundleVersion: 'ver-mac',
        platform: platformKey,
        stylesCss,
        initialTelemetry: payload,
      },
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle: () => ({ paddingRight: '8px', getPropertyValue: () => '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    };
    const sb = {
      window: mockWin,
      document: mockDoc,
      navigator: { language: 'zh-CN', platform: platformKey === 'darwin' ? 'MacIntel' : 'Win32' },
      URLSearchParams,
      AbortController,
      queueMicrotask,
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      cancelAnimationFrame: clearTimeout,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Promise,
      Math,
      Date,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      RegExp,
      Error,
      TypeError,
      parseFloat,
      parseInt,
      isNaN,
      Infinity,
    };
    sb.globalThis = sb;
    vm.runInNewContext(appJs, sb);
    const cap = body._foundCap || (function findCap(n) {
      if (n.id === 'ag-usage-monitor-capsule') return n;
      for (const c of n.children || []) { const r = findCap(c); if (r) return r; }
      return null;
    })(body);
    return { ov: mockWin.__AGUsageMonitorOverlay, cap };
  }

  // 1. Fixed fallback without native anchor: macOS uses 12px right inset vs Windows 144px window-controls reserve
  const macFixed = runOverlayForPlatform('darwin');
  const winFixed = runOverlayForPlatform('win32');
  try {
    assert.equal(macFixed.cap.getAttribute('data-os'), 'mac');
    assert.equal(macFixed.cap.style.right, '12px');
    assert.equal(winFixed.cap.getAttribute('data-os'), 'default');
    assert.equal(winFixed.cap.style.right, '144px');
  } finally {
    macFixed.ov.dispose();
    winFixed.ov.dispose();
  }

  // 2. Fixed fallback with native top-right button at x=1230 on 1280px viewport: macOS hugs button at 56px instead of jumping to 144px
  const macAnchored = runOverlayForPlatform('darwin', { auxLeft: 1230, winWidth: 1280 });
  try {
    assert.equal(macAnchored.cap.style.right, '56px');
  } finally {
    macAnchored.ov.dispose();
  }

  // 3. Flow titlebar narrow window (610px): macOS 80px traffic-light reserve retains 'wide' capsule while Windows 168px reserve collapses
  const macNarrowFlow = runOverlayForPlatform('darwin', { withTitlebar: true, winWidth: 610 });
  const winNarrowFlow = runOverlayForPlatform('win32', { withTitlebar: true, winWidth: 610 });
  try {
    assert.equal(macNarrowFlow.cap.getAttribute('data-layout'), 'wide');
    assert.notEqual(winNarrowFlow.cap.getAttribute('data-layout'), 'wide');
  } finally {
    macNarrowFlow.ov.dispose();
    winNarrowFlow.ov.dispose();
  }
});

test('Issue #26: Antigravity Desktop 2.33.0+ automatic shortcut/launcher provisioning, out-of-job host relaunch, and global/settings BridgeStatusNotice UI', async () => {
  // 1. Fresh IDE argv.json remains strict-JSON parseable
  const fresh = ensureRemoteDebuggingInArgvText('');
  assert.deepEqual(JSON.parse(fresh.text), { 'remote-debugging-port': '0' });

  // 2. Pure argument / HKCU Run / Linux .desktop patchers & non-destructive rollback
  const addedEmpty = ensureRemoteDebugFlagInArgs('', { enabled: true });
  assert.equal(addedEmpty.changed, true);
  assert.equal(addedEmpty.args, '--remote-debugging-port=0');

  const preservedCustom = ensureRemoteDebugFlagInArgs('--foo --remote-debugging-port=9229', {
    enabled: true,
  });
  assert.equal(preservedCustom.changed, false);
  assert.equal(preservedCustom.alreadyConfigured, true);

  const preservedCustomOnDisable = ensureRemoteDebugFlagInArgs(
    '--foo --remote-debugging-port=9229',
    { enabled: false }
  );
  assert.equal(preservedCustomOnDisable.changed, false);
  assert.equal(preservedCustomOnDisable.configured, true);

  const strippedManaged = ensureRemoteDebugFlagInArgs('--hidden --remote-debugging-port=0 --bar', {
    enabled: false,
  });
  assert.equal(strippedManaged.changed, true);
  assert.equal(strippedManaged.removed, true);
  assert.equal(strippedManaged.args, '--hidden --bar');

  const winRunDesktop = patchWindowsRunRegistryCommand(
    '"C:\\Users\\Dev\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --hidden',
    { enabled: true }
  );
  assert.equal(winRunDesktop.matched, true);
  assert.equal(winRunDesktop.changed, true);
  assert.equal(
    winRunDesktop.value,
    '"C:\\Users\\Dev\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --hidden --remote-debugging-port=0'
  );
  const winRunRollback = patchWindowsRunRegistryCommand(winRunDesktop.value, { enabled: false });
  assert.equal(winRunRollback.changed, true);
  assert.equal(
    winRunRollback.value,
    '"C:\\Users\\Dev\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --hidden'
  );
  const winRunIdeIgnored = patchWindowsRunRegistryCommand(
    '"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe"',
    { enabled: true }
  );
  assert.equal(winRunIdeIgnored.matched, false);

  const linuxDesktopRaw = [
    '[Desktop Entry]',
    'Name=Antigravity',
    'Exec=/opt/Antigravity/antigravity %U',
    'Type=Application',
    '',
  ].join('\n');
  const linuxPatched = patchLinuxDesktopEntryText(linuxDesktopRaw, { enabled: true });
  assert.equal(linuxPatched.matched, true);
  assert.equal(linuxPatched.changed, true);
  assert.match(linuxPatched.text, /Exec=\/opt\/Antigravity\/antigravity --remote-debugging-port=0 %U/);
  const linuxReverted = patchLinuxDesktopEntryText(linuxPatched.text, { enabled: false });
  assert.equal(linuxReverted.changed, true);
  assert.equal(linuxReverted.text, linuxDesktopRaw);

  // 3. Host executable resolution from ANTIGRAVITY_AGENTAPI_EXE & clean relaunch env sanitization
  const resolvedWinHost = resolveDesktopHostExecutable({
    env: {
      ANTIGRAVITY_AGENTAPI_EXE:
        'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server_windows_x64.exe',
    },
    platform: 'win32',
    homeDir: 'C:\\Users\\Administrator',
    existsFn: (p) =>
      p.replace(/\//g, '\\') ===
      'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
  });
  assert.equal(resolvedWinHost.found, true);
  assert.equal(resolvedWinHost.kind, 'desktop');
  assert.equal(
    resolvedWinHost.executablePath.replace(/\//g, '\\'),
    'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe'
  );

  const resolvedMacHost = resolveDesktopHostExecutable({
    env: {
      ANTIGRAVITY_AGENTAPI_EXE:
        '/Applications/Antigravity.app/Contents/Resources/bin/language_server_darwin_arm64',
    },
    platform: 'darwin',
    homeDir: '/Users/dev',
    existsFn: (p) =>
      p === '/Applications/Antigravity.app' ||
      p === '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
  });
  assert.equal(resolvedMacHost.found, true);
  assert.equal(resolvedMacHost.appBundlePath, '/Applications/Antigravity.app');

  const sanitizedEnv = buildSanitizedDesktopRelaunchEnv({
    PATH: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\Administrator',
    ANTIGRAVITY_LS_ADDRESS: 'localhost:13088',
    ANTIGRAVITY_CSRF_TOKEN: 'secret',
    CHROME_DEVTOOLS_MCP_JS: 'C:\\foo.js',
    USAGE_MONITOR_HOST_PPID: '123',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
  });
  assert.deepEqual(sanitizedEnv, {
    PATH: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\Administrator',
  });

  // 4. Linux .desktop provisioning on real temp dir + Windows shortcut provisioning + stale DevToolsActivePort (cdp_unreachable) + relaunch dispatch
  const simTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-233-auto-'));
  const homeDir = path.join(simTmp, 'home');
  const roamingDir = path.join(homeDir, 'AppData', 'Roaming');
  const localDir = path.join(homeDir, 'AppData', 'Local');
  const desktopRoamingDir = path.join(roamingDir, 'Antigravity');
  const fakeExe = path.join(localDir, 'Programs', 'Antigravity', 'Antigravity.exe');
  const leaseFile = path.join(simTmp, 'window-bridge-lease.json');
  fs.mkdirSync(desktopRoamingDir, { recursive: true });
  fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
  fs.writeFileSync(fakeExe, '', 'utf8');

  // Simulate stale DevToolsActivePort left behind by 2.32.x pointing to a closed port
  const stalePortServer = http.createServer();
  await new Promise((r) => stalePortServer.listen(0, '127.0.0.1', r));
  const deadPort = stalePortServer.address().port;
  await new Promise((r) => stalePortServer.close(r));
  const stalePortFile = path.join(desktopRoamingDir, 'DevToolsActivePort');
  fs.writeFileSync(stalePortFile, `${deadPort}\n/devtools/browser/stale-232\n`, 'utf8');

  const simEnv = {
    PATH: 'C:\\Windows\\System32',
    APPDATA: roamingDir,
    LOCALAPPDATA: localDir,
    ANTIGRAVITY_AGENTAPI_EXE: path.join(
      localDir,
      'Programs',
      'Antigravity',
      'resources',
      'bin',
      'language_server_windows_x64.exe'
    ),
    ANTIGRAVITY_LS_ADDRESS: 'localhost:13088',
  };

  try {
    // Verify Linux XDG .desktop copy + autostart provisioning in isolated temp home
    const linuxDataHome = path.join(simTmp, 'xdg-data');
    const linuxCfgHome = path.join(simTmp, 'xdg-config');
    const linuxAutostart = path.join(linuxCfgHome, 'autostart', 'antigravity.desktop');
    fs.mkdirSync(path.dirname(linuxAutostart), { recursive: true });
    fs.writeFileSync(linuxAutostart, linuxDesktopRaw, 'utf8');
    const sysDesktopPath = '/usr/share/applications/antigravity.desktop';
    const linuxProv = await ensureDesktopLaunchEntriesConfigured({
      enabled: true,
      env: { XDG_DATA_HOME: linuxDataHome, XDG_CONFIG_HOME: linuxCfgHome },
      platform: 'linux',
      homeDir,
      allowInTest: true,
      fsOps: {
        existsFn: (p) => (p === sysDesktopPath ? true : fs.existsSync(p)),
        readFn: (p, enc) => (p === sysDesktopPath ? linuxDesktopRaw : fs.readFileSync(p, enc)),
        writeFn: fs.writeFileSync,
        mkdirFn: fs.mkdirSync,
        renameFn: fs.renameSync,
        unlinkFn: fs.unlinkSync,
      },
    });
    assert.equal(linuxProv.updated, true);
    assert.equal(linuxProv.configured, true);
    assert.equal(linuxProv.updatedPaths.length, 2);
    assert.match(
      fs.readFileSync(path.join(linuxDataHome, 'applications', 'antigravity.desktop'), 'utf8'),
      /--remote-debugging-port=0 %U/
    );

    // Verify Windows shortcut auto-provisioning + stale port (`cdp_unreachable`) status reporting + clean rollback on disable
    const winPsCalls = [];
    const mockWinExec = async (file, args, opts) => {
      winPsCalls.push({ file, args, env: opts?.env });
      const enabledFlag = opts?.env?.AGY_LAUNCH_ENABLED === '1';
      return JSON.stringify({
        ok: true,
        updatedPaths: enabledFlag
          ? ['C:\\Users\\Admin\\Desktop\\Antigravity.lnk', 'C:\\TaskBar\\Antigravity.lnk']
          : ['C:\\Users\\Admin\\Desktop\\Antigravity.lnk'],
        configuredPaths: enabledFlag
          ? ['C:\\Users\\Admin\\Desktop\\Antigravity.lnk', 'C:\\TaskBar\\Antigravity.lnk']
          : [],
      });
    };

    let currentMountSettings = {
      windowMountMode: 'dual',
      enableWindowOverlay: true,
      modelContextWindows: {},
    };
    const ctrlWin = createWindowBridgeController({
      handleApiRequest: async () => ({ status: 200, body: '{}' }),
      readAssetFn: async () => '',
      getSettingsFn: () => currentMountSettings,
      getBundleVersionFn: () => '201',
      env: simEnv,
      platform: 'win32',
      homeDir,
      leaseFilePath: leaseFile,
      autoConfigureIdeArgv: true,
      launcherExecFileFn: mockWinExec,
      allowDesktopLauncherInTest: true,
    });

    const syncRes = await ctrlWin.syncAllWindows();
    assert.equal(syncRes.reason, 'cdp_unreachable', 'Stale 2.32.x port surfaces cdp_unreachable');
    const stWin = ctrlWin.getBridgeStatus();
    assert.equal(stWin.state, 'cdp_unreachable');
    assert.equal(stWin.argvUpdatedThisBoot, true);
    assert.equal(stWin.launcherConfigured, true);
    assert.equal(stWin.canRelaunch, true);
    assert.equal(winPsCalls.length, 1);
    assert.equal(winPsCalls[0].env.AGY_LAUNCH_ENABLED, '1');

    // Disabling overlay (Sidebar Only) cleanly triggers shortcut flag rollback
    currentMountSettings = {
      windowMountMode: 'sidebar',
      enableWindowOverlay: false,
      modelContextWindows: {},
    };
    await ctrlWin.notifySettingChanged(false);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(winPsCalls.length, 2);
    assert.equal(winPsCalls[1].env.AGY_LAUNCH_ENABLED, '0');
    await ctrlWin.stop();

    // Verify Windows out-of-job Shell.Application relaunch payload (.ps1 file with UTF-8 BOM) & macOS open -a relaunch
    let capturedRelaunchEnv = null;
    let capturedRelaunchArgs = null;
    const relaunchWinRes = await triggerDesktopHostRelaunch({
      env: { ...simEnv, TEMP: simTmp },
      platform: 'win32',
      homeDir,
      stalePortFiles: [stalePortFile],
      allowInTest: true,
      execFileFn: async (_file, args, opts) => {
        capturedRelaunchArgs = args;
        capturedRelaunchEnv = opts?.env;
        return '{"ok":true,"method":"shell_application"}';
      },
    });
    assert.equal(relaunchWinRes.ok, true);
    assert.equal(relaunchWinRes.relaunching, true);
    assert.equal(capturedRelaunchArgs.includes('-Sta'), true, 'Forces STA for Shell.Application COM');
    assert.equal(capturedRelaunchEnv.ANTIGRAVITY_LS_ADDRESS, undefined, 'Strips host LS env');
    assert.equal(fs.existsSync(capturedRelaunchEnv.AGY_RELAUNCH_PS1), true);
    const writtenPs1 = fs.readFileSync(capturedRelaunchEnv.AGY_RELAUNCH_PS1, 'utf8');
    assert.equal(writtenPs1.startsWith('\uFEFF'), true, 'Writes UTF-8 BOM for Windows PowerShell 5.1');
    assert.match(writtenPs1, /--remote-debugging-port=0/);
    assert.ok(writtenPs1.includes(stalePortFile));

    // Verify dynamic running-process path discovery when installed on custom non-default drive (e.g. D:\Apps\Antigravity)
    const customDriveRes = await triggerDesktopHostRelaunch({
      env: { TEMP: simTmp },
      platform: 'win32',
      homeDir: path.join(simTmp, 'empty-home'),
      allowInTest: true,
      existsFn: () => false,
      execFileFn: async (_file, args) => {
        const cmdStr = args.join(' ');
        if (cmdStr.includes('Get-Process')) {
          return JSON.stringify({ path: 'D:\\Apps\\Antigravity\\Antigravity.exe', name: 'Antigravity' });
        }
        return '{"ok":true,"method":"shell_application"}';
      },
    });
    assert.equal(customDriveRes.ok, true);
    assert.equal(customDriveRes.executablePath, 'D:\\Apps\\Antigravity\\Antigravity.exe');

    let macSpawnArgs = null;
    const relaunchMacRes = await triggerDesktopHostRelaunch({
      env: {
        PATH: '/usr/bin:/bin',
        ANTIGRAVITY_AGENTAPI_EXE:
          '/Applications/Antigravity.app/Contents/Resources/bin/language_server_darwin_arm64',
      },
      platform: 'darwin',
      homeDir: '/Users/dev',
      stalePortFiles: ['/Users/dev/Library/Application Support/Antigravity/DevToolsActivePort'],
      allowInTest: true,
      existsFn: (p) => p === '/Applications/Antigravity.app',
      spawnFn: async (file, args, opts) => {
        macSpawnArgs = { file, args, env: opts?.env };
        return { pid: 4321 };
      },
    });
    assert.equal(relaunchMacRes.ok, true);
    assert.equal(macSpawnArgs.env.AGY_RELAUNCH_APP, '/Applications/Antigravity.app');
    assert.match(macSpawnArgs.args[1], /open -a "\$AGY_RELAUNCH_APP" --args --remote-debugging-port=0/);

    // Explicit ANTIGRAVITY_DEVTOOLS_PORT fallback still works seamlessly
    const innerScriptCheck = buildWindowsRelaunchInnerScript(fakeExe, [stalePortFile], 'desktop');
    assert.match(innerScriptCheck, /CloseMainWindow/);
    assert.match(innerScriptCheck, /Stop-Process/);
  } finally {
    fs.rmSync(simTmp, { recursive: true, force: true });
  }

  // 5. Verify zh-CN / en-US i18n parity & BridgeStatusNotice one-click relaunch + dismiss + copy behavior
  const [
    { I18N_MESSAGES_ZH_CN },
    { I18N_MESSAGES_EN_US },
    { setI18nLanguage },
    { SettingsStructureTab },
    { SettingsOtherTab },
    { BridgeStatusNotice },
  ] = await Promise.all([
    import('../src/i18n/zh-CN.js'),
    import('../src/i18n/en-US.js'),
    import('../src/i18n/index.js'),
    import('../src/views/settings/SettingsStructureTab.js'),
    import('../src/views/settings/SettingsOtherTab.js'),
    import('../src/components/settings/BridgeStatusNotice.js'),
  ]);

  assert.deepEqual(
    Object.keys(I18N_MESSAGES_ZH_CN).sort(),
    Object.keys(I18N_MESSAGES_EN_US).sort()
  );

  const { document: mockDoc } = createMockDom();
  const prevDoc = globalThis.document;
  const prevNav = globalThis.navigator;
  const prevFetch = globalThis.fetch;
  let copiedClipboardText = '';
  const fetchedUrls = [];
  globalThis.document = mockDoc;
  globalThis.fetch = async (url, opts) => {
    fetchedUrls.push({ url: String(url), method: opts?.method || 'GET' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, relaunching: true }),
      text: async () => JSON.stringify({ ok: true, relaunching: true }),
    };
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: async (txt) => {
          copiedClipboardText = txt;
        },
      },
    },
    configurable: true,
  });

  try {
    setI18nLanguage('zh-CN');
    const strTab = SettingsStructureTab({});
    const noticeEl = strTab.refs.mountBridgeNotice.el;
    assert.equal(noticeEl.hasAttribute('hidden'), true, 'Hidden before bridge status arrives');

    // Stale DevToolsActivePort (`cdp_unreachable`) with auto-patched shortcuts -> shows blue `.is-restart` + 1-click relaunch button!
    strTab.refs.renderSettings(
      { windowMountMode: 'dual', enableWindowOverlay: true },
      {
        state: 'cdp_unreachable',
        argvUpdatedThisBoot: false,
        argvConfigured: true,
        launcherConfigured: true,
        canRelaunch: true,
      },
      'win32'
    );
    assert.equal(noticeEl.hasAttribute('hidden'), false);
    assert.equal(noticeEl.classList.contains('is-restart'), true);
    assert.match(noticeEl.textContent, /已自动补齐启动参数/);
    assert.equal(
      strTab.refs.mountBridgeNotice.refs.relaunchBtnEl.hasAttribute('hidden'),
      false
    );

    // Click 1-click relaunch button -> POST /api/bridge/relaunch & shows "正在重启客户端..."
    strTab.refs.mountBridgeNotice.refs.relaunchBtnEl.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(
      fetchedUrls.some((u) => u.url.endsWith('/api/bridge/relaunch') && u.method === 'POST'),
      true
    );
    assert.match(strTab.refs.mountBridgeNotice.refs.relaunchBtnEl.textContent, /正在重启客户端/);

    // macOS unconfigured state -> `.is-warn` with 1-click relaunch + copy button
    strTab.refs.renderSettings(
      { windowMountMode: 'dual', enableWindowOverlay: true },
      {
        state: 'no_devtools_port',
        argvUpdatedThisBoot: false,
        argvConfigured: false,
        launcherConfigured: false,
        canRelaunch: true,
      },
      'darwin'
    );
    assert.equal(noticeEl.classList.contains('is-warn'), true);
    assert.match(noticeEl.textContent, /open -a "Antigravity" --args --remote-debugging-port=0/);

    strTab.refs.mountBridgeNotice.refs.copyBtnEl.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(copiedClipboardText, '--remote-debugging-port=0');
    assert.match(strTab.refs.mountBridgeNotice.refs.copyBtnEl.textContent, /已复制/);

    // Dismissible global banner hides on dismiss click and resets once state becomes 'active'
    const globalBanner = BridgeStatusNotice({ dismissible: true });
    globalBanner.refs.update({
      visible: true,
      windowBridge: { state: 'no_devtools_port', launcherConfigured: true, canRelaunch: true },
      hostPlatform: 'win32',
    });
    assert.equal(globalBanner.el.hasAttribute('hidden'), false);
    globalBanner.refs.dismissBtnEl.dispatchEvent({ type: 'click' });
    assert.equal(globalBanner.el.hasAttribute('hidden'), true);
    globalBanner.refs.update({
      visible: true,
      windowBridge: { state: 'active', launcherConfigured: true, canRelaunch: true },
      hostPlatform: 'win32',
    });
    globalBanner.refs.update({
      visible: true,
      windowBridge: { state: 'no_devtools_port', launcherConfigured: true, canRelaunch: true },
      hostPlatform: 'win32',
    });
    assert.equal(globalBanner.el.hasAttribute('hidden'), false, 'Re-armed after active cycle');

    // English localization check
    setI18nLanguage('en-US');
    strTab.refs.refreshLabels();
    assert.match(noticeEl.textContent, /Local Debug Port Missing/);

    // Switching to Sidebar Only hides notice immediately
    strTab.refs.renderSettings(
      { windowMountMode: 'sidebar', enableWindowOverlay: false },
      { state: 'no_devtools_port', launcherConfigured: true, canRelaunch: true },
      'win32'
    );
    assert.equal(noticeEl.hasAttribute('hidden'), true);

    // SettingsOtherTab context window override notice & pending-restart meta state (Issue #27)
    setI18nLanguage('zh-CN');
    const othTab = SettingsOtherTab({ onLayoutChange: () => {} });
    const ctxNoticeEl = othTab.refs.ctxBridgeNotice.el;
    const mockCtxModels = [
      {
        id: 'model:gemini-4-carbon',
        label: 'Gemini 4 Carbon',
        capacity: 786432,
        members: ['MODEL_PLACEHOLDER_M427'],
        options: [{ name: '256000', tokens: 256000 }, { name: '512000', tokens: 512000 }],
      },
    ];

    // Locked risk mask -> notice stays hidden
    othTab.refs.renderSettings(
      { contextWindowRiskAccepted: false, modelContextWindows: {} },
      mockCtxModels,
      { state: 'no_devtools_port', launcherConfigured: true, canRelaunch: true },
      'win32'
    );
    assert.equal(ctxNoticeEl.hasAttribute('hidden'), true);

    // Unlocked + no_devtools_port -> notice immediately visible AND saved option meta shows "待重启生效" instead of "已设置"
    othTab.refs.renderSettings(
      {
        contextWindowRiskAccepted: true,
        modelContextWindows: { 'model:gemini-4-carbon': '256000' },
      },
      mockCtxModels,
      { state: 'no_devtools_port', launcherConfigured: true, canRelaunch: true },
      'win32'
    );
    assert.equal(ctxNoticeEl.hasAttribute('hidden'), false);
    assert.match(ctxNoticeEl.textContent, /激活上下文覆写/);
    othTab.refs.ctxModelSelect.refs.triggerBtn.dispatchEvent({
      type: 'click',
      stopPropagation() {},
    });
    assert.match(
      othTab.refs.ctxModelSelect.refs.menuEl.textContent,
      /256,000 token · 待重启生效/
    );

    othTab.refs.renderSettings(
      {
        contextWindowRiskAccepted: true,
        modelContextWindows: { 'model:gemini-4-carbon': '256000' },
      },
      mockCtxModels,
      { state: 'active', aliveCount: 1, launcherConfigured: true, canRelaunch: true },
      'win32'
    );
    assert.equal(ctxNoticeEl.hasAttribute('hidden'), true);
    assert.match(othTab.refs.ctxModelSelect.refs.menuEl.textContent, /256,000 token · 已设置/);

    globalBanner.destroy();
    strTab.destroy();
    othTab.destroy();
  } finally {
    setI18nLanguage('zh-CN');
    globalThis.document = prevDoc;
    globalThis.fetch = prevFetch;
    Object.defineProperty(globalThis, 'navigator', {
      value: prevNav,
      configurable: true,
    });
  }
});

test('macOS cold-start autoRelaunchDebug triggers once with --remote-debugging-port=0 and respects all safety guardrails', async () => {
  // 1. parsePsElapsedSeconds parses MM:SS, HH:MM:SS, DD-HH:MM:SS and rejects malformed inputs
  assert.equal(parsePsElapsedSeconds('00:05'), 5);
  assert.equal(parsePsElapsedSeconds('02:15'), 135);
  assert.equal(parsePsElapsedSeconds('01:02:03'), 3723);
  assert.equal(parsePsElapsedSeconds('1-00:00:10'), 86410);
  assert.equal(parsePsElapsedSeconds('bad'), null);
  assert.equal(parsePsElapsedSeconds(''), null);

  // 2. normalizeFullSettings defaults autoRelaunchDebug to false and preserves explicit true
  assert.equal(normalizeFullSettings({}).autoRelaunchDebug, false);
  assert.equal(normalizeFullSettings({ autoRelaunchDebug: true }).autoRelaunchDebug, true);
  assert.equal(typeof loadSettings().autoRelaunchDebug, 'boolean');

  // 3. inspectRunningDarwinDesktopHost picks main binary and excludes Helper / IDE
  const mockPsLines = [
    '  111  00:02 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=renderer',
    '  222  00:03 /Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
    '  333  00:04 /Applications/Antigravity.app/Contents/MacOS/Antigravity',
  ].join('\n');
  const parsedHost = await inspectRunningDarwinDesktopHost({
    execFileFn: async () => mockPsLines,
  });
  assert.deepEqual(parsedHost, {
    pid: 333,
    elapsedSec: 4,
    hasRemoteDebugFlag: false,
    command: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-autorelaunch-'));
  try {
    const stateFilePath = path.join(tmpDir, 'auto-relaunch-state.json');
    const leaseFilePath = path.join(tmpDir, 'window-bridge-lease.json');
    const scriptPath = path.join(tmpDir, 'relaunch-antigravity-debug.command');
    const ctrlScriptPath = path.join(tmpDir, 'ctrl-relaunch.command');
    const spawnCalls = [];
    const existsMock = (p) =>
      p === '/Applications/Antigravity.app' ||
      p === '/Applications/Antigravity.app/Contents/MacOS/Antigravity' ||
      fs.existsSync(p);
    const mockSpawn = async (file, args, opts) => {
      spawnCalls.push({ file, args, opts });
      return { pid: 9999 };
    };

    // 4. Fresh bare macOS Antigravity (elapsedSec=4, no flag) triggers Terminal relaunch ONCE
    const res1 = await maybeAutoRelaunchDarwinDesktopHost({
      env: {},
      platform: 'darwin',
      homeDir: tmpDir,
      stalePortFiles: [path.join(tmpDir, 'DevToolsActivePort')],
      leaseFilePath,
      stateFilePath,
      scriptPath,
      bridgeUptimeMs: 3000,
      nowMs: 1_000_000,
      execFileFn: async () => mockPsLines,
      spawnFn: mockSpawn,
      existsFn: existsMock,
      allowInTest: true,
    });
    assert.equal(res1.triggered, true);
    assert.equal(res1.reason, 'auto_relaunching');
    assert.equal(res1.hostPid, 333);
    assert.equal(res1.scriptPath, scriptPath);
    assert.equal(res1.result?.viaTerminal, true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].file, '/usr/bin/open');
    assert.deepEqual(spawnCalls[0].args, ['-a', 'Terminal', scriptPath]);
    assert.equal(fs.existsSync(stateFilePath), true);
    assert.equal(fs.existsSync(scriptPath), true);
    assert.notEqual(fs.statSync(scriptPath).mode & 0o111, 0, '.command script must be executable');
    const scriptText = fs.readFileSync(scriptPath, 'utf8');
    assert.match(scriptText, /^#!\/bin\/bash\n/);
    assert.match(scriptText, /--remote-debugging-port=0/);
    assert.match(scriptText, /DevToolsActivePort/);
    assert.ok(scriptText.includes(`LEASE_FILE='${leaseFilePath}'`), 'Script embeds target leaseFilePath');
    assert.match(scriptText, /JSON::PP/);
    assert.match(scriptText, /check_bridge_mounted\(\)/);
    assert.match(scriptText, /syncState/);
    assert.match(scriptText, /aliveCount/);
    assert.match(scriptText, /运行成功！底部用量与额度栏已成功加载显示！/);
    assert.match(scriptText, /已确认运行成功，将在 3 秒后自动关闭此终端窗口/);
    assert.match(scriptText, /POSIX::setsid\(\)/);
    assert.match(scriptText, /close \(every window whose id is/);
    assert.match(scriptText, /for n in 3 2 1; do/);

    // Direct helper sanity check (ensureDarwinTerminalRelaunchScript & buildDarwinTerminalRelaunchScript)
    const directScript = buildDarwinTerminalRelaunchScript({
      appBundlePath: '/Applications/Antigravity.app',
      kind: 'desktop',
      stalePortFiles: [],
      homeDir: tmpDir,
      leaseFilePath,
    });
    assert.match(directScript, /PORT_FILES=\('.*DevToolsActivePort'\)/);
    assert.ok(directScript.includes(`LEASE_FILE='${leaseFilePath}'`));
    const ensured = ensureDarwinTerminalRelaunchScript({
      scriptPath: path.join(tmpDir, 'direct.command'),
      homeDir: tmpDir,
      leaseFilePath,
    });
    assert.equal(fs.existsSync(ensured.scriptPath), true);
    assert.equal(
      (await triggerDarwinTerminalRelaunch({ platform: 'linux', allowInTest: true })).ok,
      false
    );

    // 5. Same PID on second attempt is blocked
    const resSamePid = await maybeAutoRelaunchDarwinDesktopHost({
      env: {},
      platform: 'darwin',
      homeDir: tmpDir,
      leaseFilePath,
      stateFilePath,
      scriptPath,
      bridgeUptimeMs: 4000,
      nowMs: 1_001_000,
      execFileFn: async () => mockPsLines,
      spawnFn: mockSpawn,
      existsFn: existsMock,
      allowInTest: true,
    });
    assert.equal(resSamePid.triggered, false);
    assert.equal(resSamePid.reason, 'same_pid_already_relaunched');

    // 6. Different PID within 60s cooldown is blocked by circuit breaker
    const resCooldown = await maybeAutoRelaunchDarwinDesktopHost({
      env: {},
      platform: 'darwin',
      homeDir: tmpDir,
      stateFilePath,
      scriptPath,
      bridgeUptimeMs: 2000,
      nowMs: 1_030_000,
      execFileFn: async () => '  444  00:05 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n',
      spawnFn: mockSpawn,
      existsFn: existsMock,
      allowInTest: true,
    });
    assert.equal(resCooldown.triggered, false);
    assert.equal(resCooldown.reason, 'cooldown_circuit_breaker');

    // 7. Host running > 45s is never killed mid-conversation
    const resOldHost = await maybeAutoRelaunchDarwinDesktopHost({
      env: {},
      platform: 'darwin',
      homeDir: tmpDir,
      stateFilePath: path.join(tmpDir, 'unused.json'),
      scriptPath: path.join(tmpDir, 'unused.command'),
      bridgeUptimeMs: 2000,
      nowMs: 1_200_000,
      execFileFn: async () => '  555  02:00 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n',
      spawnFn: mockSpawn,
      existsFn: existsMock,
      allowInTest: true,
    });
    assert.equal(resOldHost.triggered, false);
    assert.equal(resOldHost.reason, 'host_past_startup_window');

    // 8. Host already launched with --remote-debugging-port=0 is skipped
    const resFlagged = await maybeAutoRelaunchDarwinDesktopHost({
      env: {},
      platform: 'darwin',
      homeDir: tmpDir,
      stateFilePath: path.join(tmpDir, 'unused.json'),
      scriptPath: path.join(tmpDir, 'unused.command'),
      bridgeUptimeMs: 2000,
      nowMs: 1_200_000,
      execFileFn: async () => '  666  00:03 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0\n',
      spawnFn: mockSpawn,
      existsFn: existsMock,
      allowInTest: true,
    });
    assert.equal(resFlagged.triggered, false);
    assert.equal(resFlagged.reason, 'already_has_debug_flag');

    // 9. Bridge uptime past 20s startup window is blocked
    const resLateBridge = await maybeAutoRelaunchDarwinDesktopHost({
      env: {},
      platform: 'darwin',
      homeDir: tmpDir,
      stateFilePath: path.join(tmpDir, 'unused.json'),
      scriptPath: path.join(tmpDir, 'unused.command'),
      bridgeUptimeMs: 21_000,
      nowMs: 1_200_000,
      execFileFn: async () => '  777  00:03 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n',
      spawnFn: mockSpawn,
      existsFn: existsMock,
      allowInTest: true,
    });
    assert.equal(resLateBridge.triggered, false);
    assert.equal(resLateBridge.reason, 'bridge_past_startup_window');

    // 10. Controller integration waits for 2nd no_devtools_port poll before relaunching once via Terminal
    const ctrlStateFile = path.join(tmpDir, 'ctrl-relaunch-state.json');
    const ctrlLeaseFile = path.join(tmpDir, 'ctrl-lease.json');
    const ctrlSpawns = [];
    let fakeNow = 2_000_000;
    const ctrl = createWindowBridgeController({
      handleApiRequest: async () => ({ status: 200, contentType: 'application/json', body: '{}' }),
      readAssetFn: () => '',
      getSettingsFn: () => ({ windowMountMode: 'composer', enableWindowOverlay: true, autoRelaunchDebug: true }),
      env: { USAGE_MONITOR_HOST_EXE: '/Applications/Antigravity.app/Contents/MacOS/Antigravity' },
      platform: 'darwin',
      homeDir: tmpDir,
      leaseFilePath: ctrlLeaseFile,
      autoRelaunchStateFilePath: ctrlStateFile,
      autoRelaunchScriptPath: ctrlScriptPath,
      autoConfigureIdeArgv: false,
      allowDesktopLauncherInTest: true,
      existsHostFn: existsMock,
      launcherExecFileFn: async () => '  888  00:04 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n',
      relaunchSpawnFn: async (file, args, opts) => {
        ctrlSpawns.push({ file, args, opts });
        return { pid: 8888 };
      },
      nowFn: () => fakeNow,
    });
    const p1 = await ctrl.syncAllWindows();
    assert.equal(p1.reason, 'no_devtools_port', '1st poll gives freshly launched app grace time');
    assert.equal(ctrlSpawns.length, 0);
    fakeNow += 2000;
    const p2 = await ctrl.syncAllWindows();
    assert.equal(p2.reason, 'auto_relaunching', '2nd poll within 20s triggers single relaunch');
    assert.equal(ctrlSpawns.length, 1);
    assert.equal(ctrlSpawns[0].file, '/usr/bin/open');
    assert.deepEqual(ctrlSpawns[0].args, ['-a', 'Terminal', ctrlScriptPath]);
    assert.equal(fs.existsSync(ctrlScriptPath), true);
    assert.ok(fs.readFileSync(ctrlScriptPath, 'utf8').includes(`LEASE_FILE='${ctrlLeaseFile}'`));
    fakeNow += 2000;
    const p3 = await ctrl.syncAllWindows();
    assert.equal(p3.reason, 'no_devtools_port', '3rd poll does not re-trigger autoRelaunchAttempted');
    assert.equal(ctrlSpawns.length, 1);
    assert.equal(spawnCalls.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Quota card ordering aligns with Official Usage, bars/rings use Scheme B remaining gradient, and meta text shows remaining only', async () => {
  const [
    { resolveQuotaRemainingColor, resolveQuotaRemainingBarGradient },
    { buildQuotaPoolItems, createPoolQuotaRow, syncPoolQuotaRow },
    { createCapsuleSlotNode, syncCapsuleSlotNodes, buildCapsuleSlotContext },
    { setI18nLanguage },
  ] = await Promise.all([
    import('../src/core/formatters.js'),
    import('../src/components/widgets/QuotaPoolsWidget.js'),
    import('../src/components/widgets/CapsuleBarWidget.js'),
    import('../src/i18n/index.js'),
  ]);

  assert.equal(resolveQuotaRemainingColor(100), '#3b82f6');
  assert.equal(resolveQuotaRemainingColor(75), '#4e8ff7');
  assert.equal(resolveQuotaRemainingColor(50), '#f59e0b');
  assert.equal(resolveQuotaRemainingColor(25), '#f97316');
  assert.equal(resolveQuotaRemainingColor(0), '#ef4444');
  assert.equal(resolveQuotaRemainingColor(null), '');
  assert.match(resolveQuotaRemainingBarGradient(100), /^linear-gradient\(90deg, #[0-9a-f]{6}, #3b82f6\)$/);

  const items = buildQuotaPoolItems({
    pools: [
      { poolKey: 'Gemini', poolLabel: 'Gemini', family: 'Gemini', usedPct: 56, remainingPct: 44, weeklyUsedPct: 18, weeklyRemainingPct: 82 },
      { poolKey: 'Argon', poolLabel: 'Gemini 4 Argon', family: 'Argon', weeklyUsedPct: 10, weeklyRemainingPct: 90 },
      { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', family: 'Claude & GPT', usedPct: 0, remainingPct: 100, weeklyUsedPct: 51, weeklyRemainingPct: 49 },
    ],
  });
  assert.deepEqual(
    items.map((item) => item.key),
    ['Gemini', 'Claude & GPT', 'Argon']
  );

  // Build minimal DOM harness for QuotaPoolsWidget & CapsuleBarWidget
  const prevDoc = globalThis.document;
  function makeMockEl(tag) {
    const attrs = new Map();
    const styles = new Map();
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      parentNode: null,
      textContent: '',
      hidden: false,
      style: {
        setProperty(k, v) {
          styles.set(k, String(v));
        },
        getPropertyValue(k) {
          return styles.get(k) || '';
        },
      },
      classList: {
        contains: (c) => classes.has(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'class') {
          classes.clear();
          String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        }
      },
      getAttribute: (k) => attrs.get(k) ?? null,
      hasAttribute: (k) => attrs.has(k),
      removeAttribute: (k) => attrs.delete(k),
      appendChild(c) {
        if (c && c.parentNode && c.parentNode !== el) c.remove?.();
        el.children.push(c);
        if (c && typeof c === 'object') c.parentNode = el;
        return c;
      },
      insertBefore(c, ref) {
        const idx = el.children.indexOf(ref);
        if (idx >= 0) el.children.splice(idx, 0, c);
        else el.children.push(c);
        if (c && typeof c === 'object') c.parentNode = el;
        return c;
      },
      remove() {
        if (!el.parentNode) return;
        const idx = el.parentNode.children.indexOf(el);
        if (idx >= 0) el.parentNode.children.splice(idx, 1);
        el.parentNode = null;
      },
    };
    return el;
  }
  globalThis.document = {
    createElement: (tag) => makeMockEl(tag),
    createElementNS: (_ns, tag) => makeMockEl(tag),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt) }),
  };

  try {
    setI18nLanguage('zh-CN');
    const row = createPoolQuotaRow();
    assert.equal(row.el.children[0], row.refs.rowWk, 'Weekly row appears above 5h row');
    assert.equal(row.el.children[1], row.refs.row5h, '5h row appears below Weekly row');

    syncPoolQuotaRow(row.refs, items[0], 0, row.el);
    assert.equal(row.refs.fillWk.style.getPropertyValue('--fill-w'), '82%');
    assert.equal(row.refs.fill5h.style.getPropertyValue('--fill-w'), '44%');
    assert.equal(
      row.refs.fillWk.style.getPropertyValue('--fill-bg'),
      resolveQuotaRemainingBarGradient(82)
    );
    assert.equal(
      row.refs.fill5h.style.getPropertyValue('--fill-bg'),
      resolveQuotaRemainingBarGradient(44)
    );
    assert.ok(row.refs.metaWk.textContent.includes('剩余 82.0%'));
    assert.equal(row.refs.metaWk.textContent.includes('已用'), false);
    assert.ok(row.refs.meta5h.textContent.includes('剩余 44.0%'));
    assert.equal(row.refs.meta5h.textContent.includes('已用'), false);

    setI18nLanguage('en-US');
    syncPoolQuotaRow(row.refs, items[1], 1, row.el);
    assert.equal(row.refs.fillWk.style.getPropertyValue('--fill-w'), '49%');
    assert.equal(row.refs.fill5h.style.getPropertyValue('--fill-w'), '100%');
    assert.equal(
      row.refs.fill5h.style.getPropertyValue('--fill-bg'),
      resolveQuotaRemainingBarGradient(100)
    );
    assert.ok(row.refs.metaWk.textContent.includes('49.0% left'));
    assert.equal(row.refs.metaWk.textContent.includes('Used'), false);

    setI18nLanguage('zh-CN');
    const slots = [0, 1, 2].map((i) => createCapsuleSlotNode(i, 'none'));
    const seps = [makeMockEl('span'), makeMockEl('span')];
    const slotCtx = buildCapsuleSlotContext({
      activeConversation: { context: { totalTokens: 128000, limitTokens: 256000 } },
      quotas: {
        pools: [
          { poolKey: 'Gemini', family: 'Gemini', remainingPct: 44, weeklyRemainingPct: 82 },
          { poolKey: 'Claude & GPT', family: 'Claude & GPT', remainingPct: 100, weeklyRemainingPct: 49 },
        ],
      },
    });
    syncCapsuleSlotNodes(slots, seps, ['gemini_5h', 'claude_5h', 'context'], slotCtx);
    assert.equal(slots[0].ringFill.style.getPropertyValue('--ring-color'), resolveQuotaRemainingColor(44));
    assert.equal(slots[1].ringFill.style.getPropertyValue('--ring-color'), '#3b82f6');
    assert.equal(slots[2].ringFill.style.getPropertyValue('--ring-color'), '', 'Context ring leaves --ring-color unset');
  } finally {
    setI18nLanguage('zh-CN');
    globalThis.document = prevDoc;
  }
});

test('TurnUsageCardWidget aggregates per-turn models/pools/quota deductions/context delta, aligns via React Fiber across virtual scrolling, suppresses streaming turns, and disposes cleanly', async () => {
  const {
    buildTurnUsageSummaries,
    classifyTurnModelRoleAndPool,
    disposeTurnUsageCardsInViewport,
    syncTurnUsageCardsInViewport,
  } = await import('../src/components/widgets/TurnUsageCardWidget.js');
  const { setI18nLanguage } = await import('../src/i18n/index.js');

  const quotas = {
    pools: [
      {
        id: 'gemini',
        label: 'Gemini',
        usedPct: 50,
        remainingPct: 50,
        weeklyUsedPct: 20,
        weeklyRemainingPct: 80,
        cycle5h: { tokens: 25_000_000, costUsd: 12.5 },
        cycle7d: { tokens: 40_000_000, costUsd: 20.0 },
      },
      {
        id: 'argon',
        label: 'Gemini 4 Argon',
        weeklyUsedPct: 10,
        weeklyRemainingPct: 90,
        cycle7d: { tokens: 2_000_000, costUsd: 1.0 },
      },
    ],
  };

  // 1. Verify role & pool classification
  assert.deepEqual(
    classifyTurnModelRoleAndPool(
      { modelLabel: 'Gemini 4 Argon (High)', modelShort: 'argon-4-high' },
      quotas
    ),
    { roleKey: 'Main', roleBadgeClass: 'role-main', poolFamily: 'Argon' }
  );
  assert.deepEqual(
    classifyTurnModelRoleAndPool(
      { modelLabel: 'Orchestrator Worker', modelShort: 'worker-agy-hydrogen' },
      quotas
    ),
    { roleKey: 'Exec', roleBadgeClass: 'role-exec', poolFamily: 'Gemini' }
  );
  assert.deepEqual(
    classifyTurnModelRoleAndPool(
      { modelLabel: 'Claude Sonnet 4.6', isSubagent: true },
      quotas
    ),
    { roleKey: 'Sub', roleBadgeClass: 'role-sub', poolFamily: 'Claude' }
  );

  // 2. Build turn summaries across Virtualized turns (#11, #12, and streaming #13)
  const telemetry = {
    settings: { language: 'zh-CN', enableWindowOverlay: true, windowMountMode: 'composer' },
    quotas,
    activeConversation: {
      cascadeId: 'turn-test-conv',
      isRunning: true,
      contextLimitTokens: 500_000,
      context: { totalTokens: 250_000, limitTokens: 500_000 },
      recentSteps: [
        // Turn 11 (first turn in sliced window, baseline estimated from cacheReadTokens = 180k -> end 200k = +20k = +4.0%)
        {
          stepIndex: 40,
          rootTurnIndex: 11,
          turnIndex: 11,
          createdAtMs: 1700000010000,
          totalDurationSec: 6.2,
          modelLabel: 'Gemini 3.8 Pro',
          modelShort: '3.8-pro',
          inputTokens: 15_000,
          cacheReadTokens: 180_000,
          outputTokens: 5_000,
          contextTokens: 200_000,
          costUsd: 0.25,
        },
        // Turn 12 (2 Argon main calls + 3 Hydrogen worker calls, end context 224,000 -> +24k / 500k = +4.8%)
        {
          stepIndex: 45,
          rootTurnIndex: 12,
          turnIndex: 12,
          createdAtMs: 1700000100000,
          totalDurationSec: 5.0,
          modelLabel: 'Gemini 4 Argon (High)',
          modelShort: 'argon-4-high',
          inputTokens: 8_000,
          cacheReadTokens: 80_000,
          outputTokens: 2_600,
          contextTokens: 210_000,
          costUsd: 0.06,
        },
        {
          stepIndex: 46,
          rootTurnIndex: 12,
          turnIndex: 12,
          createdAtMs: 1700000105000,
          totalDurationSec: 3.4,
          modelLabel: 'Orchestrator Worker',
          modelShort: 'worker-agy-hydrogen',
          inputTokens: 4_000,
          cacheReadTokens: 35_000,
          outputTokens: 1_000,
          contextTokens: 39_000,
          costUsd: 0.2,
        },
        {
          stepIndex: 47,
          rootTurnIndex: 12,
          turnIndex: 12,
          createdAtMs: 1700000109000,
          totalDurationSec: 3.0,
          modelLabel: 'Orchestrator Worker',
          modelShort: 'worker-agy-hydrogen',
          inputTokens: 4_000,
          cacheReadTokens: 37_000,
          outputTokens: 1_000,
          contextTokens: 41_000,
          costUsd: 0.2,
        },
        {
          stepIndex: 48,
          rootTurnIndex: 12,
          turnIndex: 12,
          createdAtMs: 1700000112000,
          totalDurationSec: 3.0,
          modelLabel: 'Orchestrator Worker',
          modelShort: 'worker-agy-hydrogen',
          inputTokens: 4_000,
          cacheReadTokens: 37_000,
          outputTokens: 1_000,
          contextTokens: 41_000,
          costUsd: 0.2,
        },
        {
          stepIndex: 49,
          rootTurnIndex: 12,
          turnIndex: 12,
          createdAtMs: 1700000118000,
          totalDurationSec: 4.0,
          modelLabel: 'Gemini 4 Argon (High)',
          modelShort: 'argon-4-high',
          inputTokens: 10_000,
          cacheReadTokens: 82_000,
          outputTokens: 2_600,
          contextTokens: 224_000,
          costUsd: 0.06,
        },
        // Turn 13 (currently streaming)
        {
          stepIndex: 52,
          rootTurnIndex: 13,
          turnIndex: 13,
          createdAtMs: 1700000200000,
          totalDurationSec: 2.1,
          modelLabel: 'Gemini 4 Argon (High)',
          modelShort: 'argon-4-high',
          inputTokens: 6_000,
          cacheReadTokens: 224_000,
          outputTokens: 1_000,
          contextTokens: 231_000,
          costUsd: 0.05,
        },
      ],
    },
  };

  const summaries = buildTurnUsageSummaries(telemetry);
  assert.equal(summaries.length, 3);
  const turn12 = summaries.find((s) => s.turnIndex === 12);
  assert.ok(turn12);
  assert.equal(turn12.totalSteps, 5);
  assert.equal(turn12.durationText, '18.4s');
  assert.equal(turn12.contextDeltaText, '+4.8%');
  assert.equal(turn12.models.length, 2);
  assert.equal(turn12.models[0].roleKey, 'Main');
  assert.equal(turn12.models[0].displayName, 'Gemini 4 Argon (High)');
  assert.equal(turn12.models[0].poolFamily, 'Argon');
  assert.equal(turn12.models[0].calls, 2);
  assert.equal(turn12.models[0].sharePct, 60);
  assert.equal(turn12.models[1].roleKey, 'Exec');
  assert.equal(turn12.models[1].displayName, 'worker-agy-hydrogen');
  assert.equal(turn12.models[1].poolFamily, 'Gemini');
  assert.equal(turn12.models[1].calls, 3);
  assert.equal(turn12.models[1].sharePct, 40);
  assert.deepEqual(
    turn12.quotaDeductions.map((q) => q.tag),
    ['G5h', 'G周', 'A周'],
    'Turn 12 used both Argon and Hydrogen (Gemini pool), so G5h, G周, and A周 are deducted'
  );
  const turn13 = summaries.find((s) => s.turnIndex === 13);
  assert.ok(turn13);
  assert.deepEqual(
    turn13.quotaDeductions.map((q) => q.tag),
    ['A周'],
    'Turn 13 used ONLY Gemini 4 Argon (Argon pool), so ONLY A周 is deducted (never G5h or G周)'
  );

  // 3. Test DOM virtualized Fiber matching & streaming suppression
  const prevDoc = globalThis.document;
  const { document: mockDoc, body, makeElement } = createMockDom();
  globalThis.document = mockDoc;

  try {
    setI18nLanguage('zh-CN');
    // Simulate virtual scrolling where ONLY Turn #12 (completed) and Turn #13 (streaming) are mounted in the DOM
    const wrap12 = makeElement('div');
    wrap12.__reactFiber$test = {
      return: {
        memoizedProps: {
          isRunning: false,
          container: {
            steps: [
              { metadata: { createdAt: { seconds: 1700000100n, nanos: 0 } } },
              { metadata: { createdAt: { seconds: 1700000118n, nanos: 0 } } },
            ],
          },
        },
      },
    };
    const resp12 = makeElement('div');
    resp12.setAttribute('data-testid', 'agent-response');
    wrap12.appendChild(resp12);
    body.appendChild(wrap12);

    const wrap13 = makeElement('div');
    wrap13.__reactFiber$test = {
      return: {
        memoizedProps: {
          isRunning: true,
          container: {
            steps: [{ metadata: { createdAt: { seconds: 1700000200n, nanos: 0 } } }],
          },
        },
      },
    };
    const resp13 = makeElement('div');
    resp13.setAttribute('data-testid', 'agent-response');
    wrap13.appendChild(resp13);
    body.appendChild(wrap13);

    const mountedCount = syncTurnUsageCardsInViewport({ rootDoc: mockDoc, telemetry });
    assert.equal(mountedCount, 1, 'Mounts Turn #12 card while suppressing streaming Turn #13');

    const card12 = resp12.querySelector('.wm-turn-usage-card');
    assert.ok(card12, 'Turn #12 card mounted inside completed response');
    assert.equal(card12.getAttribute('data-turn-index'), '12');
    assert.ok(
      card12.querySelector('.wm-turn-title').textContent.startsWith('#第12轮 · 完成于 '),
      'Header shows exact virtualized turn number #第12轮 (not #第1轮)'
    );
    assert.equal(card12.querySelector('.wm-turn-meta').textContent, '共 5 步 · 总耗时 18.4s');
    assert.equal(resp13.querySelector('.wm-turn-usage-card'), null, 'Streaming Turn #13 has no card yet');

    // Second sync with identical telemetry reuses exact card DOM node via data-sig
    syncTurnUsageCardsInViewport({ rootDoc: mockDoc, telemetry });
    assert.equal(resp12.querySelector('.wm-turn-usage-card'), card12, 'Idempotent DOM patch when signature matches');

    // Once Turn #13 finishes streaming (isRunning -> false), its card mounts immediately
    wrap13.__reactFiber$test.return.memoizedProps.isRunning = false;
    telemetry.activeConversation.isRunning = false;
    const mountedAfterFinish = syncTurnUsageCardsInViewport({ rootDoc: mockDoc, telemetry });
    assert.equal(mountedAfterFinish, 2);
    const card13 = resp13.querySelector('.wm-turn-usage-card');
    assert.ok(card13);
    assert.equal(card13.getAttribute('data-turn-index'), '13');

    // Simulate user sending a brand-new Turn #14 (1 second ago, Fiber has timestamp 1700000300n,
    // before backend telemetry has polled Turn #14 steps): MUST NOT borrow old Turn #11!
    const wrap14 = makeElement('div');
    wrap14.__reactFiber$test = {
      return: {
        memoizedProps: {
          container: {
            isLatest: true,
            steps: [{ status: 2, metadata: { createdAt: { seconds: 1700000300n, nanos: 0 } } }],
          },
        },
      },
    };
    const resp14 = makeElement('div');
    resp14.setAttribute('data-testid', 'agent-response');
    wrap14.appendChild(resp14);
    body.appendChild(wrap14);

    syncTurnUsageCardsInViewport({ rootDoc: mockDoc, telemetry });
    assert.equal(
      resp14.querySelector('.wm-turn-usage-card'),
      null,
      'Newly sent Turn #14 with unmatched future Fiber timestamp never borrows old Turn #11'
    );

    // Dispose cleans up all cards and style tag
    disposeTurnUsageCardsInViewport(mockDoc);
    assert.equal(resp12.querySelector('.wm-turn-usage-card'), null);
    assert.equal(resp13.querySelector('.wm-turn-usage-card'), null);
    assert.equal(mockDoc.getElementById('ag-usage-monitor-turn-styles'), null);
  } finally {
    globalThis.document = prevDoc;
  }
});
