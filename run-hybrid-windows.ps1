# BagIdea Office — WSL hybrid launcher (Windows side).
# Boots the daemon INSIDE WSL (if not already up), waits for 127.0.0.1:8787,
# then launches the GUI (shell + Godot + overlay). The shell reuses the running
# daemon (spawn_daemon() in shell/src/main.rs) instead of spawning its own
# Windows daemon — which would create a second, split data store.
#
# Daily use:
#   run-hybrid-windows.ps1              start everything (daemon in WSL + GUI)
#   run-hybrid-windows.ps1 -Stop        stop everything (GUI on Windows + daemon in WSL)
#   run-hybrid-windows.ps1 -Register    launch automatically at Windows login (hybrid mode)
#   run-hybrid-windows.ps1 -Unregister  remove the login autostart
#
# Mode selection (hybrid vs pure-Windows) is just which command the autostart
# Run key points at: -Register points it here (WSL daemon); the stock installer /
# `bagidea startup on` points it at the shell exe (Windows daemon). Same value
# name ("BagIdeaOffice"), so switching either way is one command.
#
# See WSL-HYBRID.md for setup + the verification checklist.
param(
  [switch]$Stop,
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

function Fail($msg) { Write-Host "  x $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  - $msg" -ForegroundColor DarkGray }

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

# ---- -Register / -Unregister: login autostart (HKCU Run) ---------------------
if ($Register) {
  $self = Join-Path $ROOT "run-hybrid-windows.ps1"
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -WslPath `"$WslPath`""
  if ($Distro) { $cmd += " -Distro `"$Distro`"" }
  reg add $RUNKEY /v BagIdeaOffice /t REG_SZ /d $cmd /f | Out-Null
  Ok "registered: BagIdea Office starts at Windows login in HYBRID mode (daemon in WSL)"
  Info "switch back to pure-Windows mode anytime: bagidea startup on  (re-points the same key at the shell exe)"
  exit 0
}
if ($Unregister) {
  reg delete $RUNKEY /v BagIdeaOffice /f 2>$null | Out-Null
  Ok "login autostart removed"
  exit 0
}

# ---- -Stop: tear the whole hybrid stack down ---------------------------------
if ($Stop) {
  # GUI side (Windows): shell + the Godot world (branded or stock name).
  foreach ($p in @("bagidea-office-shell", "BagIdeaOffice")) {
    taskkill /IM "$p.exe" /T /F 2>$null | Out-Null
  }
  Get-Process | Where-Object { $_.Name -like "Godot*" } | ForEach-Object {
    taskkill /PID $_.Id /T /F 2>$null | Out-Null
  }
  # Daemon side (WSL).
  & wsl.exe (WslArgs @("bash", "-lc", "pkill -f 'node.*daemon/server\.js' || true"))
  Ok "stopped: GUI (Windows) + daemon (WSL)"
  exit 0
}

# ---- start: daemon in WSL first, then the GUI --------------------------------
# 1) Boot the WSL daemon if :8787 is silent. bash -lc so nvm-installed node is
#    on PATH; nohup+disown so it survives wsl.exe returning (and keeps the WSL
#    VM alive). Skips itself if a daemon is already listening.
if (DaemonUp) {
  Ok "daemon already running on 127.0.0.1:8787"
} else {
  Info "starting the daemon inside WSL ($(if ($Distro) { $Distro } else { 'default distro' }): $WslPath)..."
  $boot = "cd $WslPath && (curl -s -m1 http://127.0.0.1:8787/health >/dev/null 2>&1 || " +
          "(nohup node daemon/server.js >> daemon/daemon.log 2>&1 & disown))"
  & wsl.exe (WslArgs @("bash", "-lc", $boot))
  if ($LASTEXITCODE -ne 0) { Fail "wsl.exe failed - is WSL installed and the repo at $WslPath ? (see WSL-HYBRID.md)" }
  # Cold login can mean a full WSL VM boot + node start: allow up to 90s.
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (DaemonUp)) {
    if ((Get-Date) -gt $deadline) { Fail "daemon didn't come up on 127.0.0.1:8787 within 90s - check daemon/daemon.log in WSL" }
    Start-Sleep -Milliseconds 800
  }
  Ok "daemon is up on 127.0.0.1:8787"
}

# 2) Godot: branded exe in-repo wins, else BAGIDEA_GODOT (same order as the shell).
$branded = Join-Path $ROOT "godot\bin\BagIdeaOffice.exe"
$godot = if (Test-Path $branded) { $branded } else { $env:BAGIDEA_GODOT }
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
