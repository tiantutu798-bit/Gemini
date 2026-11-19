/**
 * @fileoverview Antigravity Desktop 2.33.0+ 跨平台启动入口自动补齐与一键带参重拉控制器。
 *
 * 背景：
 * Antigravity Desktop (`Antigravity.exe` / `Antigravity.app` / `antigravity`) 自 `2.33.0` 起
 * 默认不再于启动时开启 `--remote-debugging-port=0`，且独立 Electron 桌面端不读取 VS Code 系的 `argv.json`。
 *
 * 本模块在不触碰任何宿主二进制与 `app.asar` 的前提下，提供两层无感恢复能力：
 * 1. 日常全自动层 (`ensureDesktopLaunchEntriesConfigured`)：
 *    - Windows：自动为当前用户的桌面（含 OneDrive 重定向桌面）、开始菜单、任务栏固定图标、启动文件夹中的
 *      `Antigravity.lnk` 快捷方式及已存在的 `HKCU\...\Run` 自启项补齐 `--remote-debugging-port=0`；
 *    - Linux：自动在 `~/.local/share/applications/antigravity.desktop`（必要时自系统目录复制）与
 *      `~/.config/autostart/antigravity.desktop` 的 `Exec=` 中补齐 `--remote-debugging-port=0`；
 *    - 当用户切回「仅侧边栏」且无上下文窗口覆写时，可干净移除本插件托管的 `--remote-debugging-port=0`，绝不触碰用户自定义端口；
 * 2. 当下裸启动会话一键重拉层 (`triggerDesktopHostRelaunch`)：
 *    - Windows 通过 `Shell.Application` (`explorer.exe` 进程外 COM) 脱离宿主 Job Object 托管生命周期，
 *      macOS / Linux 通过独立会话 `nohup` 脱离进程组，自动退出系统托盘常驻实例、清理陈旧 `DevToolsActivePort`
 *      并以纯净桌面环境变量追加 `--remote-debugging-port=0` 重新拉起宿主客户端。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DATA_DIR, lsRuntimeEndpoint } from './config.mjs';

export const REMOTE_DEBUG_LAUNCH_FLAG = '--remote-debugging-port=0';

const REMOTE_DEBUG_ANY_RE = /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i;
const REMOTE_DEBUG_MANAGED_ZERO_RE = /(?:^|\s+)--remote-debugging-port=(?:"0"|'0'|0)(?=\s|$)/gi;

/**
 * 在命令行参数字符串中幂等补齐或移除托管的 `--remote-debugging-port=0`，保留用户自定义的其它参数或自定义端口。
 *
 * @param {unknown} rawArgs
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ changed: boolean, configured: boolean, alreadyConfigured?: boolean, removed?: boolean, args: string }}
 */
export function ensureRemoteDebugFlagInArgs(rawArgs, { enabled = true } = {}) {
  const current = String(rawArgs ?? '').trim();
  if (enabled) {
    if (REMOTE_DEBUG_ANY_RE.test(current)) {
      return {
        changed: false,
        configured: true,
        alreadyConfigured: true,
        args: current,
      };
    }
    const nextArgs = current
      ? `${current} ${REMOTE_DEBUG_LAUNCH_FLAG}`
      : REMOTE_DEBUG_LAUNCH_FLAG;
    return {
      changed: true,
      configured: true,
      args: nextArgs,
    };
  }

  if (!REMOTE_DEBUG_MANAGED_ZERO_RE.test(current)) {
    REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
    return {
      changed: false,
      configured: REMOTE_DEBUG_ANY_RE.test(current),
      args: current,
    };
  }
  REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
  const stripped = current.replace(REMOTE_DEBUG_MANAGED_ZERO_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  return {
    changed: stripped !== current,
    configured: REMOTE_DEBUG_ANY_RE.test(stripped),
    removed: stripped !== current,
    args: stripped,
  };
}

/**
 * 解析并无损修补 Windows `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 自启命令行字符串。
 * 严格仅匹配目标可执行文件名为 `Antigravity.exe` 的项（排除 `Antigravity IDE.exe` 及无关程序）。
 *
 * @param {unknown} rawValue
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, value: string }}
 */
export function patchWindowsRunRegistryCommand(rawValue, { enabled = true } = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const m = raw.match(/^\s*(?:"([^"]+)"|([^\s"]+))([\s\S]*)$/);
  if (!m) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const exePath = String(m[1] || m[2] || '').trim();
  const exeLeaf = exePath.split(/[\\/]/).pop() || '';
  if (exeLeaf.toLowerCase() !== 'antigravity.exe') {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const quotedExe = m[1] ? `"${exePath}"` : /\s/.test(exePath) ? `"${exePath}"` : exePath;
  const patchedArgs = ensureRemoteDebugFlagInArgs(m[3] || '', { enabled });
  const nextValue = patchedArgs.args ? `${quotedExe} ${patchedArgs.args}` : quotedExe;
  return {
    matched: true,
    changed: nextValue !== raw,
    configured: patchedArgs.configured,
    value: nextValue,
  };
}

/**
 * 修补 Linux XDG `.desktop` 文件文本中的 `Exec=` 启动行（仅作用于 `antigravity` 桌面端，不修改 `antigravity-ide`）。
 *
 * @param {string} rawText
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, text: string }}
 */
export function patchLinuxDesktopEntryText(rawText, { enabled = true } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { matched: false, changed: false, configured: false, text: String(rawText || '') };
  }
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawText.split(/\r?\n/);
  let matched = false;
  let changed = false;
  let configured = false;

  const nextLines = lines.map((line) => {
    const execMatch = line.match(/^(\s*Exec\s*=\s*)(.+)$/);
    if (!execMatch) return line;
    const prefix = execMatch[1];
    const cmdBody = execMatch[2].trim();
    const binMatch = cmdBody.match(/^(?:"([^"]+)"|'([^']+)'|([^\s"']+))([\s\S]*)$/);
    if (!binMatch) return line;
    const rawBin = String(binMatch[1] || binMatch[2] || binMatch[3] || '');
    const leaf = (rawBin.split('/').pop() || '').toLowerCase();
    if (leaf !== 'antigravity') {
      return line;
    }
    matched = true;
    const binToken = binMatch[1]
      ? `"${binMatch[1]}"`
      : binMatch[2]
        ? `'${binMatch[2]}'`
        : binMatch[3];
    const rest = String(binMatch[4] || '').trim();

    if (enabled) {
      if (REMOTE_DEBUG_ANY_RE.test(rest)) {
        configured = true;
        return line;
      }
      configured = true;
      changed = true;
      const fieldCodeMatch = rest.match(/^(.*?)\s*(%[fFuUdDnNickvm](?:\s+%[fFuUdDnNickvm])*)\s*$/);
      if (fieldCodeMatch) {
        const beforeCodes = fieldCodeMatch[1].trim();
        const codes = fieldCodeMatch[2].trim();
        const mid = beforeCodes
          ? `${beforeCodes} ${REMOTE_DEBUG_LAUNCH_FLAG}`
          : REMOTE_DEBUG_LAUNCH_FLAG;
        return `${prefix}${binToken} ${mid} ${codes}`;
      }
      return rest
        ? `${prefix}${binToken} ${rest} ${REMOTE_DEBUG_LAUNCH_FLAG}`
        : `${prefix}${binToken} ${REMOTE_DEBUG_LAUNCH_FLAG}`;
    }

    const stripped = ensureRemoteDebugFlagInArgs(rest, { enabled: false });
    configured = configured || stripped.configured;
    if (!stripped.changed) return line;
    changed = true;
    return stripped.args ? `${prefix}${binToken} ${stripped.args}` : `${prefix}${binToken}`;
  });

  return {
    matched,
    changed,
    configured,
    text: changed ? nextLines.join(eol) : rawText,
  };
}

