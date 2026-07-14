# BagIdea Office — WSL hybrid launcher (Windows side).
# Launches ONLY the GUI (shell + Godot + overlay) and connects it to a daemon
# that must ALREADY be running inside WSL on 127.0.0.1:8787.
#
# Why the daemon-first order matters: the shell only reuses an existing daemon
# (spawn_daemon() in shell/src/main.rs). If :8787 is empty it spawns its OWN
# daemon with the Windows node — a second data store, split from the WSL one.
# This script refuses to launch in that case instead of silently forking state.
#
# See WSL-HYBRID.md for the full setup + verification checklist.
$ErrorActionPreference = "Stop"
$ROOT = $PSScriptRoot

function Fail($msg) { Write-Host "  x $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }

# 1) The WSL daemon must be up BEFORE the shell starts.
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 3
  Ok "daemon reachable on 127.0.0.1:8787 (clients: $($h.clients))"
} catch {
  Fail "no daemon on 127.0.0.1:8787 - start it in WSL first:  node daemon/server.js  (see WSL-HYBRID.md)"
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
