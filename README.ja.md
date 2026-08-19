# DevSpace One-Click for Windows

[DevSpace](https://github.com/Waishnav/devspace) を Windows 上で Cloudflare Quick Tunnel 越しに使うための、非公式ワンクリック系ランチャーです。

**Current release: v1.1.0 (2026-08-19)** — SessionGuard、自動的な最小修復、診断強化、長時間 ChatGPT セッションの耐障害性改善を含むアップデートです。変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。

普段の操作はこれまで通り、基本的に `start-devspace.cmd` をダブルクリックするだけです。

この版では **SessionGuard** を追加し、長時間使った同じ ChatGPT チャットが、DevSpace 再起動などを境に古い MCP session を握ったまま接続不能になる問題を実用上かなり吸収します。

> DevSpace / Cloudflare / OpenAI の公式プロジェクトではありません。

## SessionGuard が直すもの

DevSpace の MCP Streamable HTTP session は stateful です。ChatGPT 側が保持している `Mcp-Session-Id` に対応する DevSpace 側 transport が、DevSpace 再起動・session cleanup・transport close などで消えると、DevSpace は unknown session として HTTP 404 を返します。

SessionGuard は Cloudflare と DevSpace の間に入り、この stale session を限定的に修復します。

```text
ChatGPT
   |
   v
Cloudflare Quick Tunnel
   |
   v
SessionGuard 127.0.0.1:7677
   |
   v
DevSpace     127.0.0.1:7676
```

SessionGuard 経由で一度 initialize 済みの session に対し、session 付き `/mcp` リクエストが downstream DevSpace から HTTP 404 を受けた時だけ、次を行います。

1. DevSpace に対して fresh `initialize` を1回だけ実行
2. `notifications/initialized` を1回送信
3. 外向きの古い session ID と、新しい downstream session ID の対応を原子的に更新
4. 元のリクエストを **1回だけ** 再送
5. ChatGPT から見える外向きの `Mcp-Session-Id` は維持

無限 retry はしません。401 / 403 / 一般的な4xx・5xx / timeout / connection reset など、実行済みか判定できない曖昧な失敗は自動再送しません。

## SessionGuard でも直せないもの

もう一つ、別系統の障害があります。

ChatGPT 側では DevSpace の tool 一覧を再発見できているのに、特定の古いチャットだけ direct tool invocation がローカルへ送信される前に失敗することがあります。

この場合、リクエスト自体が SessionGuard に到達していないため、ローカルの reverse proxy では修復できません。

その切り分けのため、`status-devspace.cmd` は次を表示します。

```text
cloudflared:  running (...)
SessionGuard: running (...)
DevSpace:     running (...)
MCP URL:      https://...trycloudflare.com/mcp
Last MCP seen: ...
Recovery:      2 succeeded, 0 failed
```

ChatGPT が DevSpace invocation error を出しているのに、3プロセスが正常で `Last MCP seen` が更新されていないなら、少なくともその失敗は SessionGuard より手前で起きた可能性が高い、と切り分けられます。

より詳しい診断は、通常利用用のCMDを増やさず次で実行できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\devspace-control.ps1 diagnose
```

PID・listener・安全なtraffic/recovery counter・SessionGuard経由のlocal metadata・public tunnel経由のmetadataを確認します。tokenや完全なMCP session IDは表示しません。

## 普段の使い方

### 起動・自己修復

```text
start-devspace.cmd
```

これが今後も通常の入口です。

Ver.2では、可能なら壊れた層だけを直します。

- Tunnel + SessionGuard が生きていて DevSpace だけ停止 → **DevSpaceだけ再起動**、URL維持
- Tunnel + DevSpace が生きていて SessionGuard だけ停止 → **SessionGuardだけ再起動**、URL維持
- 全部正常 → そのまま維持
- Tunnel が停止 → Quick Tunnel の仕様上、新URL生成は不可避。ただし可能なら SessionGuard 自体は維持し、session mappingを残す

無駄な tunnel 再生成を減らすことで、長時間ChatGPTチャットの connector churn も減らします。

### 許可フォルダ変更

```text
change-devspace-root.cmd
```

3層すべて正常なら、設定を原子的に更新したあと **DevSpaceだけ** 再起動します。SessionGuard と Cloudflare Tunnel は維持されるため、MCP URL は変わりません。

### 状態確認

```text
status-devspace.cmd
```

### 停止

```text
stop-devspace.cmd
```

外部入口の Tunnel を最初に止め、その後 SessionGuard、DevSpace の順で停止します。

## 旧版から最初の1回だけ必要な移行

旧版は次の直結構成でした。

```text
Cloudflare -> DevSpace:7676
```

SessionGuard版では次になります。

```text
Cloudflare -> SessionGuard:7677 -> DevSpace:7676
```

ランチャーは旧managed tunnelの PID と command line も認識するため、初回移行時に古い `cloudflared` を見失って二重起動することはありません。

ただし Quick Tunnel の転送先は起動時に固定されるため、**最初の移行時だけは tunnel の作り直しが必要**です。したがって一度だけ新しい `trycloudflare.com` URL が発行され、ChatGPT 側MCP接続先を更新する必要があります。

移行後は、Tunnelプロセスが生きている限り、DevSpace再起動や通常のroot変更では同じURLを維持します。

もしZip内の旧SessionGuard V1試作をすでに起動している場合も、V2固有の起動引数で世代を判別し、既存Tunnelを残したままGuardだけV2へ差し替えます。

なお Quick Tunnel 自体を再起動した場合にURLが変わる仕様は、SessionGuardでは消せません。

## 設定

必要な場合だけ `launcher.settings.example.json` をコピーして `launcher.settings.json` を作ります。

```json
{
  "Port": 7676,
  "BridgePort": 7677,
  "StartupTimeoutSeconds": 30,
  "HttpTimeoutSeconds": 20,
  "BackupRetention": 10
}
```

- `Port`: DevSpace のlocal port
- `BridgePort`: SessionGuard のlocal bridge port
- 2つは別ポートである必要があります

## Runtime state

以下に保存します。

```text
%USERPROFILE%\.devspace\runtime
```

主なファイル:

- `cloudflared.pid`
- `session-guard.pid`
- `devspace.pid`
- `public-url.txt`
- `session-guard-state.json`
- `session-guard-runtime.json`
- 各プロセスの stdout / stderr log

### `session-guard-state.json`

stale session を修復するための回復stateです。

保存するもの:

- external / downstream MCP session ID
- sanitize済み initialize message
- 安全な initialize header
- protocol version metadata

保存しないもの:

- Authorization header
- bearer token
- cookie
- password
- tool arguments

Recovery時に必要な Authorization は、その瞬間の受信リクエストから **メモリ上だけ** で downstream initialize に渡し、永続化しません。

### `session-guard-runtime.json`

診断専用stateで、recovery stateとは分離しています。

保存するのは random guard instance ID、timestamp、counterだけです。

- HTTP/MCP request数
- initialize観測数
- downstream session 404数
- recovery start / success / failure数

request body、tool args、query string、token、完全なfilesystem path、public tunnel URLは保存しません。

## セキュリティ

従来の安全設計は維持しています。

- `allowedRoots` は明示的に選んだ1フォルダだけ
- ドライブルートとWindows homeを拒否
- DevSpace JSONはatomic write
- config backup保持
- root変更失敗時rollback
- PID + process name + command-line fragmentが一致したmanaged processだけ停止・再利用
- npm package metadataからDevSpace CLIを動的解決
- Quick Tunnel URLを検証
- local listenerの所有PIDを確認
- public OAuth metadataを確認
- mutexでlauncher操作を直列化
- Cloudflare -> SessionGuard -> DevSpace のproxy chain用に `DEVSPACE_TRUST_PROXY=1`

SessionGuard固有の制約:

- defaultはloopback bindのみ
- CloudflareからDevSpaceへの直結をやめる
- 自動回復対象は known session付き `/mcp` の downstream HTTP 404だけ
- external sessionごとに同時reinitializeは1本だけ
- 元操作のretryは最大1回
- timeout/reset等の曖昧な失敗は再送禁止
- SSEを全bufferせずstream passthrough
- DevSpace/npm package本体をpatchしない
- unauthenticatedなpublic診断endpointを追加しない
- logには正規化したpathだけを残しquery stringを残さない

詳細は [SECURITY.md](SECURITY.md) と [docs/SESSIONGUARD.md](docs/SESSIONGUARD.md) を参照してください。

## テスト

SessionGuard behavior:

```powershell
node --test tests/session-guard.test.mjs
```

CLI / process smoke:

```powershell
node tests/session-guard-smoke.mjs
```

Windows launcher static / isolated checks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Static.ps1
```

テスト対象には、DevSpace再起動相当のsession消失、Guard再起動後のmapping復元、同時404 single-flight、401/403/500でrecoverしないこと、connection resetを再送しないこと、diagnostic counter、secret非永続化、query string非記録、SSE streamingが含まれます。

## 既知の制限

- Quick Tunnel URLは一時URLなので、Tunnelプロセス再作成時はhostnameが変わり得ます。
- SessionGuardが自動回復できるのは、SessionGuard経由でinitializeを観測・保存できたsessionです。
- ChatGPT側のtool/capability binding failureなど、local endpointへ届く前の失敗はSessionGuardでは修復できません。
- 旧直結版からSessionGuard版への初回移行時だけ、Tunnel再作成とChatGPT側URL更新が1回必要です。
- ChatGPT UI操作やChatGPT credential保存は行いません。

## License

MIT. [LICENSE](LICENSE) を参照してください。