/**
 * 清理 Sidecar / MCP 子进程继承的宿主会话私有环境变量，确保重拉后的客户端运行于纯净桌面上下文。
 *
 * @param {Record<string, string|undefined>} [baseEnv=process.env]
 * @returns {Record<string, string>}
 */
export function buildSanitizedDesktopRelaunchEnv(baseEnv = process.env) {
  const clean = {};
  for (const [key, val] of Object.entries(baseEnv || {})) {
    if (val === undefined || val === null) continue;
    if (
      /^(?:ANTIGRAVITY_|CHROME_DEVTOOLS_MCP_|USAGE_MONITOR_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(
        key
      )
    ) {
      continue;
    }
    clean[key] = String(val);
  }
  return clean;
}

/**
 * 自动定位本机 Antigravity Desktop（或 IDE）主程序路径（优先从 `ANTIGRAVITY_AGENTAPI_EXE` 向上反推，回退标准安装目录）。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   existsFn?: (p: string) => boolean,
 * }} [options]
 * @returns {{ found: boolean, kind: 'desktop'|'ide'|'', executablePath: string, appBundlePath: string }}
 */
export function resolveDesktopHostExecutable({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  existsFn = existsSync,
} = {}) {
  const safeExists = (p) => {
    try {
      return Boolean(p && existsFn(p));
    } catch {
      return false;
    }
  };

  const hintPaths = [
    String(env?.USAGE_MONITOR_HOST_EXE || '').trim(),
    String(env?.ANTIGRAVITY_AGENTAPI_EXE || '').trim(),
    String(env?.CHROME_DEVTOOLS_MCP_JS || '').trim(),
  ].filter(Boolean);

  for (const rawHint of hintPaths) {
    if (platform === 'darwin') {
      const appIdx = rawHint.toLowerCase().indexOf('.app/');
      const bundleCand =
        appIdx >= 0
          ? rawHint.slice(0, appIdx + 4)
          : rawHint.toLowerCase().endsWith('.app')
            ? rawHint
            : '';
      if (bundleCand && safeExists(bundleCand)) {
        const isIde = /antigravity\s*ide\.app$/i.test(bundleCand);
        const macBin = join(
          bundleCand,
          'Contents',
          'MacOS',
          isIde ? 'Antigravity IDE' : 'Antigravity'
        );
        return {
          found: true,
          kind: isIde ? 'ide' : 'desktop',
          executablePath: safeExists(macBin) ? macBin : bundleCand,
          appBundlePath: bundleCand,
        };
      }
    }

    if (platform === 'win32' && /\.exe$/i.test(rawHint) && !/language_server/i.test(rawHint)) {
      if (safeExists(rawHint)) {
        const isIde = /antigravity\s*ide\.exe$/i.test(rawHint);
        return {
          found: true,
          kind: isIde ? 'ide' : 'desktop',
          executablePath: rawHint,
          appBundlePath: '',
        };
      }
    }

    let cur = rawHint;
    for (let depth = 0; depth < 8 && cur && dirname(cur) !== cur; depth += 1) {
      const base = basename(cur).toLowerCase();
      if (base === 'resources') {
        const installRoot = dirname(cur);
        if (platform === 'win32') {
          const desktopExe = join(installRoot, 'Antigravity.exe');
          if (safeExists(desktopExe)) {
            return { found: true, kind: 'desktop', executablePath: desktopExe, appBundlePath: '' };
          }
          const ideExe = join(installRoot, 'Antigravity IDE.exe');
          if (safeExists(ideExe)) {
            return { found: true, kind: 'ide', executablePath: ideExe, appBundlePath: '' };
          }
        } else if (platform === 'linux') {
          for (const binName of ['antigravity', 'Antigravity']) {
            const linuxExe = join(installRoot, binName);
            if (safeExists(linuxExe)) {
              return { found: true, kind: 'desktop', executablePath: linuxExe, appBundlePath: '' };
            }
          }
        }
      }
      cur = dirname(cur);
    }
  }

  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    const programFiles = env?.ProgramFiles || 'C:\\Program Files';
    const winCandidates = [
      join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      join(programFiles, 'Antigravity', 'Antigravity.exe'),
      join(localAppData, 'Antigravity', 'Antigravity.exe'),
    ];
    for (const cand of winCandidates) {
      if (safeExists(cand)) {
        return { found: true, kind: 'desktop', executablePath: cand, appBundlePath: '' };
      }
    }
  } else if (platform === 'darwin') {
    const macBundles = [
      join(homeDir, 'Applications', 'Antigravity.app'),
      '/Applications/Antigravity.app',
    ];
    for (const bundlePath of macBundles) {
      if (safeExists(bundlePath)) {
        const macBin = join(bundlePath, 'Contents', 'MacOS', 'Antigravity');
        return {
          found: true,
          kind: 'desktop',
          executablePath: safeExists(macBin) ? macBin : bundlePath,
          appBundlePath: bundlePath,
        };
      }
    }
  } else {
    const linuxCandidates = [
      '/opt/Antigravity/antigravity',
      '/opt/antigravity/antigravity',
      '/usr/share/antigravity/antigravity',
      '/usr/bin/antigravity',
      join(homeDir, '.local', 'bin', 'antigravity'),
    ];
    for (const cand of linuxCandidates) {
      if (safeExists(cand)) {
        return { found: true, kind: 'desktop', executablePath: cand, appBundlePath: '' };
      }
    }
  }

  return { found: false, kind: '', executablePath: '', appBundlePath: '' };
}

