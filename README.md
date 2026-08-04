# DevSpace One-Click for Windows

Windows 上の [DevSpace](https://github.com/Waishnav/devspace) と Cloudflare Quick Tunnel を、ダブルクリック中心で運用するための非公式コンパニオンツールです。

- PC 再起動後: `start-devspace.cmd` をダブルクリック
- 接続先フォルダ変更: フォルダパスをコピーして `change-devspace-root.cmd` をダブルクリックし、貼り付け
- 停止: `stop-devspace.cmd`
- 状態確認: `status-devspace.cmd`

DevSpace サーバー、Quick Tunnel URL の取得、`publicBaseUrl` 更新、外部 OAuth メタデータ疎通確認、`allowedRoots` の安全な切替と失敗時ロールバックを自動化します。

> [!IMPORTANT]
> このプロジェクトは DevSpace の公式プロジェクトではありません。DevSpace 本体を同梱せず、インストール済みの `@waishnav/devspace` を利用します。

## 何が楽になるか

通常、Cloudflare Quick Tunnel は再起動時に URL が変わります。このツールは新しい URL を自動取得し、DevSpace の `publicBaseUrl` を更新し、外部から到達できることまで確認します。

別のリポジトリを扱うときは、対象フォルダのパスを貼り付けるだけです。DevSpace と Tunnel が稼働中なら Tunnel を維持したまま DevSpace サーバーだけを再起動するため、MCP URL は変わりません。

最後に ChatGPT 側へ URL を登録・更新する操作だけは人間に残しています。ChatGPT の頻繁な UI 変更へ依存せず、ローカルツールへ ChatGPT の認証情報を渡さないためです。

## 必要環境

- Windows 10 または Windows 11
- Windows PowerShell 5.1 以上
- Node.js と npm
- DevSpace (`@waishnav/devspace`)
- Cloudflare `cloudflared`

導入例:

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g @waishnav/devspace
winget install --id Cloudflare.cloudflared
```

DevSpace 本体の初期設定と ChatGPT への MCP 登録については、DevSpace 公式 README も確認してください。

## 導入

1. このリポジトリを任意のフォルダへ clone または ZIP 展開します。
2. 必要に応じて `launcher.settings.example.json` を `launcher.settings.json` としてコピーし、設定を変更します。
3. 最初に `change-devspace-root.cmd` を実行し、DevSpace に許可するフォルダを指定します。
4. 表示された `https://...trycloudflare.com/mcp` を ChatGPT の MCP 設定へ貼り付けます。

```powershell
git clone https://github.com/Soph1yzzz/devspace-one-click-windows.git
cd devspace-one-click-windows
```

## 使い方

### 起動・再起動後

`start-devspace.cmd` をダブルクリックします。

既に管理対象の DevSpace と Tunnel が動いている場合は、現在の URL を維持します。停止している場合は新しい Quick Tunnel を開始し、URL を表示します。

### 接続先フォルダの変更

1. エクスプローラーで対象フォルダのパスをコピーします。
2. `change-devspace-root.cmd` をダブルクリックします。
3. パスを貼り付けて Enter を押します。

または PowerShell から直接指定できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\change-devspace-root.ps1 -Path "C:\path\to\repository"
```

安全のため、ドライブルートとユーザーホーム全体は拒否されます。`allowedRoots` は指定フォルダ一つだけに置き換えられます。

### 状態確認

`status-devspace.cmd`、または:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\devspace-control.ps1 status
```

### 停止

`stop-devspace.cmd`、または:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\devspace-control.ps1 stop
```

## 設定

`launcher.settings.example.json` を `launcher.settings.json` としてコピーします。

```json
{
  "Port": 7676,
  "StartupTimeoutSeconds": 30,
  "HttpTimeoutSeconds": 20,
  "BackupRetention": 10
}
```

| 設定 | 内容 |
|---|---|
| `Port` | DevSpace の待受ポート。DevSpace 側の設定と一致させます。 |
| `StartupTimeoutSeconds` | DevSpace / Tunnel 起動待機時間。 |
| `HttpTimeoutSeconds` | 公開 OAuth メタデータ確認のタイムアウト。 |
| `BackupRetention` | ルート変更前の設定バックアップ保持数。 |

個人設定ファイル `launcher.settings.json` は Git 対象外です。

## 安全設計

- `allowedRoots` を常に一つの明示フォルダへ限定
- ドライブルートとユーザーホーム全体を拒否
- DevSpace 設定を一時ファイル経由で原子的に更新
- 変更前設定を `%USERPROFILE%\.devspace\backups` に保存
- ルート変更または再起動失敗時に自動ロールバック
- PID、プロセス名、コマンドラインを照合して管理対象だけを停止
- DevSpace パッケージの `package.json` から CLI の場所を動的解決
- Quick Tunnel URL の形式を検証
- 外部公開 URL から OAuth メタデータが HTTP 200 を返すことを確認
- ChatGPT UI のブラウザ自動操作や認証情報保存を行わない

## ログとバックアップ

実行時データは DevSpace の既存ディレクトリ内に保存されます。

```text
%USERPROFILE%\.devspace\runtime\
%USERPROFILE%\.devspace\backups\
```

主なログ:

- `cloudflared.out.log`
- `cloudflared.err.log`
- `devspace.out.log`
- `devspace.err.log`

## 更新

DevSpace 更新後も、固定された `dist/cli.js` を直接仮定せず、インストール済みパッケージの `package.json` にある `bin` 定義を読み取ります。

更新例:

```powershell
npm update -g @waishnav/devspace
winget upgrade --id Cloudflare.cloudflared
```

更新後は `tests\Test-Static.ps1` を実行してください。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Static.ps1
```

## トラブルシューティング

### `cloudflared was not found`

```powershell
winget install --id Cloudflare.cloudflared
```

### `devspace was not found`

```powershell
npm install -g @waishnav/devspace
```

### ポートが使用中

表示された PID のプロセスを確認してください。別の DevSpace を手動起動している場合は停止します。

```powershell
Get-NetTCPConnection -LocalPort 7676 -State Listen
```

### Quick Tunnel URL を取得できない

`%USERPROFILE%\.devspace\runtime\cloudflared.err.log` を確認してください。Cloudflare 側の一時障害、ネットワーク制限、セキュリティソフトの遮断が考えられます。

### 公開疎通確認に失敗する

`devspace.err.log` と `cloudflared.err.log` を確認してください。Tunnel 作成直後の伝播が遅い環境では `HttpTimeoutSeconds` を増やせます。

### ルート変更に失敗した

設定は可能な限り直前のバックアップへ戻されます。バックアップは `%USERPROFILE%\.devspace\backups` にあります。

## 既知の制約

- Windows 専用です。
- Cloudflare Quick Tunnel は一時 URL であり、稼働保証や固定 URL を提供しません。
- PC 再起動や Tunnel 再作成後は ChatGPT 側の MCP URL を手動更新する必要があります。
- ChatGPT の設定 UI は自動操作しません。
- DevSpace や Cloudflare の将来の破壊的変更へ完全な互換性を保証するものではありません。
- 実動テストでは現在利用中の DevSpace 接続を停止・再作成するため、作業中のセッションがある場合は静的テストだけを使用してください。

## セキュリティ

脆弱性を見つけた場合は、公開 Issue に秘密情報や再現用トークンを書かず、[SECURITY.md](SECURITY.md) の手順に従ってください。

Quick Tunnel の URL は秘密鍵ではありませんが、不用意に公開しないでください。DevSpace の認証・認可設定と `allowedRoots` を最小権限に保ってください。

## ライセンス

MIT License。詳細は [LICENSE](LICENSE) を参照してください。
