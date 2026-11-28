[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoRules,
  [switch]$NoShortcut,
  [switch]$Preview,
  [switch]$Force,
  [string]$Channel = "",
  [string]$Dir = "",
  [string]$RepoUrl = "",
  [switch]$Help
)

$ScriptSource = $PSCommandPath
$ExitState = @{ Code = 0 }

try {
  & {
    param(
      [bool]$DryRunArg,
      [bool]$NoRulesArg,
      [bool]$NoShortcutArg,
      [bool]$PreviewArg,
      [bool]$ForceArg,
      [string]$ChannelArg,
      [string]$DirArg,
      [string]$RepoUrlArg,
      [bool]$HelpArg,
      [string]$ScriptPath,
      [hashtable]$State
    )

    $ErrorActionPreference = 'Stop'

    function Show-Usage {
      Write-Output @"
Usage: install.ps1 [options]

Options:
  -DryRun          Print resolved Node binary, mode, channel, and commands without modifying files
  -Channel <name>  Release channel when syncing git clones: stable (default, latest Release tag) or edge (main)
  -Dir <path>      Target directory when cloning via irm | iex (default: %LOCALAPPDATA%\agy-studio)
  -NoRules         Skip syncing 7-line phase-sync rules into ~\.gemini\AGENTS.md
  -NoShortcut      Skip creating the Start Menu "Antigravity (AGY Studio)" shortcut
  -Preview         Allow preview install from a non-main branch or linked worktree (--preview)
  -Force           Allow install from a dirty working tree (auto-stashes during channel switch)
  -RepoUrl <url>   Override repository clone URL
  -Help            Show this help message
"@
    }

    function Fail-Install([string]$Message, [int]$Code = 1) {
      $State.Code = if ($Code -gt 0) { $Code } else { 1 }
      throw $Message
    }

    function Invoke-NativeStep([string]$Label, [string]$Exe, [string[]]$CmdArgs) {
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & $Exe @CmdArgs
        $rc = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $prevEap
      }
      if ($rc -ne 0) {
        Fail-Install "$Label failed with exit code $rc." $rc
      }
    }

    if ($HelpArg) {
      Show-Usage
      return
    }

    $ChannelExplicit = $false
    $ChannelRaw = ''
    if ($ChannelArg) {
      $ChannelRaw = $ChannelArg
      $ChannelExplicit = $true
    } elseif ($env:AGY_STUDIO_CHANNEL) {
      $ChannelRaw = $env:AGY_STUDIO_CHANNEL
      $ChannelExplicit = $true
    } else {
      $ChannelRaw = 'stable'
    }
    $ChannelVal = $ChannelRaw.Trim().ToLowerInvariant()
    if ($ChannelVal -ne 'stable' -and $ChannelVal -ne 'edge') {
      Show-Usage
      Fail-Install "Invalid -Channel '$ChannelRaw' (expected 'stable' or 'edge')." 2
    }

    $InstallDir = if ($DirArg) {
      $DirArg
    } elseif ($env:AGY_STUDIO_INSTALL_DIR) {
      $env:AGY_STUDIO_INSTALL_DIR
    } elseif ($env:MAGA_INSTALL_DIR) {
      $env:MAGA_INSTALL_DIR
    } else {
      $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
      Join-Path $localAppData 'agy-studio'
    }

    $EffectiveRepoUrl = if ($RepoUrlArg) {
      $RepoUrlArg
    } elseif ($env:AGY_STUDIO_REPO_URL) {
      $env:AGY_STUDIO_REPO_URL
    } elseif ($env:MAGA_REPO_URL) {
      $env:MAGA_REPO_URL
    } else {
      'https://github.com/LiWithDream/agy-studio.git'
    }

    function Get-NodeMajor([string]$BinPath) {
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $ver = & $BinPath -p "process.versions.node.split('.')[0]" 2>$null
        if ($LASTEXITCODE -eq 0 -and $ver -match '^\d+$') {
          return [int]$ver
        }
      } catch {}
      finally {
        $ErrorActionPreference = $prevEap
      }
      return 0
    }

    function Resolve-Node22 {
      $candidates = New-Object System.Collections.Generic.List[string]
      $cmd = Get-Command node -ErrorAction SilentlyContinue
      if ($cmd -and $cmd.Source) {
        $candidates.Add($cmd.Source)
      }
      if ($env:ProgramFiles) {
        $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
      }
      if (${env:ProgramFiles(x86)}) {
        $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'))
      }
      if ($env:LOCALAPPDATA) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'))
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
      }
      if ($env:NVM_SYMLINK) {
        $candidates.Add((Join-Path $env:NVM_SYMLINK 'node.exe'))
      }
      if ($env:APPDATA) {
        $nvmPattern = Join-Path $env:APPDATA 'nvm\*\node.exe'
        Get-ChildItem -Path $nvmPattern -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }
        $fnmStable = Join-Path $env:APPDATA 'fnm\node-versions\*\installation\node.exe'
        Get-ChildItem -Path $fnmStable -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }
      }
      if ($env:LOCALAPPDATA) {
        $fnmLocalStable = Join-Path $env:LOCALAPPDATA 'fnm\node-versions\*\installation\node.exe'
        Get-ChildItem -Path $fnmLocalStable -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }
        $fnmPattern = Join-Path $env:LOCALAPPDATA 'fnm_multishells\*\node.exe'
        Get-ChildItem -Path $fnmPattern -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }
      }
      if ($env:USERPROFILE) {
        $candidates.Add((Join-Path $env:USERPROFILE 'scoop\shims\node.exe'))
      }

      $seen = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
      foreach ($cand in $candidates) {
        if (-not $cand -or -not $seen.Add($cand)) { continue }
        if (Test-Path -LiteralPath $cand -PathType Leaf) {
          if ((Get-NodeMajor $cand) -ge 22) {
            return $cand
          }
        }
      }
      return $null
    }

    $NodeBin = Resolve-Node22
    if (-not $NodeBin) {
      Fail-Install "Node.js >= 22 is required on Windows. Install via: winget install OpenJS.NodeJS.LTS" 1
    }

    $NodeDir = Split-Path -Parent $NodeBin
    if ($env:PATH -notlike "*$NodeDir*") {
      $env:PATH = "$NodeDir;$env:PATH"
    }

    $ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { "" }

    $TargetDir = ""
    if ($ScriptDir -and (Test-Path -LiteralPath (Join-Path $ScriptDir 'studio\cli.mjs') -PathType Leaf)) {
      $TargetDir = $ScriptDir
    } elseif ($ScriptPath -and (Test-Path -LiteralPath (Join-Path (Get-Location).Path 'studio\cli.mjs') -PathType Leaf)) {
      # Only trust $PWD when executed from a local file, never when piped via irm | iex.
      $TargetDir = (Get-Location).Path
    }

    if ($TargetDir) {
      $hasCustomJs = Test-Path -LiteralPath (Join-Path $TargetDir 'user\custom.js') -PathType Leaf
      $hasPrebuiltStudio = Test-Path -LiteralPath (Join-Path $TargetDir 'studio\prebuilt\studio-entry.js') -PathType Leaf
      if ($hasCustomJs -and $hasPrebuiltStudio) {
        $Mode = 'prebuilt'
      } elseif (Test-Path -LiteralPath (Join-Path $TargetDir 'node_modules\esbuild') -PathType Container) {
        $Mode = 'source'
      } else {
        $Mode = 'source-bootstrap'
      }
    } else {
      $Mode = 'remote-clone'
      $TargetDir = $InstallDir
    }

    $CliArgs = New-Object System.Collections.Generic.List[string]
    $CliArgs.Add('install')
    if ($NoRulesArg) { $CliArgs.Add('--no-rules') }
    if ($NoShortcutArg) { $CliArgs.Add('--no-shortcut') }
    if ($PreviewArg) { $CliArgs.Add('--preview') }
    if ($ForceArg) { $CliArgs.Add('--force') }
    $CliArgStr = ($CliArgs.ToArray()) -join ' '

    function Resolve-StableTag([string]$GitTargetDir, [string]$RepoCloneUrl) {
      $resolverJs = @'
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const targetDir = process.argv[2] || '';
const repoUrl = process.argv[3] || '';
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

const envTag = String(process.env.AGY_STUDIO_RELEASE_TAG || '').trim();
if (TAG_RE.test(envTag)) {
  process.stdout.write(`${envTag}\n`);
  process.exit(0);
}

const ghMatch = repoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
if (ghMatch && typeof fetch === 'function') {
  try {
    const apiUrl = `https://api.github.com/repos/${ghMatch[1]}/${ghMatch[2]}/releases/latest`;
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agy-studio-installer' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const tag = String(data?.tag_name || '').trim();
      if (TAG_RE.test(tag)) {
        process.stdout.write(`${tag}\n`);
        process.exit(0);
      }
    }
  } catch {}
}

