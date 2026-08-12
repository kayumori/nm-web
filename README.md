# NeuMind

Notionのデータベースを、マインドマップとして編集・共有できるアプリです。
マップの内容はすべてあなたのNotionに保存されます。

## 自分専用のNeuMindを作る

下のボタンを押すと、あなたのCloudflareアカウントに設置されます。
費用はかかりません（Cloudflareの無料枠で動きます）。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kayumori/nm-web)

設置の途中で、次の2つを入力します。

| 項目 | 入れるもの |
|---|---|
| `NOTION_TOKEN` | Notionの内部インテグレーションシークレット（`ntn_` から始まる文字列） |
| `OWNER_PASSWORD` | このアプリに入るためのパスワード（自分で決める） |

くわしい手順は購入者向けの導入マニュアルをご覧ください。

## 使い方

設置が終わると発行されるURLを開き、決めたパスワードでログインします。
マップを開いて「共有」を押すと、閲覧用・編集用のリンクを作れます。
リンクを渡した相手は、Notionのアカウントもログインも不要です。
