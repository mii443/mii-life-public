# mii-life-public

GitHub Projects の `Start date` / `Target date` を毎日巡回し、翌日の日付が設定された open Issue を Discord に通知します。通知先では `MENTION_USER_ID` のユーザーをメンションします。

## 動作

- 毎日 00:15 JST（15:15 UTC）に実行
- このリポジトリの open Issue のうち、archived ではない GitHub Projects アイテムを巡回
- closed Project は除外
- `Start date` または `Target date` が翌日なら Discord にまとめて通知
- 同じ Issue が複数 Project で該当しても、1回の実行では Issue 単位にまとめる
- 該当 Issue がなければ Discord には何も送信しない

## セットアップ

1. リポジトリの `Settings` → `Environments` で `Reminder` Environment を開きます。
2. `Reminder` の Environment secrets に次を登録します。

   | Secret | 値 |
   | --- | --- |
   | `DISCORD_WEBHOOK_URL` | Discord チャンネルの Webhook URL |
   | `MENTION_USER_ID` | メンションする Discord ユーザーの数値 ID |
   | `PROJECTS_TOKEN` | GitHub Projects を読めるトークン |

3. 対象 Issue を GitHub Projects (v2) に追加し、Date 型の `Start date` / `Target date` を設定します。
4. `Actions` → `Issue date reminder` → `Run workflow` から、まず `dry_run: true` で通知内容を確認します。

通常の `GITHUB_TOKEN` は GitHub Projects にアクセスできないため、`PROJECTS_TOKEN` が必要です。ユーザー所有 Project の場合は、`read:project` scope を付けた classic PAT を利用できます。トークンの所有者自身が対象 Project とこのリポジトリを読める必要があります。private リポジトリにも使う場合は、リポジトリを読む権限も付与してください。

Environment 名を変える場合は、Repository variable `REMINDER_ENVIRONMENT` にその名前を設定します。この変数だけは Environment variable ではなく Repository variable として設定してください。

## 任意設定

Repository variables で次を変更できます。

| Variable | 既定値 | 説明 |
| --- | --- | --- |
| `REMINDER_ENVIRONMENT` | `Reminder` | Environment secrets を読む Environment 名 |
| `REMINDER_TIME_ZONE` | `Asia/Tokyo` | 翌日判定に使う IANA time zone |
| `START_DATE_FIELD` | `Start date` | 開始日の Project field 名 |
| `TARGET_DATE_FIELD` | `Target date` | 目標日の Project field 名 |
| `PROJECT_URL` | 空欄 | 指定時は完全一致する1つの Project URL だけを対象にする |

`PROJECT_URL` が空欄の場合、Issue が所属するすべての open Project を対象にします。

GitHub の scheduled workflow は指定時刻どおりの開始を保証するものではなく、混雑時には遅れることがあります。また、public リポジトリでは長期間リポジトリ活動がないと scheduled workflow が自動で無効化される場合があります。

## 手動テスト

`workflow_dispatch` の `today` に基準日を指定できます。たとえば `2026-08-25` を指定すると `2026-08-26` の日付を持つ Issue を抽出します。手動実行時の `dry_run` は既定で `true` であり、Discord へは送信せず Actions のログに通知内容を表示します。

ローカルの単体テストは次で実行できます。

```sh
node --test .github/scripts/issue-date-reminder.test.mjs
```