async function runLauncherExecFile(file, args, options = {}) {
  const cpMod = await import('node:child_process');
  const execFileFn = cpMod.execFile || cpMod.default?.execFile;
  if (typeof execFileFn !== 'function') {
    throw new Error('child_process.execFile unavailable');
  }
  return new Promise((resolve, reject) => {
    execFileFn(
      file,
      args,
      {
        windowsHide: true,
        timeout: options.timeoutMs || 8000,
        maxBuffer: 1024 * 1024,
        env: options.env || process.env,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

async function spawnDetachedProcess(file, args, options = {}) {
  const cpMod = await import('node:child_process');
  const spawnFn = cpMod.spawn || cpMod.default?.spawn;
  if (typeof spawnFn !== 'function') {
    throw new Error('child_process.spawn unavailable');
  }
  const child = spawnFn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: options.cwd || undefined,
    env: options.env || process.env,
  });
  child.unref?.();
  return { pid: Number(child?.pid || 0) };
}

function writeTextFileAtomically(filePath, content, fsOps) {
  const { mkdirFn, writeFn, renameFn, unlinkFn } = fsOps;
  mkdirFn(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFn(tmpPath, content, 'utf8');
    renameFn(tmpPath, filePath);
  } catch {
    try {
      unlinkFn(tmpPath);
    } catch {
      // 忽略临时文件清理异常
    }
    writeFn(filePath, content, 'utf8');
  }
}

const WIN_SHORTCUT_PROVISION_PS = `
$ErrorActionPreference = 'Stop'
$enableFlag = $env:AGY_LAUNCH_ENABLED -eq '1'
$updated = New-Object System.Collections.Generic.List[string]
$configured = New-Object System.Collections.Generic.List[string]
$ws = New-Object -ComObject WScript.Shell
$userProgramsDir = [Environment]::GetFolderPath('Programs')

$scanSpecs = @(
  @{ Dir = [Environment]::GetFolderPath('Desktop'); Recurse = $false; IsCommon = $false },
  @{ Dir = $userProgramsDir; Recurse = $true; IsCommon = $false },
  @{ Dir = [Environment]::GetFolderPath('StartMenu'); Recurse = $false; IsCommon = $false },
  @{ Dir = [Environment]::GetFolderPath('Startup'); Recurse = $false; IsCommon = $false },
  @{ Dir = (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'); Recurse = $false; IsCommon = $false },
  @{ Dir = [Environment]::GetFolderPath('CommonDesktopDirectory'); Recurse = $false; IsCommon = $true },
  @{ Dir = [Environment]::GetFolderPath('CommonPrograms'); Recurse = $true; IsCommon = $true }
)

$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($spec in $scanSpecs) {
  $dir = [string]$spec.Dir
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  $items = @()
  try {
    if ($spec.Recurse) {
      $items = @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue)
    } else {
      $items = @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -ErrorAction SilentlyContinue)
    }
  } catch { continue }

  foreach ($item in $items) {
    $lnkPath = [string]$item.FullName
    if (-not $seen.Add($lnkPath)) { continue }
    try {
      $sc = $ws.CreateShortcut($lnkPath)
      $target = [string]$sc.TargetPath
      if ([System.IO.Path]::GetFileName($target) -ine 'Antigravity.exe') { continue }
      $curArgs = [string]$sc.Arguments
      if ($enableFlag) {
        if ($curArgs -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
          $configured.Add($lnkPath)
          continue
        }
        $nextArgs = ($curArgs.Trim() + ' --remote-debugging-port=0').Trim()
        try {
          $sc.Arguments = $nextArgs
          $sc.Save()
          $updated.Add($lnkPath)
          $configured.Add($lnkPath)
        } catch {
          if ($spec.IsCommon -and $userProgramsDir -and (Test-Path -LiteralPath $userProgramsDir)) {
            $fallbackLnk = Join-Path $userProgramsDir ([System.IO.Path]::GetFileName($lnkPath))
            if (-not (Test-Path -LiteralPath $fallbackLnk)) {
              try {
                $uSc = $ws.CreateShortcut($fallbackLnk)
                $uSc.TargetPath = $target
                $uSc.Arguments = $nextArgs
                if ($sc.WorkingDirectory) { $uSc.WorkingDirectory = $sc.WorkingDirectory }
                if ($sc.IconLocation) { $uSc.IconLocation = $sc.IconLocation }
                if ($sc.Description) { $uSc.Description = $sc.Description }
                $uSc.Save()
                $updated.Add($fallbackLnk)
                $configured.Add($fallbackLnk)
              } catch {}
            }
          }
        }
      } else {
        $stripped = ([regex]::Replace($curArgs, '(?:^|\\s+)--remote-debugging-port=(?:"0"|''0''|0)(?=\\s|$)', ' ')).Trim()
        if ($stripped -ne $curArgs.Trim()) {
          try {
            $sc.Arguments = $stripped
            $sc.Save()
            $updated.Add($lnkPath)
          } catch {}
        }
        if ($stripped -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
          $configured.Add($lnkPath)
        }
      }
    } catch {}
  }
}

$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
if (Test-Path -LiteralPath $runKey) {
  try {
    $regItem = Get-Item -LiteralPath $runKey -ErrorAction SilentlyContinue
    if ($regItem) {
      foreach ($valName in $regItem.GetValueNames()) {
        $rawCmd = [string]$regItem.GetValue($valName, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (-not $rawCmd) { continue }
        if ($rawCmd -notmatch '^\\s*(?:"([^"]+)"|([^\\s"]+))(.*)$') { continue }
        $exeCandidate = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        $restPart = [string]$Matches[3]
        if ([System.IO.Path]::GetFileName($exeCandidate) -ine 'Antigravity.exe') { continue }
        $quotedExe = if ($Matches[1] -or $exeCandidate -match '\\s') { '"' + $exeCandidate + '"' } else { $exeCandidate }
        if ($enableFlag) {
          if ($restPart -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
            $configured.Add("HKCU:Run:$valName")
            continue
          }
          $nextRest = ($restPart.Trim() + ' --remote-debugging-port=0').Trim()
          $nextVal = "$quotedExe $nextRest"
          Set-ItemProperty -LiteralPath $runKey -Name $valName -Value $nextVal -ErrorAction SilentlyContinue
          $updated.Add("HKCU:Run:$valName")
          $configured.Add("HKCU:Run:$valName")
        } else {
          $strippedRest = ([regex]::Replace($restPart, '(?:^|\\s+)--remote-debugging-port=(?:"0"|''0''|0)(?=\\s|$)', ' ')).Trim()
          $nextVal = if ($strippedRest) { "$quotedExe $strippedRest" } else { $quotedExe }
          if ($nextVal -ne $rawCmd.Trim()) {
            Set-ItemProperty -LiteralPath $runKey -Name $valName -Value $nextVal -ErrorAction SilentlyContinue
            $updated.Add("HKCU:Run:$valName")
          }
          if ($strippedRest -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
            $configured.Add("HKCU:Run:$valName")
          }
        }
      }
    }
  } catch {}
}

[pscustomobject]@{
  ok = $true
  updatedPaths = @($updated)
  configuredPaths = @($configured)
} | ConvertTo-Json -Compress
`.trim();

/**
 * 自动同步当前系统下用户空间启动入口（Windows `.lnk` / `HKCU:Run`、Linux `.desktop`）中的 `--remote-debugging-port=0`。
 *
 * @param {{
 *   enabled?: boolean,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   execFileFn?: ((file: string, args: string[], opts?: object) => Promise<string>)|null,
 *   fsOps?: {
 *     existsFn?: typeof existsSync,
 *     readFn?: typeof readFileSync,
 *     writeFn?: typeof writeFileSync,
 *     mkdirFn?: typeof mkdirSync,
 *     renameFn?: typeof renameSync,
 *     unlinkFn?: typeof unlinkSync,
 *   }|null,
 *   allowInTest?: boolean,
 * }} [options]
 */
export async function ensureDesktopLaunchEntriesConfigured({
  enabled = true,
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  execFileFn = null,
  fsOps = null,
  allowInTest = false,
} = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest) {
    return {
      checked: false,
      updated: false,
      alreadyConfigured: false,
      updatedPaths: [],
      configuredPaths: [],
      reason: 'test_sandbox_skipped',
    };
  }

  const ops = {
    existsFn: fsOps?.existsFn || existsSync,
    readFn: fsOps?.readFn || readFileSync,
    writeFn: fsOps?.writeFn || writeFileSync,
    mkdirFn: fsOps?.mkdirFn || mkdirSync,
    renameFn: fsOps?.renameFn || renameSync,
    unlinkFn: fsOps?.unlinkFn || unlinkSync,
  };

  if (platform === 'win32') {
    try {
      const runner = execFileFn || runLauncherExecFile;
      const out = await runner(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SHORTCUT_PROVISION_PS],
        {
          timeoutMs: 9000,
          env: {
            ...env,
            AGY_LAUNCH_ENABLED: enabled ? '1' : '0',
          },
        }
      );
      const trimmed = String(out || '').trim();
      const jsonLine = trimmed.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{')) || '';
      const parsed = jsonLine ? JSON.parse(jsonLine) : null;
      const updatedPaths = Array.isArray(parsed?.updatedPaths)
        ? parsed.updatedPaths.map(String).filter(Boolean)
        : [];
      const configuredPaths = Array.isArray(parsed?.configuredPaths)
        ? parsed.configuredPaths.map(String).filter(Boolean)
        : [];
      return {
        checked: true,
        updated: updatedPaths.length > 0,
        alreadyConfigured: updatedPaths.length === 0 && configuredPaths.length > 0,
        configured: configuredPaths.length > 0,
        updatedPaths,
        configuredPaths,
      };
    } catch (err) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: false,
        configured: false,
        updatedPaths: [],
        configuredPaths: [],
        reason: 'win_shortcut_error',
        error: err?.message || String(err),
      };
    }
  }

  if (platform === 'linux') {
    const dataHome = env?.XDG_DATA_HOME || join(homeDir, '.local', 'share');
    const configHome = env?.XDG_CONFIG_HOME || join(homeDir, '.config');
    const userDesktopFile = join(dataHome, 'applications', 'antigravity.desktop');
    const systemDesktopFiles = [
      '/usr/share/applications/antigravity.desktop',
      '/usr/local/share/applications/antigravity.desktop',
    ];
    const autostartDesktopFile = join(configHome, 'autostart', 'antigravity.desktop');

    const updatedPaths = [];
    const configuredPaths = [];

    try {
      let baseUserText = '';
      if (ops.existsFn(userDesktopFile)) {
        baseUserText = String(ops.readFn(userDesktopFile, 'utf8') || '');
      } else if (enabled) {
        const sysSource = systemDesktopFiles.find((p) => ops.existsFn(p));
        if (sysSource) {
          baseUserText = String(ops.readFn(sysSource, 'utf8') || '');
        }
      }
      if (baseUserText) {
        const patched = patchLinuxDesktopEntryText(baseUserText, { enabled });
        if (patched.changed) {
          writeTextFileAtomically(userDesktopFile, patched.text, ops);
          updatedPaths.push(userDesktopFile);
        }
        if (patched.configured) {
          configuredPaths.push(userDesktopFile);
        }
      }

      if (ops.existsFn(autostartDesktopFile)) {
        const autoRaw = String(ops.readFn(autostartDesktopFile, 'utf8') || '');
        const patchedAuto = patchLinuxDesktopEntryText(autoRaw, { enabled });
        if (patchedAuto.changed) {
          writeTextFileAtomically(autostartDesktopFile, patchedAuto.text, ops);
          updatedPaths.push(autostartDesktopFile);
        }
        if (patchedAuto.configured) {
          configuredPaths.push(autostartDesktopFile);
        }
      }

      return {
        checked: true,
        updated: updatedPaths.length > 0,
        alreadyConfigured: updatedPaths.length === 0 && configuredPaths.length > 0,
        configured: configuredPaths.length > 0,
        updatedPaths,
        configuredPaths,
      };
    } catch (err) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: false,
        configured: false,
        updatedPaths,
        configuredPaths,
        reason: 'linux_desktop_error',
        error: err?.message || String(err),
      };
    }
  }

  // macOS `.app` 包具有 Apple 代码签名，不修改签名目录，交由一键重拉 (`open -a ... --args`) 处理
  return {
    checked: true,
    updated: false,
    alreadyConfigured: false,
    configured: false,
    updatedPaths: [],
    configuredPaths: [],
    reason: 'macos_app_bundle_signed',
  };
}