let expectedMajor = 1;
try {
  const pkgRaw = execFileSync('git', ['-C', targetDir, 'show', 'origin/main:package.json'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = String(JSON.parse(pkgRaw)?.version || '').match(/^(\d+)\./);
  if (m) expectedMajor = Number(m[1]);
} catch {
  try {
    const localPkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    const m = String(localPkg?.version || '').match(/^(\d+)\./);
    if (m) expectedMajor = Number(m[1]);
  } catch {}
}

let lsOut = '';
try {
  lsOut = execFileSync('git', ['ls-remote', '--tags', '--refs', repoUrl, 'refs/tags/v*'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {}

const parsed = [];
for (const line of lsOut.split(/\r?\n/)) {
  const m = line.match(/refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/);
  if (!m) continue;
  const tag = m[1];
  const major = Number(m[2]);
  if (major > expectedMajor) continue;
  parsed.push({ tag, major, minor: Number(m[3]), patch: Number(m[4]) });
}
parsed.sort((a, b) => (b.major - a.major) || (b.minor - a.minor) || (b.patch - a.patch));
if (parsed[0]) {
  process.stdout.write(`${parsed[0].tag}\n`);
  process.exit(0);
}
process.exit(1);
'@
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $resolved = $resolverJs | & $NodeBin --input-type=module - $GitTargetDir $RepoCloneUrl
        $rc = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $prevEap
      }
      if ($rc -ne 0 -or -not $resolved) {
        return ''
      }
      return ($resolved | Select-Object -Last 1).ToString().Trim()
    }

    function Sync-GitChannel([string]$GitExe, [string]$GitTargetDir, [string]$RepoCloneUrl, [string]$ChannelName) {
      $statusOut = & $GitExe -C $GitTargetDir status --porcelain
      if ($LASTEXITCODE -ne 0) {
        Fail-Install "git status failed in $GitTargetDir." $LASTEXITCODE
      }
      if ($statusOut) {
        if ($ForceArg) {
          Write-Output "Stashing local uncommitted changes in $GitTargetDir (-Force)..."
          Invoke-NativeStep 'git stash' $GitExe @('-C', $GitTargetDir, 'stash', 'push', '-u', '-m', 'agy-studio-installer-autostash')
        } else {
          Fail-Install "$GitTargetDir has local uncommitted changes. Commit/stash them or re-run with -Force." 1
        }
      }
      Invoke-NativeStep 'git fetch main' $GitExe @('-C', $GitTargetDir, 'fetch', '--prune', 'origin', 'main')
      if ($ChannelName -eq 'edge') {
        Write-Output "Switching $GitTargetDir to edge channel (origin/main)..."
        Invoke-NativeStep 'git checkout main' $GitExe @('-C', $GitTargetDir, 'checkout', '-B', 'main', 'origin/main')
      } else {
        $stableTag = Resolve-StableTag $GitTargetDir $RepoCloneUrl
        if (-not $stableTag) {
          Fail-Install "Could not resolve latest stable release tag from $RepoCloneUrl (pass -Channel edge to track main)." 1
        }
        Write-Output "Switching $GitTargetDir to stable release $stableTag..."
        $refSpec = "refs/tags/${stableTag}:refs/tags/${stableTag}"
        Invoke-NativeStep 'git fetch tag' $GitExe @('-C', $GitTargetDir, 'fetch', '--prune', 'origin', $refSpec)
        Invoke-NativeStep 'git checkout tag' $GitExe @('-C', $GitTargetDir, 'checkout', '--detach', "refs/tags/$stableTag")
      }
    }

    if ($DryRunArg) {
      $NodeVer = (& $NodeBin -v).Trim()
      Write-Output "[dry-run] os=Windows"
      Write-Output "[dry-run] channel=$ChannelVal"
      Write-Output "[dry-run] node=$NodeBin ($NodeVer)"
      Write-Output "[dry-run] mode=$Mode"
      Write-Output "[dry-run] targetDir=$TargetDir"
      $hasLockFile = Test-Path -LiteralPath (Join-Path $TargetDir 'package-lock.json') -PathType Leaf
      $npmBootCmd = if ($Mode -eq 'remote-clone' -or $hasLockFile) {
        'npm ci --no-audit --no-fund'
      } else {
        'npm install --no-audit --no-fund'
      }
      $channelStep = if ($ChannelVal -eq 'edge') {
        "git -C `"$TargetDir`" checkout -B main origin/main"
      } else {
        "git -C `"$TargetDir`" checkout --detach <latest-stable-tag>"
      }
      switch ($Mode) {
        'prebuilt' {
          Write-Output "[dry-run] exec: MAGA_USE_PREBUILT=1 `"$NodeBin`" studio/cli.mjs $CliArgStr"
        }
        'source' {
          Write-Output "[dry-run] exec: `"$NodeBin`" studio/cli.mjs $CliArgStr"
        }
        'source-bootstrap' {
          Write-Output "[dry-run] exec: $npmBootCmd && `"$NodeBin`" studio/cli.mjs $CliArgStr"
        }
        'remote-clone' {
          Write-Output "[dry-run] exec: git clone `"$EffectiveRepoUrl`" `"$TargetDir`" && $channelStep && cd `"$TargetDir`" && $npmBootCmd && `"$NodeBin`" studio/cli.mjs $CliArgStr"
        }
      }
      return
    }

    if ($Mode -eq 'remote-clone') {
      $gitCmd = Get-Command git -ErrorAction SilentlyContinue
      if (-not $gitCmd) {
        Fail-Install "git is required for remote install. Install via: winget install Git.Git" 1
      }
      if (Test-Path -LiteralPath (Join-Path $TargetDir '.git') -PathType Container) {
        Write-Output "Updating existing AGY Studio clone at $TargetDir..."
      } else {
        $parentDir = Split-Path -Parent $TargetDir
        if ($parentDir -and -not (Test-Path -LiteralPath $parentDir)) {
          New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }
        Write-Output "Cloning AGY Studio into $TargetDir..."
        Invoke-NativeStep 'git clone' $gitCmd.Source @('clone', $EffectiveRepoUrl, $TargetDir)
      }
      Sync-GitChannel $gitCmd.Source $TargetDir $EffectiveRepoUrl $ChannelVal
      $hasCustomJs = Test-Path -LiteralPath (Join-Path $TargetDir 'user\custom.js') -PathType Leaf
      $hasPrebuiltStudio = Test-Path -LiteralPath (Join-Path $TargetDir 'studio\prebuilt\studio-entry.js') -PathType Leaf
      if ($hasCustomJs -and $hasPrebuiltStudio) {
        $Mode = 'prebuilt'
      } elseif (Test-Path -LiteralPath (Join-Path $TargetDir 'node_modules\esbuild') -PathType Container) {
        $Mode = 'source'
      } else {
        $Mode = 'source-bootstrap'
      }
    } elseif ($ChannelExplicit -and (Test-Path -LiteralPath (Join-Path $TargetDir '.git') -PathType Container)) {
      $gitCmd = Get-Command git -ErrorAction SilentlyContinue
      if (-not $gitCmd) {
        Fail-Install "git is required to switch release channels. Install via: winget install Git.Git" 1
      }
      Sync-GitChannel $gitCmd.Source $TargetDir $EffectiveRepoUrl $ChannelVal
      $hasCustomJs = Test-Path -LiteralPath (Join-Path $TargetDir 'user\custom.js') -PathType Leaf
      $hasPrebuiltStudio = Test-Path -LiteralPath (Join-Path $TargetDir 'studio\prebuilt\studio-entry.js') -PathType Leaf
      if ($hasCustomJs -and $hasPrebuiltStudio) {
        $Mode = 'prebuilt'
      } elseif (Test-Path -LiteralPath (Join-Path $TargetDir 'node_modules\esbuild') -PathType Container) {
        $Mode = 'source'
      } else {
        $Mode = 'source-bootstrap'
      }
    }

    Push-Location $TargetDir
    $prevPrebuilt = $env:MAGA_USE_PREBUILT
    try {
      if ($Mode -eq 'prebuilt') {
        $env:MAGA_USE_PREBUILT = '1'
        Invoke-NativeStep 'studio/cli.mjs install' $NodeBin (@('studio/cli.mjs') + $CliArgs.ToArray())
      } elseif ($Mode -eq 'source-bootstrap') {
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
        if (-not $npmCmd) {
          Fail-Install "npm is required to install build dependencies (esbuild)." 1
        }
        $hasLockFile = Test-Path -LiteralPath (Join-Path $TargetDir 'package-lock.json') -PathType Leaf
        $npmSub = if ($hasLockFile) { 'ci' } else { 'install' }
        Write-Output "Installing build dependencies (esbuild)..."
        Invoke-NativeStep "npm $npmSub" $npmCmd.Source @($npmSub, '--no-audit', '--no-fund')
        Invoke-NativeStep 'studio/cli.mjs install' $NodeBin (@('studio/cli.mjs') + $CliArgs.ToArray())
      } else {
        Invoke-NativeStep 'studio/cli.mjs install' $NodeBin (@('studio/cli.mjs') + $CliArgs.ToArray())
      }
    } finally {
      if ($null -eq $prevPrebuilt) {
        Remove-Item Env:MAGA_USE_PREBUILT -ErrorAction SilentlyContinue
      } else {
        $env:MAGA_USE_PREBUILT = $prevPrebuilt
      }
      Pop-Location
    }

    Write-Output "Done. Run 'node `"$TargetDir\studio\cli.mjs`" doctor' to verify live status."
  } ([bool]$DryRun) ([bool]$NoRules) ([bool]$NoShortcut) ([bool]$Preview) ([bool]$Force) $Channel $Dir $RepoUrl ([bool]$Help) $ScriptSource $ExitState
} catch {
  if ($ScriptSource) {
    [Console]::Error.WriteLine($_.Exception.Message)
    $code = if ($ExitState.Code -gt 0) { [int]$ExitState.Code } else { 1 }
    exit $code
  }
  throw
}
