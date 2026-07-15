// Unit tests for the WSL hybrid-mode helpers (daemon/wsl.js).
// Pure functions only — the interop calls (wslpath / powershell.exe) need a
// real WSL host and are exercised by the manual WSL-HYBRID.md checklist.
const test = require('node:test');
const assert = require('node:assert');

const { parseHybridConfig, buildBootCommand } = require('../wsl');

test('parseHybridConfig accepts a minimal valid config', () => {
  const c = parseHybridConfig('{"wslPath":"~/project/bagidea-office-wsl","distro":""}');
  assert.deepStrictEqual(c, { wslPath: '~/project/bagidea-office-wsl', distro: '' });
});

test('parseHybridConfig strips the BOM PowerShell 5.1 utf8 prepends', () => {
  const c = parseHybridConfig('﻿{"wslPath":"~/office","distro":""}');
  assert.deepStrictEqual(c, { wslPath: '~/office', distro: '' });
});

test('parseHybridConfig keeps a named distro', () => {
  const c = parseHybridConfig('{"wslPath":"/opt/bagidea","distro":"Ubuntu-22.04"}');
  assert.deepStrictEqual(c, { wslPath: '/opt/bagidea', distro: 'Ubuntu-22.04' });
});

test('parseHybridConfig rejects garbage, empty and missing wslPath', () => {
  assert.strictEqual(parseHybridConfig('not json'), null);
  assert.strictEqual(parseHybridConfig('{}'), null);
  assert.strictEqual(parseHybridConfig('{"wslPath":"  "}'), null);
});

test('parseHybridConfig rejects wslPath that could escape the bash quoting', () => {
  // The path lands inside a double-quoted bash string — ", \, $ and ` must
  // never pass (command injection via a hand-edited hybrid.txt).
  for (const bad of ['a"b', 'a\\b', 'a$(x)b', 'a`x`b', '$HOME/x']) {
    assert.strictEqual(parseHybridConfig(JSON.stringify({ wslPath: bad })), null, bad);
  }
});

test('buildBootCommand expands a leading ~/ via $HOME outside the quotes', () => {
  const cmd = buildBootCommand('~/project/office', null);
  assert.match(cmd, /^cd "\$HOME\/project\/office" && /);
  assert.ok(!cmd.includes('~'), 'no unexpanded tilde inside quotes');
});

test('buildBootCommand quotes an absolute path as-is', () => {
  const cmd = buildBootCommand('/opt/bag idea/office', null);
  assert.match(cmd, /^cd "\/opt\/bag idea\/office" && /);
});

test('buildBootCommand is a health-gated background boot', () => {
  const cmd = buildBootCommand('~/office', null);
  assert.ok(cmd.includes('curl -s -m1 http://127.0.0.1:8787/health'), 'probes health first');
  assert.ok(cmd.includes('echo [hybrid-boot] $(date) bounce >> daemon/daemon.log'),
    'leaves a diagnosable marker before starting node');
  assert.ok(cmd.includes('nohup node daemon/server.js'), 'boots the daemon');
  assert.ok(!cmd.includes('setsid'),
    'no setsid — a setsid child escapes the wsl.exe session and WSL init reaps it');
  assert.ok(cmd.includes('& disown'), 'detaches so it survives wsl.exe returning');
  assert.ok(!cmd.includes('BAGIDEA_GUI_ROOT'), 'no GUI root when none was given');
});

test('buildBootCommand passes the Windows GUI root through wslpath', () => {
  const cmd = buildBootCommand('~/office', 'C:\\dev\\bagidea-office-wsl');
  assert.ok(cmd.includes(`BAGIDEA_GUI_ROOT="$(wslpath -u 'C:\\dev\\bagidea-office-wsl')"`));
});

test('buildBootCommand strips single quotes from the Windows root (quoting safety)', () => {
  const cmd = buildBootCommand('~/office', "C:\\odd'name");
  assert.ok(!cmd.includes("odd'name"));
  assert.ok(cmd.includes('C:\\oddname'));
});
