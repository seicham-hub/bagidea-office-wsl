# BagIdea Office — WSL hybrid launcher (Windows side).
# Boots the daemon INSIDE WSL (if not already up), waits for 127.0.0.1:8787,
# then launches the GUI (shell + Godot + overlay). The shell reuses the running
# daemon (spawn_daemon() in shell/src/main.rs) instead of spawning its own
# Windows daemon — which would create a second, split data store.
#
# Daily use:
#   run-hybrid-windows.ps1              start everything (daemon in WSL + GUI)
#   run-hybrid-windows.ps1 -Stop        stop everything (GUI on Windows + daemon in WSL)
#   run-hybrid-windows.ps1 -Restart     stop, then start (the daemon's /ui/restart calls this)
#   run-hybrid-windows.ps1 -Register    launch automatically at Windows login (hybrid mode)
#   run-hybrid-windows.ps1 -Unregister  remove the login autostart (+ the hybrid marker)
#
# Mode selection (hybrid vs pure-Windows) is just which command the autostart
# Run key points at: -Register points it here (WSL daemon); the stock installer /
# `bagidea startup on` points it at the shell exe (Windows daemon). Same value
# name ("BagIdeaOffice"), so switching either way is one command.
#
# This script also maintains daemon\hybrid.txt in THIS clone. Its presence
# tells a daemon accidentally spawned on Windows (e.g. by the shell's
# watchdog when the WSL daemon hiccups) to boot the WSL daemon and exit,
# instead of serving a second data store. Delete it (-Unregister does) when
# going back to pure-Windows mode.
#
# See WSL-HYBRID.md for setup + the verification checklist.
param(
  [switch]$Stop,
  [switch]$Restart,
  [switch]$Register,
  [switch]$Unregister,
  # Repo path inside WSL (the daemon + all data live there).
  [string]$WslPath = "~/project/bagidea-office-wsl",
  # WSL distro; empty = the default distro.
  [string]$Distro = ""
)
$ErrorActionPreference = "Stop"
$ROOT = $PSScriptRoot
$RUNKEY = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
$HYBRID_TXT = Join-Path $ROOT "daemon\hybrid.txt"

function Fail($msg) { Write-Host "  x $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  - $msg" -ForegroundColor DarkGray }

# taskkill/reg report "nothing to kill" / "no such value" on stderr, which is a
# normal outcome for the teardown below. PS 5.1 wraps a REDIRECTED native stderr
# into a NativeCommandError record, and $ErrorActionPreference="Stop" above
# promotes that to a TERMINATING error — so a bare `2>$null` ABORTS the script
# instead of silencing it. Drop the preference for the call so nothing is
# promoted, and swallow both streams.
function Quiet([scriptblock]$sb) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $sb 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
}

# wsl.exe arg helper — inserts -d <distro> only when one was named.
function WslArgs([string[]]$cmd) {
  $a = @()
  if ($Distro) { $a += @("-d", $Distro) }
  return $a + @("--") + $cmd
}

function DaemonUp {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 2 | Out-Null; return $true }
  catch { return $false }
}

