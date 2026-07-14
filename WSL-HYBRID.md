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

## 事前準備（初回のみ）

### 0. WSL: claude にログイン済みであること

普段 WSL で claude を使っていればそのままでOK（未ログインなら WSL で `claude` を一度実行）。

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

## 起動（日常使い — 1コマンド）

ランチャーが全部やります: **デーモンが落ちていれば WSL 内で自動起動**（`wsl.exe -- bash -lc` 経由、nvm の node も解決）→ :8787 のヘルス待ち → GUI 起動。

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\bagidea-office-wsl\run-hybrid-windows.ps1
```

停止も1コマンド（Windows の GUI + WSL のデーモンを両方止める）:

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\bagidea-office-wsl\run-hybrid-windows.ps1 -Stop
```

> WSL のリポジトリパスがデフォルト（`~/project/bagidea-office-wsl`）と違う場合は `-WslPath`、
> デフォルト以外のディストロを使う場合は `-Distro Ubuntu-22.04` のように指定。

### Windows ログイン時の自動起動（ハイブリッドモード）

```powershell
# 登録 — PC 起動時に「WSLデーモン → GUI」の順で自動起動
powershell -ExecutionPolicy Bypass -File C:\dev\bagidea-office-wsl\run-hybrid-windows.ps1 -Register

# 解除
powershell -ExecutionPolicy Bypass -File C:\dev\bagidea-office-wsl\run-hybrid-windows.ps1 -Unregister
```

### モード切替（WSL ⇄ Windows）

自動起動の実体は HKCU Run キーの `BagIdeaOffice` という**同じ1つの値**で、どちらを指すかだけの違いです。切替はそれぞれ1コマンド:

| モード | claude の実行場所 | 切替コマンド |
|---|---|---|
| **ハイブリッド**（このブランチ） | WSL | `run-hybrid-windows.ps1 -Register` |
| **純Windows**（upstream 標準） | Windows | `run-hybrid-windows.ps1 -Unregister` → `bagidea startup on` |

> ⚠ 純Windowsへ戻すときは **必ず先に `-Unregister`**。ハイブリッドマーカー（`daemon\hybrid.txt`）が
> 残っていると、Windows 側で起動したデーモンは WSL にバウンスし続けます（`-Unregister` が消します）。

### 手動起動したい場合（デバッグ時）

WSL でフォアグラウンド起動するとデーモンのログが直接見えます:

```bash
cd ~/project/bagidea-office-wsl && node daemon/server.js
```

その後 Windows 側でランチャー（または shell exe 直接）を起動。ランチャーは既にデーモンが生きていれば二重起動しません。

> ⚠ **順序の原則**: shell exe を「デーモン不在のまま」直接起動しないこと。:8787 が空だとシェルが Windows 側で独自デーモンを spawn し、データが分裂します。ランチャー経由ならこの事故は起きません。

### 停止の内訳（手動でやる場合）

- **GUI**: トレイアイコン右クリック → Exit（シェルはデーモンを所有していないので、デーモンは生き残る = 正常）
- **デーモン**: フォアグラウンドなら `Ctrl+C`、バックグラウンドなら `pkill -f 'node.*daemon/server.js'`
- `bagidea stop` を WSL で打っても **Windows 側のシェル/Godot は殺せません**（pkill は Linux プロセスのみ対象）

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

**v2（interop 対応）の追加チェック:**

| # | 確認項目 | 期待結果 |
|---|---|---|
| 8 | ⋯ → 🗺 3D オフィスエディタを開く | スプラッシュ → エディタが別ウィンドウで開く |
| 9 | プロジェクトの ▶ 開く | **Windows Terminal** が開き、WSL のプロジェクトディレクトリに入っている |
| 10 | プロジェクト作成 → 📁 フォルダ選択 | **Windows のフォルダ選択ダイアログ**が出て、選択結果が WSL パスで入る |
| 11 | チャットのファイル添付 → 「エクスプローラで表示」 | Windows のエクスプローラが `\\wsl.localhost\...` で開く |
| 12 | トレイ → Restart office | 両側（GUI + デーモン）が順に再起動して戻ってくる |
| 13 | WSL で `pkill -f 'node.*daemon/server.js'` → 10秒待つ | ウォッチドッグのバウンスで **WSL 側に**デーモンが復活する（Windows 側 `tasklist \| findstr node` に server.js の node が残らない） |
| 14 | ⋯ → 🖥 Display でモニタ変更（マルチモニタ時） | 選んだモニタに壁紙が移って再起動する |

