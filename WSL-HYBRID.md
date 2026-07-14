# WSL ハイブリッド構成 — デーモン = WSL / GUI = Windows

> **検証用ドキュメント（v1）** — コード変更なしで成立する構成の動作確認手順。

## 構成

```
┌─ WSL (Ubuntu) ──────────────────┐   ┌─ Windows ──────────────────────────┐
│ node daemon/server.js           │   │ bagidea-office-shell.exe (壁紙化)   │
│  ├ 127.0.0.1:8787 で待受        │◄──│  ├ Godot (オフィス描画)             │
│  ├ claude セッション (WSL側)     │   │  └ WebView2 オーバーレイ (チャット)  │
│  └ プロジェクト = WSLパス native │   │     → http://127.0.0.1:8787 に接続 │
└─────────────────────────────────┘   └────────────────────────────────────┘
```

**成立する理由（コード上の根拠）:**

- シェルは起動時に `127.0.0.1:8787` へ接続を試み、**既にデーモンが生きていれば spawn せず再利用する**（`shell/src/main.rs` の `spawn_daemon()`）
- WSL2 の localhost forwarding により、WSL 内で `127.0.0.1:8787` に listen しているデーモンへ Windows から `127.0.0.1:8787` で到達できる
- オーバーレイ UI はデーモンが HTTP で配信するため、UI・データ・エージェント実行はすべて WSL 側で一貫する
- フックはデーモン起動時に `wire-hooks-runtime.js` が自動配線するので、パスの手修正は不要

**この構成で得られるもの:**

- エージェント（claude セッション）は WSL で動く → 普段 WSL で使っている claude ログイン・ツール群をそのまま利用
- プロジェクトに WSL のパス（`/home/seiga/project/...`）をネイティブ指定できる
- 全データ（registry / sessions / projects）は WSL チェックアウトの `daemon/` 配下に保存される

---

## 事前準備（Windows 側・初回のみ）

### 1. fork を Windows 側に clone

Godot のプロジェクト・アセットとシェル exe の置き場として必要です（デーモンはここからは動かしません）。

```powershell
git clone https://github.com/seicham-hub/bagidea-office-wsl.git C:\dev\bagidea-office-wsl
cd C:\dev\bagidea-office-wsl
git checkout feat/wsl-hybrid
```

> ⚠ `\\wsl.localhost\...` の UNC パスから直接 Godot/シェルを動かすのは避ける
> （9P 越しのアセット読み込みが遅く不安定なため、Windows 側に実体を置く）。

### 2. Godot 4.6.3 (win64) を配置

```powershell
$gdir = "C:\dev\tools\godot"
New-Item -ItemType Directory -Force $gdir | Out-Null
Invoke-WebRequest "https://github.com/godotengine/godot/releases/download/4.6.3-stable/Godot_v4.6.3-stable_win64.exe.zip" -OutFile "$env:TEMP\godot.zip"
Expand-Archive "$env:TEMP\godot.zip" $gdir -Force
[Environment]::SetEnvironmentVariable("BAGIDEA_GODOT", "$gdir\Godot_v4.6.3-stable_win64.exe", "User")
```

### 3. プレビルドのシェル exe を配置

この fork は upstream `v0.9.43` とコード同一なので、upstream のリリースバイナリがそのまま使えます（Rust ビルド不要）:

```powershell
$rel = "C:\dev\bagidea-office-wsl\shell\target\release"
New-Item -ItemType Directory -Force $rel | Out-Null
Invoke-WebRequest "https://github.com/bagidea/bagidea-office/releases/download/v0.9.43/bagidea-office-shell-windows-x64.exe" -OutFile "$rel\bagidea-office-shell.exe"
```

---

## 起動手順（毎回）

**順序が重要です — 必ず WSL のデーモンを先に起動してください。**
（先に Windows シェルを起動すると、:8787 が空いているためシェルが Windows 側で独自にデーモンを spawn してしまい、データが分裂します）

### 1. WSL: デーモン起動

```bash
cd ~/project/bagidea-office-wsl
node daemon/server.js
```

起動ログが出て待機状態になればOK。claude には WSL 側でログイン済みであること（`claude` を一度実行）。