/**
 * 当静态环境变量与默认安装目录均未命中（如用户自定义安装至 D:/E: 盘且 Sidecar 未继承 `ANTIGRAVITY_AGENTAPI_EXE`）时，
 * 直接从当前正在运行的宿主进程动态反查主程序绝对路径。
 */
async function discoverRunningHostExecutable({ platform = process.platform, execFileFn = null } = {}) {
  const runner = execFileFn || runLauncherExecFile;
  if (platform === 'win32') {
    try {
      const ps =
        "@(Get-Process -Name 'Antigravity','Antigravity IDE' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1) | ForEach-Object { [pscustomobject]@{ path = [string]$_.Path; name = [string]$_.ProcessName } } | ConvertTo-Json -Compress";
      const out = await runner(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { timeoutMs: 4000 }
      );
      const trimmed = String(out || '').trim();
      if (trimmed && trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        const exePath = String(parsed?.path || '').trim();
        if (exePath) {
          const isIde = /ide/i.test(String(parsed?.name || '')) || /antigravity\s*ide\.exe$/i.test(exePath);
          return {
            found: true,
            kind: isIde ? 'ide' : 'desktop',
            executablePath: exePath,
            appBundlePath: '',
          };
        }
      }
    } catch {
      // 忽略动态进程探测异常
    }
  } else if (platform === 'darwin') {
    try {
      const out = await runner(
        'osascript',
        ['-e', 'POSIX path of (path to application "Antigravity")'],
        { timeoutMs: 3000 }
      );
      const bundlePath = String(out || '').trim().replace(/\/+$/, '');
      if (bundlePath && /\.app$/i.test(bundlePath)) {
        return {
          found: true,
          kind: 'desktop',
          executablePath: bundlePath,
          appBundlePath: bundlePath,
        };
      }
    } catch {
      // 忽略 AppleScript 探测异常
    }
  }
  return { found: false, kind: '', executablePath: '', appBundlePath: '' };
}

function psSingleQuote(val) {
  return `'${String(val ?? '').replace(/'/g, "''")}'`;
}

/**
 * 构建 Windows 脱离宿主 Job Object 的隐藏重拉内层脚本（写入临时 UTF-8 BOM `.ps1` 文件后交由 `explorer.exe` 拉起，规避 `ShellExecute` 参数长度上限）。
 *
 * @param {string} executablePath
 * @param {string[]} stalePortFiles
 * @param {'desktop'|'ide'|''} kind
 * @returns {string}
 */
