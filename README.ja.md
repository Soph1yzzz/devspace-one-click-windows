# DevSpace One-Click for Windows 日本語ガイド

[English full documentation](README.md)

Windows上の[DevSpace](https://github.com/Waishnav/devspace)とCloudflare Quick Tunnelを、ほぼダブルクリックだけで運用するための非公式ツールです。

> [!IMPORTANT]
> DevSpace公式プロジェクトではありません。DevSpace本体は同梱せず、グローバルにインストールされた`@waishnav/devspace`を利用します。

## できること

- PC再起動後のDevSpaceとQuick Tunnelの起動
- Quick Tunnel URLの自動取得
- DevSpaceの`publicBaseUrl`更新
- 外部OAuthメタデータの疎通確認
- `allowedRoots`の安全な切替
- 設定バックアップと失敗時の自動ロールバック
- 現在の状態とMCP URLの表示
- DevSpaceとTunnelの一括停止

ChatGPT側へMCP URLを登録・更新する最後の操作だけは、意図的に手動で残しています。ChatGPTの頻繁なUI変更に依存せず、認証情報やブラウザ操作権限をツールへ渡さないためです。

## 必要環境

- Windows 10 / 11
- Windows PowerShell 5.1以上
- Node.jsとnpm
- DevSpace
- Cloudflare `cloudflared`

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g @waishnav/devspace
winget install --id Cloudflare.cloudflared
```

## 導入

```powershell
git clone https://github.com/Soph1yzzz/devspace-one-click-windows.git
cd devspace-one-click-windows
```

1. リポジトリをcloneするかZIPで展開します。
2. `change-devspace-root.cmd`をダブルクリックします。
3. DevSpaceに許可するフォルダのパスを貼り付けます。
4. 表示された`https://...trycloudflare.com/mcp`をChatGPTのMCP設定へ貼り付けます。

通常は設定ファイルを触る必要はありません。ポートやタイムアウトを変更する場合だけ、`launcher.settings.example.json`を`launcher.settings.json`としてコピーしてください。

## 普段の操作

### 起動・PC再起動後

`start-devspace.cmd`をダブルクリックします。

既にDevSpaceとTunnelが動いていれば現在のURLを維持します。停止していれば新しいQuick Tunnelを作成し、DevSpace設定の更新、起動、疎通確認まで自動で行います。

### 接続先リポジトリの変更

1. エクスプローラーで対象フォルダのパスをコピーします。
2. `change-devspace-root.cmd`をダブルクリックします。
3. パスを貼り付けてEnterを押します。

既存Tunnelが動いている場合はTunnelを維持し、DevSpaceサーバーだけを再起動するため、通常MCP URLは変わりません。

安全のため、ドライブルートとユーザーホーム全体は拒否されます。`allowedRoots`は指定した一つのフォルダだけに置き換えられます。

### 状態確認

`status-devspace.cmd`をダブルクリックします。

DevSpace、cloudflaredの稼働状態と現在のMCP URLを表示します。

### 停止

`stop-devspace.cmd`をダブルクリックします。

DevSpaceとCloudflare Quick Tunnelをまとめて停止します。

## 安全設計

- 許可フォルダを一つだけに限定
- ドライブルートとユーザーホーム全体を拒否
- 設定を原子的に書込み
- 変更前の設定をバックアップ
- 失敗時に可能な限り自動復元
- PID、プロセス名、コマンドラインを照合して誤停止を抑制
- DevSpaceのCLI場所を`package.json`から動的に解決
- Quick Tunnel URLと公開OAuthエンドポイントを検証
- 二重操作を防止
- ChatGPTのUIを自動操作せず、認証情報も保存しない

## ログとバックアップ

```text
%USERPROFILE%\.devspace\runtime\
%USERPROFILE%\.devspace\backups\
```

問題が起きた場合は、`cloudflared.err.log`と`devspace.err.log`を確認してください。

## 更新後の確認

```powershell
npm update -g @waishnav/devspace
winget upgrade --id Cloudflare.cloudflared
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Static.ps1
```

詳細な設定、トラブルシューティング、既知の制約、セキュリティモデルは[英語の正式README](README.md)を参照してください。

## ライセンス

MIT License。詳細は[LICENSE](LICENSE)を参照してください。