### 2. Windows: 到達確認 → GUI 起動

```powershell
# 到達確認（JSON が返ればOK）
curl.exe http://127.0.0.1:8787/health

# GUI 起動（同梱のランチャー — デーモン到達チェック込み）
powershell -ExecutionPolicy Bypass -File C:\dev\bagidea-office-wsl\run-hybrid-windows.ps1
```

ランチャーを使わない場合は exe 直接起動でも同じです:

```powershell
C:\dev\bagidea-office-wsl\shell\target\release\bagidea-office-shell.exe
```

### 3. 停止

- **GUI**: トレイアイコン右クリック → Exit（シェルはデーモンを所有していないので、デーモンは生き残る = 正常）
- **デーモン**: WSL のターミナルで `Ctrl+C`

> `bagidea stop` を WSL で打っても **Windows 側のシェル/Godot は殺せません**（pkill は Linux プロセスのみ対象）。GUI はトレイから終了してください。

---

## 動作確認チェックリスト

| # | 確認項目 | 期待結果 |
|---|---|---|
| 1 | `curl.exe http://127.0.0.1:8787/health`（Windows側） | JSON が返る |
| 2 | シェル起動 | 壁紙がオフィスになる・チャットヘッド表示・トレイアイコン表示 |
| 3 | WSL 側のデーモンログ | シェル接続時に client 接続のログが増える（二重デーモンが起きていない） |
| 4 | チャットヘッド → Shino に挨拶 | 返答が返る（= claude が **WSL側で** 実行されている） |
| 5 | WSL 側で `ps aux \| grep claude` | エージェント実行中に claude プロセスが見える |
| 6 | プロジェクト作成で WSL パスを指定（例 `/home/seiga/project/...`） | 作成でき、エージェントがその中で作業できる |
| 7 | GUI を Exit → 再起動 | デーモンは生き続け、再接続できる |

## 既知の制限（v1 = 未改修で予想される劣化）

これらは本ブランチで今後改修する候補。**動かなくても想定内**です:

| 機能 | 状況 | 原因 |
|---|---|---|
| 🗺 3D オフィスエディタを開く | ❌ 開かない | デーモン(WSL)がリクエストフラグを WSL の `/tmp` に書くが、シェルは Windows の `%TEMP%` を監視している |
| 🖥 マルチモニタ選択 | ❌ 効かない | デーモンが WSL チェックアウトの `daemon/monitor.txt` に書くが、シェルは Windows クローン側の同ファイルを読む |
| プロジェクトウィンドウの表示/整列 | ⚠ 劣化 | デーモンが Linux コードパス（wmctrl 等）を使うため Windows のウィンドウを操作できない |
| エクスプローラで開く / ファイルを開く | ⚠ 劣化 | 同上（xdg-open 系）。WSLg 側で開くことはある |
| UI からの再起動（⚙ → restart） | ❌ 使わない | デーモンが Linux 用シェルバイナリを relaunch しようとする |
| デーモンが死んだ場合 | ⚠ 注意 | シェルのウォッチドッグが Windows 側 node で独自デーモンを起こす可能性 → GUI を終了し、WSL デーモンを先に再起動すること |
| 音声（TTS のローカル再生） | ⚠ 環境依存 | WSL 側再生は WSLg PulseAudio 次第。オーバーレイ内の再生（WebView2）は動く見込み |

## トラブルシューティング

- **Windows から `/health` に届かない**: WSL2 のネットワークモードを確認。`%USERPROFILE%\.wslconfig` で `networkingMode=mirrored` を使っている場合も基本は届くが、NAT モードで `localhostForwarding=false` にしていると届かない（未設定ならデフォルト true）。
- **壁紙は出るがチャットが真っ白**: WebView2 ランタイム未導入の可能性（Win11 は通常プリインストール済み）。
- **Godot が起動しない**: `BAGIDEA_GODOT` 設定後に**新しいターミナル**で起動しているか確認（User 環境変数は既存プロセスに反映されない）。
- **二重デーモン疑い**: Windows 側で `tasklist | findstr node` に `server.js` 持ちの node がいたら、それは誤 spawn。タスクキルして WSL デーモン → シェルの順で起動し直す。