export function buildWindowsRelaunchInnerScript(executablePath, stalePortFiles = [], kind = 'desktop') {
  const procName = kind === 'ide' ? 'Antigravity IDE' : 'Antigravity';
  const portLiterals = (Array.isArray(stalePortFiles) ? stalePortFiles : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map(psSingleQuote)
    .join(', ');

  return `
Start-Sleep -Milliseconds 480
$exe = ${psSingleQuote(executablePath)}
$procName = ${psSingleQuote(procName)}
$staleList = @(${portLiterals})
$mySid = (Get-Process -Id $PID).SessionId

if (-not $exe -or -not (Test-Path -LiteralPath $exe)) {
  $livePath = Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $mySid -and $_.Path } | Select-Object -First 1 -ExpandProperty Path
  if ($livePath) { $exe = [string]$livePath }
}

$findTargets = {
  @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object {
    $_.SessionId -eq $mySid -and (-not $_.Path -or -not $exe -or [string]::Equals($_.Path, $exe, [System.StringComparison]::OrdinalIgnoreCase))
  })
}

$initial = & $findTargets
foreach ($p in $initial) {
  try {
    if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() }
  } catch {}
}
Start-Sleep -Milliseconds 850

$remaining = & $findTargets
foreach ($p in $remaining) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
}

for ($i = 0; $i -lt 30; $i++) {
  if ((& $findTargets).Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
}

foreach ($fp in $staleList) {
  if ($fp -and (Test-Path -LiteralPath $fp)) {
    try { Remove-Item -LiteralPath $fp -Force -ErrorAction SilentlyContinue } catch {}
  }
}

if ($exe -and (Test-Path -LiteralPath $exe)) {
  $workDir = Split-Path -Parent $exe
  Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=0' -WorkingDirectory $workDir
}

if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`.trim();
}

const WIN_OUT_OF_JOB_DISPATCH_PS = `
$ErrorActionPreference = 'Stop'
$innerArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $env:AGY_RELAUNCH_PS1 + '"'
try {
  $shellApp = New-Object -ComObject Shell.Application
  $shellApp.ShellExecute('powershell.exe', $innerArgs, '', 'open', 0)
  Write-Output '{"ok":true,"method":"shell_application"}'
} catch {
  Start-Process -FilePath 'powershell.exe' -ArgumentList $innerArgs -WindowStyle Hidden
  Write-Output '{"ok":true,"method":"start_process"}'
}
`.trim();

/**
 * 触发跨平台一键退出系统托盘后台并追加 `--remote-debugging-port=0` 重新拉起宿主客户端。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   stalePortFiles?: string[],
 *   execFileFn?: ((file: string, args: string[], opts?: object) => Promise<string>)|null,
 *   spawnFn?: ((file: string, args: string[], opts?: object) => Promise<{ pid: number }>)|null,
 *   existsFn?: typeof existsSync,
 *   writeFileFn?: typeof writeFileSync,
 *   mkdirFn?: typeof mkdirSync,
 *   allowInTest?: boolean,
 * }} [options]
 */
export async function triggerDesktopHostRelaunch({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  stalePortFiles = [],
  execFileFn = null,
  spawnFn = null,
  existsFn = existsSync,
  writeFileFn = writeFileSync,
  mkdirFn = mkdirSync,
  allowInTest = false,
} = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest) {
    return { ok: false, status: 403, error: 'Disabled in test sandbox' };
  }

  let hostInfo = resolveDesktopHostExecutable({ env, platform, homeDir, existsFn });
  if (!hostInfo.found) {
    hostInfo = await discoverRunningHostExecutable({ platform, execFileFn });
  }
  if (!hostInfo.found) {
    return {
      ok: false,
      status: 404,
      error: 'Unable to locate Antigravity executable on this machine',
    };
  }

  const cleanEnv = buildSanitizedDesktopRelaunchEnv(env);
  const cleanStaleFiles = (Array.isArray(stalePortFiles) ? stalePortFiles : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  if (platform === 'win32') {
    const innerScript = buildWindowsRelaunchInnerScript(
      hostInfo.executablePath,
      cleanStaleFiles,
      hostInfo.kind
    );
    const tempDir = String(env?.TEMP || env?.TMP || DATA_DIR || homeDir).trim();
    mkdirFn(tempDir, { recursive: true });
    const relaunchPs1Path = join(tempDir, `agy-monitor-relaunch-${process.pid}.ps1`);
    // UTF-8 with BOM ensures Windows PowerShell 5.1 parses non-ASCII paths accurately across all system locales
    writeFileFn(relaunchPs1Path, `\uFEFF${innerScript}\r\n`, 'utf8');

    const runner = execFileFn || runLauncherExecFile;
    await runner(
      'powershell.exe',
      [
        '-Sta',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WIN_OUT_OF_JOB_DISPATCH_PS,
      ],
      {
        timeoutMs: 6000,
        env: {
          ...cleanEnv,
          AGY_RELAUNCH_PS1: relaunchPs1Path,
        },
      }
    );
    return {
      ok: true,
      relaunching: true,
      platform,
      executablePath: hostInfo.executablePath,
    };
  }

  const spawner = spawnFn || spawnDetachedProcess;

  if (platform === 'darwin') {
    const appTarget = hostInfo.appBundlePath || hostInfo.executablePath;
    const appName = hostInfo.kind === 'ide' ? 'Antigravity IDE' : 'Antigravity';
    const shScript = [
      'sleep 0.45',
      `osascript -e 'tell application "${appName}" to quit' >/dev/null 2>&1 || true`,
      `i=0; while [ $i -lt 25 ] && pgrep -x "${appName}" >/dev/null 2>&1; do sleep 0.2; i=$((i+1)); done`,
      `if pgrep -x "${appName}" >/dev/null 2>&1; then killall "${appName}" >/dev/null 2>&1 || true; sleep 0.4; fi`,
      'IFS=":"; for f in $AGY_STALE_PORT_FILES; do [ -n "$f" ] && rm -f "$f"; done',
      'open -a "$AGY_RELAUNCH_APP" --args --remote-debugging-port=0 >/dev/null 2>&1',
    ].join('; ');
    await spawner('/bin/sh', ['-c', shScript], {
      env: {
        ...cleanEnv,
        AGY_RELAUNCH_APP: appTarget,
        AGY_STALE_PORT_FILES: cleanStaleFiles.join(':'),
      },
    });
    return {
      ok: true,
      relaunching: true,
      platform,
      executablePath: appTarget,
    };
  }

  const procLeaf = basename(hostInfo.executablePath) || 'antigravity';
  const linuxScript = [
    'sleep 0.45',
    'uid="$(id -u)"',
    'pkill -u "$uid" -x "$AGY_PROC_NAME" >/dev/null 2>&1 || true',
    'i=0; while [ $i -lt 25 ] && pgrep -u "$uid" -x "$AGY_PROC_NAME" >/dev/null 2>&1; do sleep 0.2; i=$((i+1)); done',
    'IFS=":"; for f in $AGY_STALE_PORT_FILES; do [ -n "$f" ] && rm -f "$f"; done',
    'nohup "$AGY_RELAUNCH_EXE" --remote-debugging-port=0 >/dev/null 2>&1 &',
  ].join('; ');
  await spawner('/bin/sh', ['-c', linuxScript], {
    env: {
      ...cleanEnv,
      AGY_RELAUNCH_EXE: hostInfo.executablePath,
      AGY_PROC_NAME: procLeaf,
      AGY_STALE_PORT_FILES: cleanStaleFiles.join(':'),
    },
  });
  return {
    ok: true,
    relaunching: true,
    platform,
    executablePath: hostInfo.executablePath,
  };
}

/**
 * 解析 POSIX `ps -o etime=` 时间字符串（支持 `MM:SS`、`HH:MM:SS`、`DD-HH:MM:SS`）为秒数。
 *
 * @param {unknown} etimeStr
 * @returns {number|null}
 */
export function parsePsElapsedSeconds(etimeStr) {
  const raw = String(etimeStr ?? '').trim();
  if (!raw) return null;
  let days = 0;
  let timePart = raw;
  const dashIdx = raw.indexOf('-');
  if (dashIdx >= 0) {
    const dayStr = raw.slice(0, dashIdx);
    if (!/^\d+$/.test(dayStr)) return null;
    days = Number(dayStr);
    timePart = raw.slice(dashIdx + 1);
  }
  const parts = timePart.split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const hours = parts.length === 3 ? nums[0] : 0;
  const mins = parts.length === 3 ? nums[1] : nums[0];
  const secs = parts.length === 3 ? nums[2] : nums[1];
  if (mins >= 60 || secs >= 60 || (parts.length === 3 && hours >= 24)) return null;
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

/**
 * 检测本机当前正在运行的 macOS Antigravity Desktop 主进程及其已运行时长与调试参数状态。
 *
 * @param {{ execFileFn?: ((file: string, args: string[], opts?: object) => Promise<string>)|null }} [options]
 * @returns {Promise<{ pid: number, elapsedSec: number|null, hasRemoteDebugFlag: boolean, command: string } | null>}
 */
export async function inspectRunningDarwinDesktopHost({ execFileFn = null } = {}) {
  const runner = execFileFn || runLauncherExecFile;
  try {
    const stdout = await runner('ps', ['-axo', 'pid=,etime=,command='], { timeoutMs: 2500 });
    for (const rawLine of String(stdout || '').split(/\r?\n/)) {
      const m = rawLine.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const etime = m[2];
      const command = m[3];
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (/Antigravity Helper/i.test(command) || /Antigravity IDE\.app/i.test(command)) continue;
      if (!/(?:^|\/)Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/.test(command)) continue;
      return {
        pid,
        elapsedSec: parsePsElapsedSeconds(etime),
        hasRemoteDebugFlag: REMOTE_DEBUG_ANY_RE.test(command),
        command,
      };
    }
  } catch {
    // 忽略 ps 进程探测异常
  }
  return null;
}

function shSingleQuote(val) {
  return `'${String(val ?? '').replace(/'/g, `'\\''`)}'`;
}

export const DARWIN_TERMINAL_RELAUNCH_SCRIPT_NAME = 'relaunch-antigravity-debug.command';

/**
 * 构建 macOS 外部 Terminal `.command` 重拉与校验脚本（纯 UTF-8 / LF / Bash 3.2 兼容）：
 * 检测带调试端口状态 -> 平滑终止旧实例（Main + Helper + language_server）-> 清理陈旧端口文件 ->
 * 以 `--remote-debugging-port=0` 重启 Antigravity -> 校验端口就绪 -> 等待插件真实挂载底部额度栏 ->
 * 确认运行成功后再倒计时 3 秒并仅关闭当前单标签 Terminal 窗口。
 *
 * @param {{
 *   appBundlePath?: string,
 *   kind?: 'desktop'|'ide'|'',
 *   stalePortFiles?: string[],
 *   homeDir?: string,
 *   leaseFilePath?: string,
 * }} [options]
 * @returns {string}
 */
export function buildDarwinTerminalRelaunchScript({
  appBundlePath = '/Applications/Antigravity.app',
  kind = 'desktop',
  stalePortFiles = [],
  homeDir = homedir(),
  leaseFilePath = join(DATA_DIR, 'window-bridge-lease.json'),
} = {}) {
  const cleanBundle =
    String(appBundlePath || '/Applications/Antigravity.app')
      .trim()
      .replace(/\/+$/, '') || '/Applications/Antigravity.app';
  const appBinName = kind === 'ide' ? 'Antigravity IDE' : 'Antigravity';
  const defaultPortFile = join(
    homeDir || homedir(),
    'Library',
    'Application Support',
    appBinName,
    'DevToolsActivePort'
  );
  const rawPorts = Array.isArray(stalePortFiles) ? stalePortFiles : [];
  const portList = [...new Set(rawPorts.map((p) => String(p || '').trim()).filter(Boolean))];
  if (portList.length === 0) {
    portList.push(defaultPortFile);
  }
  const portLiterals = portList.map(shSingleQuote).join(' ');
  const resolvedLeaseFile =
    String(leaseFilePath || '').trim() || join(DATA_DIR, 'window-bridge-lease.json');

  return [
    '#!/bin/bash',
    'export PATH="/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"',
    '',
    `APP_BUNDLE=${shSingleQuote(cleanBundle)}`,
    `APP_BIN_NAME=${shSingleQuote(appBinName)}`,
    'APP_MAIN_BIN="${APP_BUNDLE}/Contents/MacOS/${APP_BIN_NAME}"',
    'APP_CONTENTS_PREFIX="${APP_BUNDLE}/Contents/"',
    `PORT_FILES=(${portLiterals})`,
    `LEASE_FILE=${shSingleQuote(resolvedLeaseFile)}`,
    '',
    'echo "========================================"',
    'echo "  Antigravity 底部额度栏自动拉起工具"',
    'echo "========================================"',
    'echo ""',
    '',
    'MY_TTY="$(tty 2>/dev/null || true)"',
    'TARGET_WIN_ID=""',
    'if [ -n "$MY_TTY" ]; then',
    '  TARGET_WIN_ID="$(/usr/bin/osascript - "$MY_TTY" 2>/dev/null <<\'APPLESCRIPT\' || true',
    'on run argv',
    '  set targetTty to item 1 of argv',
    '  tell application "Terminal"',
    '    repeat with w in windows',
    '      try',
    '        if (count of tabs of w) is 1 then',
    '          repeat with t in tabs of w',
    '            if (tty of t as text) is targetTty then',
    '              return (id of w) as text',
    '            end if',
    '          end repeat',
    '        end if',
    '      end try',
    '    end repeat',
    '  end tell',
    '  return ""',
    'end run',
    'APPLESCRIPT',
    ')"',
    'fi',
    '',
    'find_main_pids() {',
    '  ps -axo pid=,command= | awk -v bin="$APP_MAIN_BIN" \'',
    '    {',
    '      pid = $1',
    '      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)',
    '      if ($0 == bin || index($0, bin " ") == 1) {',
    '        print pid',
    '      }',
    '    }',
    '  \'',
    '}',
    '',
    'main_has_debug_flag() {',
    '  ps -axo pid=,command= | awk -v bin="$APP_MAIN_BIN" \'',
    '    BEGIN { found = 0 }',
    '    {',
    '      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)',
    '      if ($0 == bin || index($0, bin " ") == 1) {',
    '        if ($0 ~ /(^|[[:space:]])--remote-debugging-port(=|[[:space:]]|$)/) {',
    '          found = 1',
    '        }',
    '      }',
    '    }',
    '    END { exit(found ? 0 : 1) }',
    '  \'',
    '}',
    '',
    'find_all_app_pids() {',
    '  ps -axo pid=,command= | awk -v pfx="$APP_CONTENTS_PREFIX" \'',
    '    {',
    '      pid = $1',
    '      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)',
    '      if (index($0, pfx) == 1) {',
    '        print pid',
    '      }',
    '    }',
    '  \'',
    '}',
    '',
    'read_active_devtools_port() {',
    '  local pf=""',
    '  local first_line=""',
    '  for pf in "${PORT_FILES[@]}"; do',
    '    [ -s "$pf" ] || continue',
    '    first_line="$(head -n 1 "$pf" 2>/dev/null | tr -d \'\\r\\n[:space:]\')"',
    '    case "$first_line" in',
    '      \'\'|*[!0-9]*) continue ;;',
    '    esac',
    '    if [ "$first_line" -gt 0 ] 2>/dev/null; then',
    '      printf \'%s\\n\' "$first_line"',
    '      return 0',
    '    fi',
    '  done',
    '  return 1',
    '}',
    '',
    'now_epoch_ms() {',
    '  /usr/bin/perl -MTime::HiRes=time -e \'print int(time() * 1000)\'',
    '}',
    '',
    'check_bridge_mounted() {',
    '  local min_ms="${1:-0}"',
    '  /usr/bin/perl -MJSON::PP -MErrno=EPERM -e \'',
    '    my ($path, $min_ms) = @ARGV;',
    '    $min_ms = 0 + ($min_ms || 0);',
    '    open(my $fh, "<", $path) or exit 1;',
    '    local $/;',
    '    my $raw = <$fh>;',
    '    close($fh);',
    '    my $d = eval { decode_json($raw) };',
    '    exit 1 if ref($d) ne "HASH";',
    '    exit 1 if ($d->{syncState} // "") ne "active";',
    '    my $alive = int($d->{aliveCount} // 0);',
    '    exit 1 if $alive < 1;',
    '    my $pid = int($d->{pid} // 0);',
    '    exit 1 if $pid <= 0;',
    '    exit 1 unless (kill(0, $pid) || $! == EPERM);',
    '    my $updated = 0 + ($d->{updatedAtMs} // 0);',
    '    exit 1 if ($min_ms > 0 && $updated < $min_ms);',
    '    print $alive;',
    '    exit 0;',
    '  \' "$LEASE_FILE" "$min_ms" 2>/dev/null',
    '}',
    '',
    'describe_lease_state() {',
    '  /usr/bin/perl -MJSON::PP -e \'',
    '    my ($path) = @ARGV;',
    '    if (!-e $path) { print "lease文件不存在"; exit 0; }',
    '    open(my $fh, "<", $path) or do { print "无法读取lease文件"; exit 0; };',
    '    local $/;',
    '    my $raw = <$fh>;',
    '    close($fh);',
    '    my $d = eval { decode_json($raw) };',
    '    if (ref($d) ne "HASH") { print "lease内容解析失败"; exit 0; }',
    '    printf "syncState=%s, aliveCount=%s, pid=%s", ($d->{syncState} // "none"), ($d->{aliveCount} // 0), ($d->{pid} // 0);',
    '  \' "$LEASE_FILE" 2>/dev/null || echo "未知状态"',
    '}',
    '',
    'schedule_close_this_window() {',
    '  echo ""',
    '  echo "⏳ 已确认运行成功，将在 3 秒后自动关闭此终端窗口："',
    '  for n in 3 2 1; do',
    '    echo "   ${n}..."',
    '    sleep 1',
    '  done',
    '  case "$TARGET_WIN_ID" in',
    '    \'\'|*[!0-9]*) ;;',
    '    *)',
    '      /usr/bin/perl -MPOSIX -e \'',
    '        my $wid = $ARGV[0];',
    '        my $pid = fork();',
    '        exit 0 if !defined($pid) || $pid > 0;',
    '        POSIX::setsid();',
    '        open(STDIN, "<", "/dev/null");',
    '        open(STDOUT, ">", "/dev/null");',
    '        open(STDERR, ">", "/dev/null");',
    '        select(undef, undef, undef, 0.45);',
    '        exec("/usr/bin/osascript", "-e", "tell application \\"Terminal\\" to close (every window whose id is " . $wid . ") saving no");',
    '      \' "$TARGET_WIN_ID" >/dev/null 2>&1 || true',
    '      ;;',
    '  esac',
    '  exit 0',
    '}',
    '',
    'SKIP_RELAUNCH=0',
    'MIN_LEASE_MS=0',
    'ACTIVE_PORT="$(read_active_devtools_port || true)"',
    'if main_has_debug_flag && [ -n "$ACTIVE_PORT" ]; then',
    '  ALIVE_COUNT="$(check_bridge_mounted 0 || true)"',
    '  if [ -n "$ALIVE_COUNT" ]; then',
    '    echo "========================================"',
    '    echo "✅ 运行成功！反重力与底部用量额度栏均已正常运行！"',
    '    echo "   本地调试端口：${ACTIVE_PORT} | 已挂载窗口：${ALIVE_COUNT}"',
    '    echo "========================================"',
    '    schedule_close_this_window',
    '  fi',
    '  SKIP_RELAUNCH=1',
    '  echo "✔ 检测到本地调试端口已就绪（${ACTIVE_PORT}），正在等待底部用量与额度栏挂载完成..."',
    'fi',
    '',
    'if [ "$SKIP_RELAUNCH" -eq 0 ]; then',
    '  echo "[1/4] 正在关闭未启用调试端口的旧反重力进程..."',
    '  MAIN_PIDS="$(find_main_pids || true)"',
    '  if [ -n "$MAIN_PIDS" ]; then',
    '    for p in $MAIN_PIDS; do',
    '      kill -TERM "$p" 2>/dev/null || true',
    '    done',
    '  fi',
    '',
    '  i=0',
    '  while [ $i -lt 35 ]; do',
    '    REMAIN_PIDS="$(find_all_app_pids || true)"',
    '    [ -z "$REMAIN_PIDS" ] && break',
    '    if [ $i -eq 25 ]; then',
    '      for p in $REMAIN_PIDS; do',
    '        kill -TERM "$p" 2>/dev/null || true',
    '      done',
    '    fi',
    '    sleep 0.2',
    '    i=$((i + 1))',
    '  done',
    '',
    '  REMAIN_PIDS="$(find_all_app_pids || true)"',
    '  if [ -n "$REMAIN_PIDS" ]; then',
    '    for p in $REMAIN_PIDS; do',
    '      kill -KILL "$p" 2>/dev/null || true',
    '    done',
    '    j=0',
    '    while [ $j -lt 15 ] && [ -n "$(find_all_app_pids || true)" ]; do',
    '      sleep 0.2',
    '      j=$((j + 1))',
    '    done',
    '  fi',
    '  sleep 0.8',
    '',
    '  for pf in "${PORT_FILES[@]}"; do',
    '    rm -f "$pf" 2>/dev/null || true',
    '  done',
    '',
    '  MIN_LEASE_MS="$(now_epoch_ms)"',
    '',
    '  echo "[2/4] 正在以调试参数 (--remote-debugging-port=0) 启动 ${APP_BIN_NAME}..."',
    '  /usr/bin/open -a "$APP_BUNDLE" --args --remote-debugging-port=0 || true',
    '',
    '  echo "[3/4] 正在等待本地调试端口就绪..."',
    '  ACTIVE_PORT=""',
    '  k=0',
    '  while [ $k -lt 50 ]; do',
    '    if main_has_debug_flag; then',
    '      ACTIVE_PORT="$(read_active_devtools_port || true)"',
    '      if [ -n "$ACTIVE_PORT" ]; then',
    '        break',
    '      fi',
    '    fi',
    '    if [ $k -eq 14 ] && [ -z "$(find_main_pids || true)" ]; then',
    '      /usr/bin/open -n -a "$APP_BUNDLE" --args --remote-debugging-port=0 || true',
    '    fi',
    '    sleep 0.3',
    '    k=$((k + 1))',
    '  done',
    '',
    '  if ! main_has_debug_flag || [ -z "$ACTIVE_PORT" ]; then',
    '    echo ""',
    '    echo "❌ 等待调试端口超时（15 秒），请查看以下诊断信息："',
    '    MAIN_CHECK="$(find_main_pids || true)"',
    '    if [ -n "$MAIN_CHECK" ]; then',
    '      echo " - 主进程运行中 PID: $(printf \'%s\' "$MAIN_CHECK" | tr \'\\n\' \' \')"',
    '    else',
    '      echo " - 未检测到主进程运行 (${APP_MAIN_BIN})"',
    '    fi',
    '    if main_has_debug_flag; then',
    '      echo " - 调试启动参数 (--remote-debugging-port): 已检测到"',
    '    else',
    '      echo " - 调试启动参数 (--remote-debugging-port): 未检测到"',
    '    fi',
    '    echo " - DevToolsActivePort 文件状态: ${ACTIVE_PORT:-未生成}"',
    '    echo "请保留此窗口以便排查原因。"',
    '    exit 1',
    '  fi',
    '  echo "   ✔ 本地调试端口已就绪：${ACTIVE_PORT}"',
    'fi',
    '',
    'echo "[4/4] 正在等待底部用量与额度栏挂载完成..."',
    'ALIVE_COUNT=""',
    'm=0',
    'while [ $m -lt 84 ]; do',
    '  ALIVE_COUNT="$(check_bridge_mounted "$MIN_LEASE_MS" || true)"',
    '  if [ -n "$ALIVE_COUNT" ]; then',
    '    break',
    '  fi',
    '  sleep 0.3',
    '  m=$((m + 1))',
    'done',
    '',
    'if [ -n "$ALIVE_COUNT" ]; then',
    '  echo ""',
    '  echo "========================================"',
    '  echo "✅ 运行成功！底部用量与额度栏已成功加载显示！"',
    '  echo "   本地调试端口：${ACTIVE_PORT} | 已挂载窗口：${ALIVE_COUNT}"',
    '  echo "========================================"',
    '  schedule_close_this_window',
    'fi',
    '',
    'echo ""',
    'echo "⚠️ 调试端口已就绪（${ACTIVE_PORT}），但等待底部额度栏挂载超时（25 秒）。"',
    'echo " - 桥接状态：$(describe_lease_state)"',
    'echo "请保留此窗口以便排查原因（或确认插件面板中未切换为「仅侧边栏」模式）。"',
    'exit 1',
    '',
  ].join('\n');
}

/**
 * 在磁盘写入并授权（`0o755`）macOS 外部 Terminal 重拉 `.command` 脚本。
 */
export function ensureDarwinTerminalRelaunchScript({
  appBundlePath = '/Applications/Antigravity.app',
  kind = 'desktop',
  stalePortFiles = [],
  homeDir = homedir(),
  leaseFilePath = join(DATA_DIR, 'window-bridge-lease.json'),
  scriptPath = join(DATA_DIR, DARWIN_TERMINAL_RELAUNCH_SCRIPT_NAME),
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
  renameFn = renameSync,
  unlinkFn = unlinkSync,
  chmodFn = chmodSync,
} = {}) {
  const content = buildDarwinTerminalRelaunchScript({
    appBundlePath,
    kind,
    stalePortFiles,
    homeDir,
    leaseFilePath,
  });
  writeTextFileAtomically(scriptPath, content, {
    mkdirFn,
    writeFn: writeFileFn,
    renameFn,
    unlinkFn,
  });
  chmodFn(scriptPath, 0o755);
  return { scriptPath, content };
}

/**
 * macOS 通过拉起外部系统 Terminal 窗口执行可见重启 + 端口校验 + 挂载确认后延迟 3 秒自动关闭脚本。
 */
export async function triggerDarwinTerminalRelaunch({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  stalePortFiles = [],
  leaseFilePath = join(DATA_DIR, 'window-bridge-lease.json'),
  scriptPath = join(DATA_DIR, DARWIN_TERMINAL_RELAUNCH_SCRIPT_NAME),
  execFileFn = null,
  spawnFn = null,
  existsFn = existsSync,
  writeFileFn = writeFileSync,
  mkdirFn = mkdirSync,
  renameFn = renameSync,
  unlinkFn = unlinkSync,
  chmodFn = chmodSync,
  allowInTest = false,
} = {}) {
  if (platform !== 'darwin') {
    return { ok: false, status: 400, error: 'Darwin only' };
  }
  if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest) {
    return { ok: false, status: 403, error: 'Disabled in test sandbox' };
  }

  let hostInfo = resolveDesktopHostExecutable({ env, platform, homeDir, existsFn });
  if (!hostInfo.found) {
    hostInfo = await discoverRunningHostExecutable({ platform, execFileFn });
  }
  if (!hostInfo.found) {
    return {
      ok: false,
      status: 404,
      error: 'Unable to locate Antigravity executable on this machine',
    };
  }

  const appTarget = hostInfo.appBundlePath || hostInfo.executablePath;
  ensureDarwinTerminalRelaunchScript({
    appBundlePath: appTarget,
    kind: hostInfo.kind || 'desktop',
    stalePortFiles,
    homeDir,
    leaseFilePath,
    scriptPath,
    mkdirFn,
    writeFileFn,
    renameFn,
    unlinkFn,
    chmodFn,
  });

  const cleanEnv = buildSanitizedDesktopRelaunchEnv(env);
  const spawner = spawnFn || spawnDetachedProcess;
  await spawner('/usr/bin/open', ['-a', 'Terminal', scriptPath], {
    env: cleanEnv,
  });

  return {
    ok: true,
    relaunching: true,
    viaTerminal: true,
    platform,
    executablePath: appTarget,
    scriptPath,
  };
}

/**
 * macOS Antigravity Desktop 2.33.0+ 冷启动无调试端口时的受保护自动带参重拉自愈：
 * 仅在桥接启动窗（默认 20s）且宿主刚启动（默认 <=45s）内执行单次拉起外部终端脚本，
 * 并通过持久化同 PID 去重与 60s 冷却熔断防止循环重启或打断正常对话。
 */
export async function maybeAutoRelaunchDarwinDesktopHost({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  stalePortFiles = [],
  leaseFilePath = join(DATA_DIR, 'window-bridge-lease.json'),
  stateFilePath = join(DATA_DIR, 'auto-relaunch-state.json'),
  scriptPath = join(DATA_DIR, DARWIN_TERMINAL_RELAUNCH_SCRIPT_NAME),
  bridgeUptimeMs = 0,
  maxBridgeWindowMs = 20_000,
  maxHostElapsedSec = 45,
  cooldownMs = 60_000,
  nowMs = Date.now(),
  execFileFn = null,
  spawnFn = null,
  existsFn = existsSync,
  readFileFn = readFileSync,
  writeFileFn = writeFileSync,
  mkdirFn = mkdirSync,
  renameFn = renameSync,
  unlinkFn = unlinkSync,
  chmodFn = chmodSync,
  allowInTest = false,
} = {}) {
  if (platform !== 'darwin') {
    return { triggered: false, reason: 'non_darwin' };
  }
  if ((lsRuntimeEndpoint.addr === 'test.invalid' || process.env.NODE_TEST_CONTEXT) && !allowInTest) {
    return { triggered: false, reason: 'test_sandbox' };
  }
  if (bridgeUptimeMs > maxBridgeWindowMs) {
    return { triggered: false, reason: 'bridge_past_startup_window' };
  }

  const host = await inspectRunningDarwinDesktopHost({ execFileFn });
  if (!host) {
    return { triggered: false, reason: 'host_not_found' };
  }
  if (host.hasRemoteDebugFlag) {
    return { triggered: false, reason: 'already_has_debug_flag', hostPid: host.pid };
  }
  if (host.elapsedSec == null || host.elapsedSec > maxHostElapsedSec) {
    return {
      triggered: false,
      reason: 'host_past_startup_window',
      hostPid: host.pid,
      elapsedSec: host.elapsedSec,
    };
  }

  let prev = { lastPid: 0, attempts: [] };
  try {
    if (stateFilePath && existsFn(stateFilePath)) {
      const parsed = JSON.parse(readFileFn(stateFilePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        prev = parsed;
      }
    }
  } catch {
    // 状态文件损坏或不可读时按初始空状态处理
  }

  if (Number(prev.lastPid) === host.pid) {
    return { triggered: false, reason: 'same_pid_already_relaunched', hostPid: host.pid };
  }
  const recent = (Array.isArray(prev.attempts) ? prev.attempts : [])
    .map(Number)
    .filter((ts) => Number.isFinite(ts) && ts > 0 && nowMs - ts >= 0 && nowMs - ts < cooldownMs);
  if (recent.length >= 1) {
    return { triggered: false, reason: 'cooldown_circuit_breaker', hostPid: host.pid };
  }

  if (stateFilePath) {
    writeTextFileAtomically(
      stateFilePath,
      JSON.stringify(
        {
          lastPid: host.pid,
          attempts: [...recent, nowMs],
          updatedAtMs: nowMs,
        },
        null,
        2
      ),
      { mkdirFn, writeFn: writeFileFn, renameFn, unlinkFn }
    );
  }

  const res = await triggerDarwinTerminalRelaunch({
    env,
    platform,
    homeDir,
    stalePortFiles,
    leaseFilePath,
    scriptPath,
    execFileFn,
    spawnFn,
    existsFn,
    writeFileFn,
    mkdirFn,
    renameFn,
    unlinkFn,
    chmodFn,
    allowInTest,
  });
  return {
    triggered: Boolean(res?.ok),
    reason: res?.ok ? 'auto_relaunching' : String(res?.error || 'relaunch_failed'),
    hostPid: host.pid,
    scriptPath: res?.scriptPath || scriptPath,
    result: res,
  };
}