## v2: ハイブリッド対応済みの機能（Windows interop 経由）

v1 で「想定劣化」としていた項目は、デーモン側の WSL 検出 + Windows interop
（`explorer.exe` / `powershell.exe` / `wt.exe` / `wsl.exe` は WSL⇄Windows 双方向で呼べる）で対応済みです。
実装は `daemon/wsl.js` + `daemon/server.js` の各分岐。**Rust シェルの変更なし**（プレビルド exe のままでOK）。

| 機能 | v2 の動き | 実装 |
|---|---|---|
| 🗺 3D オフィスエディタを開く | ✅ 開く | デーモンがリクエストフラグを **Windows の %TEMP% にもミラー**（interop で `$env:TEMP` を1回取得してキャッシュ） |
| 🖥 マルチモニタ選択 | ✅ 効く | `monitor.txt` を **Windows クローン側にもミラー書き**（ランチャーが渡す `BAGIDEA_GUI_ROOT` で場所を知る） |
| プロジェクトを開く / 表示・整列 | ✅ 動く | **Windows Terminal を interop で起動**し `wsl.exe --cd <dir>` で WSL に入る（claude は WSL 側のまま）。タイトルマーカー方式はそのままなので `winproj.ps1` の hide/resume も interop 経由で動く |
| エクスプローラで開く / ファイルを開く | ✅ 動く | `wslpath -w` で `\\wsl.localhost\...` に変換して `explorer.exe` / `cmd start` |
| フォルダ選択ダイアログ | ✅ ネイティブ化 | Windows の FolderBrowserDialog を interop で表示し、結果を `wslpath -u` で WSL パスに戻す |
| UI からの再起動（⚙ / トレイ → restart） | ✅ 動く | デーモンが Windows 側の `run-hybrid-windows.ps1 -Restart` を interop で起動（両側を正しい順で再起動） |
| デーモンが死んだ場合 | ✅ 自己修復 | シェルのウォッチドッグが Windows 側でデーモンを spawn しても、`daemon/hybrid.txt` を見て **WSL デーモンを起動し直して即終了**（バウンス）。データ分裂は起きない |
| 音声（TTS のローカル再生） | ⚠ 環境依存のまま | オーバーレイ内の再生（WebView2）は動く見込み。WSL 側再生（`bagidea say`）は WSLg PulseAudio 次第 |

> `daemon/hybrid.txt` はランチャーが Windows クローンに自動生成するハイブリッドモードのマーカーです
> （`{"wslPath":"...","distro":""}`）。**純Windowsモードに戻すときは `-Unregister` で消える**
> （手動で消してもOK）。これが残っていると Windows 側でデーモンを起動してもWSLにバウンスします。

## トラブルシューティング

- **Windows から `/health` に届かない**: WSL2 のネットワークモードを確認。`%USERPROFILE%\.wslconfig` で `networkingMode=mirrored` を使っている場合も基本は届くが、NAT モードで `localhostForwarding=false` にしていると届かない（未設定ならデフォルト true）。
- **壁紙は出るがチャットが真っ白**: WebView2 ランタイム未導入の可能性（Win11 は通常プリインストール済み）。
- **Godot が起動しない**: `BAGIDEA_GODOT` 設定後に**新しいターミナル**で起動しているか確認（User 環境変数は既存プロセスに反映されない）。
- **二重デーモン疑い**: Windows 側で `tasklist | findstr node` に `server.js` 持ちの node がいたら、それは誤 spawn。タスクキルして WSL デーモン → シェルの順で起動し直す。
