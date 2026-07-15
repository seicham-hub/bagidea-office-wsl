"use strict";
// daemon/wsl.js — helpers for the WSL HYBRID mode: the daemon runs inside
// WSL2 (agents/claude on the Linux side) while the GUI (shell + Godot +
// overlay) runs on Windows and reuses this daemon over localhost:8787.
//
// Two jobs live here:
//   1. Interop helpers for a daemon running IN WSL — detect WSL, convert
//      paths (wslpath), reach the Windows temp dir, and run Windows
//      binaries (powershell.exe / explorer.exe / wt.exe work from WSL).
//   2. The win32-side "bounce" — when the Windows shell's watchdog spawns a
//      daemon on Windows even though this machine runs hybrid mode
//      (daemon/hybrid.txt present), boot the REAL daemon inside WSL and bow
//      out, instead of serving a second, split data store.

const fs = require("fs");
const path = require("path");
const { execFileSync, execFile, spawnSync } = require("child_process");

// Interop processes inherit the cwd; a Linux cwd maps to \\wsl.localhost\…,
// which cmd.exe rejects as a UNC working directory (falls back to C:\Windows
// with a warning). Pin interop children to a drvfs path instead.
const INTEROP_CWD = "/mnt/c";

let _isWsl = null;
function isWSL() {
  if (_isWsl !== null) return _isWsl;
  if (process.platform !== "linux") { _isWsl = false; return _isWsl; }
  try {
    _isWsl = !!process.env.WSL_DISTRO_NAME ||
      /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch { _isWsl = false; }
  return _isWsl;
}

// WSL path to the Windows-side clone (godot assets + shell exe + the
// launcher). Set by run-hybrid-windows.ps1 when it boots the daemon:
//   BAGIDEA_GUI_ROOT="$(wslpath -u 'C:\dev\bagidea-office-wsl')"
function guiRoot() {
  const r = process.env.BAGIDEA_GUI_ROOT;
  if (!r) return null;
  try { return fs.statSync(r).isDirectory() ? r : null; } catch { return null; }
}

function toWinPath(p) {
  try {
    return execFileSync("wslpath", ["-w", p], { timeout: 5000 })
      .toString().trim() || null;
  } catch { return null; }
}

function toWslPath(p) {
  try {
    return execFileSync("wslpath", ["-u", p], { timeout: 5000 })
      .toString().trim() || null;
  } catch { return null; }
}

// WSL path to the WINDOWS temp dir (where the shell watches for the editor
// flags and drops bagidea_shell_alive). Probed once via interop, then cached
// — null when interop is unavailable.
let _winTemp; // undefined = not probed yet
function winTempDir() {
  if (_winTemp !== undefined) return _winTemp;
  _winTemp = null;
  try {
    const t = execFileSync("powershell.exe", ["-NoProfile", "-Command", "$env:TEMP"],
      { timeout: 15000, cwd: INTEROP_CWD }).toString().trim();
    if (t) _winTemp = toWslPath(t);
  } catch {}
  return _winTemp;
}

// Run Windows PowerShell 5.1 from WSL. 5.1 on purpose (same reason as the
// win32 folder picker): it's STA by default, which WinForms dialogs need.
function psExec(args, opts, cb) {
  execFile("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
    { cwd: INTEROP_CWD, windowsHide: true, ...(opts || {}) }, cb);
}

// ---- hybrid bounce (win32 side) ----------------------------------------------

// daemon/hybrid.txt: { "wslPath": "~/project/bagidea-office-wsl", "distro": "" }
// Written by run-hybrid-windows.ps1; its presence IS the hybrid-mode marker.
// wslPath is embedded in a bash double-quoted string below, so reject the
// characters that could escape it rather than trying to quote them. PowerShell
// 5.1's utf8 writer prepends a BOM, which JSON.parse rejects — strip it.
function parseHybridConfig(text) {
  try {
    const j = JSON.parse(String(text).replace(/^﻿/, ""));
    const wslPath = String(j.wslPath || "").trim();
    if (!wslPath || /["\\$`]/.test(wslPath)) return null;
    return { wslPath, distro: String(j.distro || "").trim() };
  } catch { return null; }
}

// The bash line that boots the WSL daemon if :8787 is silent. Mirrors the
// launcher's boot line; `bash -lc` so an nvm-installed node resolves. A bare
// leading ~ must sit outside the quotes to expand — swap it for "$HOME".
function buildBootCommand(wslPath, guiRootWin) {
  const cd = wslPath.startsWith("~/") ? `"$HOME/${wslPath.slice(2)}"` : `"${wslPath}"`;
  // The Windows root rides inside bash single quotes. Apostrophes ARE legal in
  // Windows paths (C:\Users\O'Brien) — stripping one degrades to a path that
  // doesn't resolve, which downstream treats as "no GUI root" (mirroring off).
  // That silent degradation beats letting the quote terminate early.
  const env = guiRootWin
    ? `BAGIDEA_GUI_ROOT="$(wslpath -u '${String(guiRootWin).replace(/'/g, "")}')" `
    : "";
  // [hybrid-boot] marker first (no marker = this line never ran; marker with
  // nothing after = node died before its first write). NOTE: no setsid here —
  // a setsid'd child escapes the wsl.exe session and WSL's init reaps it
  // almost immediately (verified empirically); plain nohup+disown survives.
  return `cd ${cd} && (curl -s -m1 http://127.0.0.1:8787/health >/dev/null 2>&1 || ` +
    `(echo [hybrid-boot] $(date) bounce >> daemon/daemon.log 2>&1; ` +
    `${env}nohup node daemon/server.js >> daemon/daemon.log 2>&1 & disown))`;
}

// Called by server.js FIRST THING on win32. Returns true when this process
// must exit because the real daemon belongs in WSL. The shell's watchdog
// retries every 5s, so two guard rails keep an outage from thrashing:
//  • wsl.exe unusable (missing/uninstalled) → hybrid is impossible on this
//    box: park hybrid.txt as hybrid.txt.stale and run as a normal Windows
//    daemon (returning false), instead of stranding the machine daemon-less.
//  • boot attempt already in flight / just failed → a stamp file throttles
//    re-spawning wsl.exe (a cold VM boot can take a while) to one attempt
//    per BOUNCE_THROTTLE_MS; the in-between watchdog spawns exit instantly.
const BOUNCE_THROTTLE_MS = 120000;
function hybridBounce(daemonDir) {
  if (process.platform !== "win32") return false;
  let cfg = null;
  try {
    cfg = parseHybridConfig(fs.readFileSync(path.join(daemonDir, "hybrid.txt"), "utf8"));
  } catch { return false; }
  if (!cfg) return false;
  const stamp = path.join(daemonDir, "hybrid-bounce.stamp");
  try {
    const last = parseInt(fs.readFileSync(stamp, "utf8"), 10);
    if (Number.isFinite(last) && Date.now() - last < BOUNCE_THROTTLE_MS) {
      console.log("[hybrid] bounce throttled — a WSL boot attempt is recent/in flight");
      return true;
    }
  } catch {}
  try { fs.writeFileSync(stamp, String(Date.now())); } catch {}
  const args = [];
  if (cfg.distro) args.push("-d", cfg.distro);
  args.push("--", "bash", "-lc", buildBootCommand(cfg.wslPath, path.resolve(daemonDir, "..")));
  try {
    const r = spawnSync("wsl.exe", args, { timeout: 90000, stdio: "ignore", windowsHide: true });
    if (r.error) throw r.error;
    console.log(`[hybrid] hybrid.txt present — booted the WSL daemon instead (wsl.exe exit ${r.status})`);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") {
      // wsl.exe is GONE (WSL uninstalled) → hybrid is impossible on this box.
      // Park the marker and run as a normal Windows daemon rather than
      // stranding the machine with no daemon at all.
      console.error("[hybrid] wsl.exe not found — parking hybrid.txt as .stale and running as a Windows daemon");
      try { fs.renameSync(path.join(daemonDir, "hybrid.txt"), path.join(daemonDir, "hybrid.txt.stale")); } catch {}
      try { fs.unlinkSync(stamp); } catch {}
      return false;
    }
    // Timeout / transient failure: WSL exists but didn't come up this round.
    // Keep the hybrid intent — the watchdog retries, throttled by the stamp.
    console.error("[hybrid] WSL boot attempt failed (" + e.message + ") — will retry, throttled");
    return true;
  }
}

module.exports = {
  INTEROP_CWD, isWSL, guiRoot, toWinPath, toWslPath, winTempDir, psExec,
  parseHybridConfig, buildBootCommand, hybridBounce,
};
