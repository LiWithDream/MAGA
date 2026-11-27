[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Purge,
  [string]$Dir = "",
  [switch]$Help
)

$ScriptSource = $PSCommandPath
$ExitState = @{ Code = 0 }

try {
  & {
    param(
      [bool]$DryRunArg,
      [bool]$PurgeArg,
      [string]$DirArg,
      [bool]$HelpArg,
      [string]$ScriptPath,
      [hashtable]$State
    )

    $ErrorActionPreference = 'Stop'

    function Show-Usage {
      Write-Output @"
Usage: uninstall.ps1 [options]

Options:
  -DryRun      Print actions without modifying files or scheduled tasks
  -Purge       Also remove ~\.gemini\antigravity\anti-claude\studio-prefs.json
  -Dir <path>  Optional AGY Studio installation directory
  -Help        Show this help message
"@
    }

    function Fail-Uninstall([string]$Message, [int]$Code = 1) {
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
        Fail-Uninstall "$Label failed with exit code $rc." $rc
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
      if ($cmd -and $cmd.Source) { $candidates.Add($cmd.Source) }
      if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
      if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')) }
      if ($env:LOCALAPPDATA) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'))
        $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
      }
      if ($env:NVM_SYMLINK) { $candidates.Add((Join-Path $env:NVM_SYMLINK 'node.exe')) }
      if ($env:USERPROFILE) { $candidates.Add((Join-Path $env:USERPROFILE 'scoop\shims\node.exe')) }
      foreach ($cand in $candidates) {
        if ($cand -and (Test-Path -LiteralPath $cand -PathType Leaf)) {
          if ((Get-NodeMajor $cand) -ge 22) { return $cand }
        }
      }
      return $null
    }

    $NodeBin = Resolve-Node22
    if (-not $NodeBin) {
      Fail-Uninstall "Node.js >= 22 is required to run uninstaller." 1
    }

    $ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { "" }
    $TargetDir = ""
    if ($ScriptDir -and (Test-Path -LiteralPath (Join-Path $ScriptDir 'studio\cli.mjs') -PathType Leaf)) {
      $TargetDir = $ScriptDir
    } elseif ($ScriptPath -and (Test-Path -LiteralPath (Join-Path (Get-Location).Path 'studio\cli.mjs') -PathType Leaf)) {
      $TargetDir = (Get-Location).Path
    } elseif (Test-Path -LiteralPath (Join-Path $InstallDir 'studio\cli.mjs') -PathType Leaf) {
      $TargetDir = $InstallDir
    } else {
      Fail-Uninstall "Could not find AGY Studio directory. Run from your agy-studio folder or pass -Dir." 1
    }

    $UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
    $PrefsFile = Join-Path $UserHome '.gemini\antigravity\anti-claude\studio-prefs.json'

    if ($DryRunArg) {
      Write-Output "[dry-run] node=$NodeBin"
      Write-Output "[dry-run] targetDir=$TargetDir"
      Write-Output "[dry-run] exec: `"$NodeBin`" studio/cli.mjs rollback && `"$NodeBin`" install.mjs uninstall"
      if ($PurgeArg) {
        Write-Output "[dry-run] exec: Remove-Item -Force `"$PrefsFile`""
      } else {
        Write-Output "[dry-run] preserve: `"$PrefsFile`""
      }
      return
    }

    Push-Location $TargetDir
    try {
      Invoke-NativeStep 'studio/cli.mjs rollback' $NodeBin @('studio/cli.mjs', 'rollback')
      Invoke-NativeStep 'install.mjs uninstall' $NodeBin @('install.mjs', 'uninstall')
    } finally {
      Pop-Location
    }

    if ($PurgeArg -and (Test-Path -LiteralPath $PrefsFile -PathType Leaf)) {
      Remove-Item -LiteralPath $PrefsFile -Force
      Write-Output "Removed $PrefsFile"
    }

    Write-Output "AGY Studio uninstalled cleanly. Antigravity application files remain untouched."
  } ([bool]$DryRun) ([bool]$Purge) $Dir ([bool]$Help) $ScriptSource $ExitState
} catch {
  if ($ScriptSource) {
    [Console]::Error.WriteLine($_.Exception.Message)
    $code = if ($ExitState.Code -gt 0) { [int]$ExitState.Code } else { 1 }
    exit $code
  }
  throw
}