# $WslPath is embedded in bash strings below and in hybrid.txt (which the
# daemon's bounce embeds the same way) — refuse the characters that could
# escape the quoting instead of trying to escape them (mirrors daemon/wsl.js).
if ($WslPath -match '["\\$' + '`' + ']') {
  Fail "unsupported characters in -WslPath (no `" \ `$ or backtick): $WslPath"
}

# The hybrid-mode marker the daemon's win32 bounce reads (daemon/wsl.js).
# UTF8 (not ascii) so a non-ASCII path/distro survives; the daemon strips the BOM.
function Write-HybridMarker {
  $json = @{ wslPath = $WslPath; distro = $Distro } | ConvertTo-Json -Compress
  Set-Content -Path $HYBRID_TXT -Value $json -Encoding utf8
}

# ---- -Register / -Unregister: login autostart (HKCU Run) ---------------------
if ($Register) {
  Write-HybridMarker
  $self = Join-Path $ROOT "run-hybrid-windows.ps1"
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -WslPath `"$WslPath`""
  if ($Distro) { $cmd += " -Distro `"$Distro`"" }
  reg add $RUNKEY /v BagIdeaOffice /t REG_SZ /d $cmd /f | Out-Null
  Ok "registered: BagIdea Office starts at Windows login in HYBRID mode (daemon in WSL)"
  Info "switch back to pure-Windows mode: -Unregister, then bagidea startup on"
  exit 0
}
if ($Unregister) {
  Quiet { reg delete $RUNKEY /v BagIdeaOffice /f }
  if (Test-Path $HYBRID_TXT) { Remove-Item $HYBRID_TXT -Force }
  Ok "login autostart removed (hybrid marker cleared - pure-Windows mode is available again)"
  exit 0
}

# ---- -Stop / -Restart: tear the whole hybrid stack down ----------------------
if ($Stop -or $Restart) {
  # GUI side (Windows): shell + the Godot world (branded or stock name).
  foreach ($p in @("bagidea-office-shell", "BagIdeaOffice")) {
    Quiet { taskkill /IM "$p.exe" /T /F }
  }
  foreach ($g in @(Get-Process | Where-Object { $_.Name -like "Godot*" })) {
    Quiet { taskkill /PID $g.Id /T /F }
  }
  # Daemon side (WSL).
  & wsl.exe (WslArgs @("bash", "-lc", "pkill -f 'node.*daemon/server\.js' || true"))
  Ok "stopped: GUI (Windows) + daemon (WSL)"
  if ($Stop) { exit 0 }
  Start-Sleep -Seconds 2   # let :8787 and the single-instance mutex release
}

# ---- start: daemon in WSL first, then the GUI --------------------------------
Write-HybridMarker
# 1) Boot the WSL daemon if :8787 is silent. bash -lc so nvm-installed node is
#    on PATH; nohup+disown so it survives wsl.exe returning (and keeps the WSL
#    VM alive). BAGIDEA_GUI_ROOT points the daemon back at THIS clone so it can
#    mirror shell-facing files (monitor.txt) and drive the hybrid restart.
if (DaemonUp) {
  Ok "daemon already running on 127.0.0.1:8787"
} else {
  Info "starting the daemon inside WSL ($(if ($Distro) { $Distro } else { 'default distro' }): $WslPath)..."
  # $ROOT rides inside bash single quotes — an apostrophe in the install path
  # (C:\Users\O'Brien) would terminate them early. Strip it (same tradeoff as
  # daemon/wsl.js: the mangled path fails wslpath → GUI-root features degrade
  # gracefully instead of the whole boot line breaking).
  $rootSafe = $ROOT -replace "'", ""
  $guiRootBash = 'BAGIDEA_GUI_ROOT="$(wslpath -u ' + "'" + $rootSafe + "'" + ')"'
  # Quote the cd target for bash — but a leading ~ only expands unquoted, so
  # rewrite it as $HOME inside the quotes (same rule as daemon/wsl.js).
  $cdTarget = if ($WslPath.StartsWith("~/")) { '"$HOME/' + $WslPath.Substring(2) + '"' } else { '"' + $WslPath + '"' }
  # The boot line leaves a [hybrid-boot] marker in daemon.log BEFORE starting
  # node, so a failed start is diagnosable: no marker = the line never ran,
  # marker but nothing after = node died before its first write. NOTE: no
  # setsid — a setsid'd child escapes the wsl.exe session and WSL's init
  # reaps it almost immediately (verified); plain nohup+disown survives.
  $boot = "cd $cdTarget && (curl -s -m1 http://127.0.0.1:8787/health >/dev/null 2>&1 || " +
          '(echo [hybrid-boot] $(date) launcher >> daemon/daemon.log 2>&1; ' +
          "$guiRootBash nohup node daemon/server.js >> daemon/daemon.log 2>&1 & disown))"
  # A freshly spawned node can (rarely) get reaped right after the wsl.exe
  # session ends — observed in the field as an empty daemon.log and no
  # listener. One boot re-fire covers that transient; a second miss is real.
  $up = $false
  foreach ($attempt in 1, 2) {
    & wsl.exe (WslArgs @("bash", "-lc", $boot))
    if ($LASTEXITCODE -ne 0) { Fail "wsl.exe failed - is WSL installed and the repo at $WslPath ? (see WSL-HYBRID.md)" }
    # Cold login can mean a full WSL VM boot + node start: allow up to 60s per attempt.
    $deadline = (Get-Date).AddSeconds(60)
    while (-not ($up = DaemonUp)) {
      if ((Get-Date) -gt $deadline) { break }
      Start-Sleep -Milliseconds 800
    }
    if ($up) { break }
    if ($attempt -eq 1) { Info "daemon not up yet - re-firing the boot once (transient reap guard)..." }
  }
  if (-not $up) {
    Write-Host "  x daemon didn't come up on 127.0.0.1:8787 - diagnostics from WSL:" -ForegroundColor Red
    & wsl.exe (WslArgs @("bash", "-lc",
      "echo '--- tail daemon/daemon.log ---'; tail -n 20 $WslPath/daemon/daemon.log 2>&1; " +
      "echo '--- node/curl on PATH (bash -lc) ---'; command -v node; command -v curl; " +
      "echo '--- port 8787 ---'; ss -tln 2>/dev/null | grep 8787 || echo 'not listening'"))
    exit 1
  }
  Ok "daemon is up on 127.0.0.1:8787"
}

# 2) Godot: branded exe in-repo wins, else BAGIDEA_GODOT (same order as the shell).
# Read the User-scope value directly, not just $env:BAGIDEA_GODOT — a terminal
# opened BEFORE the var was set won't have it in-process (User env doesn't
# propagate to already-running shells), which looked like "Godot not found"
# even though the var was set correctly. The registry read always sees it.
$branded = Join-Path $ROOT "godot\bin\BagIdeaOffice.exe"
$godotEnv = $env:BAGIDEA_GODOT
if (-not $godotEnv) { $godotEnv = [Environment]::GetEnvironmentVariable("BAGIDEA_GODOT", "User") }
if (-not $godotEnv) { $godotEnv = [Environment]::GetEnvironmentVariable("BAGIDEA_GODOT", "Machine") }
$godot = if (Test-Path $branded) { $branded } else { $godotEnv }
if (-not $godot -or -not (Test-Path $godot)) {
  Fail "Godot not found - set the BAGIDEA_GODOT env var to the Godot 4.6.x exe (see WSL-HYBRID.md step 2)"
}
Ok "godot: $godot"

# 3) The shell exe (prebuilt drop or cargo build output).
$exe = Join-Path $ROOT "shell\target\release\bagidea-office-shell.exe"
if (-not (Test-Path $exe)) {
  Fail "shell exe not found at $exe - download the prebuilt (see WSL-HYBRID.md step 3)"
}

Ok "launching the GUI (the shell reuses the WSL daemon - it will NOT spawn its own)"
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
