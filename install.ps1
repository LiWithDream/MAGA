[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoRules,
  [switch]$NoShortcut,
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
  -DryRun          Print resolved Node binary, mode, and commands without modifying files
  -Dir <path>      Target directory when cloning via irm | iex (default: %LOCALAPPDATA%\agy-studio)
  -NoRules         Skip syncing 7-line phase-sync rules into ~\.gemini\AGENTS.md
  -NoShortcut      Skip creating the Start Menu "Antigravity (AGY Studio)" shortcut
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
    $CliArgStr = ($CliArgs.ToArray()) -join ' '

    if ($DryRunArg) {
      $NodeVer = (& $NodeBin -v).Trim()
      Write-Output "[dry-run] os=Windows"
      Write-Output "[dry-run] node=$NodeBin ($NodeVer)"
      Write-Output "[dry-run] mode=$Mode"
      Write-Output "[dry-run] targetDir=$TargetDir"
      $hasLockFile = Test-Path -LiteralPath (Join-Path $TargetDir 'package-lock.json') -PathType Leaf
      $npmBootCmd = if ($Mode -eq 'remote-clone' -or $hasLockFile) {
        'npm ci --no-audit --no-fund'
      } else {
        'npm install --no-audit --no-fund'
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
          Write-Output "[dry-run] exec: git clone `"$EffectiveRepoUrl`" `"$TargetDir`" && cd `"$TargetDir`" && $npmBootCmd && `"$NodeBin`" studio/cli.mjs $CliArgStr"
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
        Invoke-NativeStep 'git pull' $gitCmd.Source @('-C', $TargetDir, 'pull', '--ff-only', '--autostash')
      } else {
        $parentDir = Split-Path -Parent $TargetDir
        if ($parentDir -and -not (Test-Path -LiteralPath $parentDir)) {
          New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }
        Write-Output "Cloning AGY Studio into $TargetDir..."
        Invoke-NativeStep 'git clone' $gitCmd.Source @('clone', $EffectiveRepoUrl, $TargetDir)
      }
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
  } ([bool]$DryRun) ([bool]$NoRules) ([bool]$NoShortcut) $Dir $RepoUrl ([bool]$Help) $ScriptSource $ExitState
} catch {
  if ($ScriptSource) {
    [Console]::Error.WriteLine($_.Exception.Message)
    $code = if ($ExitState.Code -gt 0) { [int]$ExitState.Code } else { 1 }
    exit $code
  }
  throw
}
