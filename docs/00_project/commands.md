# よく使うコマンド

目的: 開発で繰り返し使うコマンドをまとめる。コマンドを追加・変更したら、実際に動くことを確認してから更新する。以下は、すべて実行して動作を確認したもの（2026-10-10、Node.js v25.9.0 / pnpm 12.8.2 / Windows）。構成の詳細は [dev_spec.md](../10_design/functions/dev_spec.md)。

## 前提

- Node.js 24 以上（`engines: >=24`）、pnpm（`packageManager: pnpm@12.8.2`）。pnpm は `npm install -g pnpm` で導入できる
- pnpm のスクリプトの中から、さらに `pnpm` を呼び出す書き方は、この環境では解決に失敗したため、使わない（スクリプトは、`vitest`・`playwright`・`vite` などを直接呼ぶ）
- Windows では、カレントディレクトリのドライブ文字の大文字・小文字が、モジュールの読み込みとカバレッジの計測に影響する。Git Bash から `node node_modules/vitest/vitest.mjs` を直接呼ぶ（`c:` の小文字になる）と、同じファイルが二重に読み込まれ、カバレッジが 0% になることがある。テストは、`pnpm`（`pnpm test:unit`・`pnpm exec vitest ...`）経由で実行する
- E2E は、ポート 5173（Vite）・8787（バックエンド）を使う。空いていること（別の E2E・開発サーバーが動いていないこと）を確認してから実行する。全 E2E の所要時間は、約 45 分

```bash
# セットアップ（依存パッケージのインストール）
pnpm install

# Playwright のブラウザ（chromium）のインストール（E2E テストの前に1回）
pnpm exec playwright install chromium

# 開発サーバ起動
pnpm dev:backend     # バックエンド（Node サーバー。http://127.0.0.1:8787）。.env があれば読み込む
pnpm dev:frontend    # フロントエンド（Vite。http://127.0.0.1:5173。/api/v1 をバックエンドへ中継）

# ビルド
pnpm build           # フロントエンドを dist/frontend へ出力

# テスト（全体）: 単体・結合（カバレッジつき）→ E2E。出力は ./test-result/
pnpm test

# テスト（単一ファイル）
pnpm exec vitest run tests/unit/shared/shared.test.ts
pnpm exec playwright test tests/e2e/UC-06-record-recovery.ts            # E2E（ユースケースごと）
pnpm exec playwright test tests/e2e/UC-12-manage-equipment.ts -g "運用の一連"   # E2E（テスト名で絞り込み）
pnpm exec playwright test tests/e2e/scenario-outage-recovery.ts           # E2E（複数のユースケース・利用者をまたぐシナリオ）

# テスト（単体・結合のみ / E2E のみ）
pnpm test:unit
pnpm test:e2e

# データファイル（PERSISTENCE=file）のバックアップ・復元（手順は docs/40_operations/backup-restore.md）
pnpm data:backup backup [--keep N]
pnpm data:backup list
pnpm data:backup restore store-<日時>.json

# Lint / 型検査 / フォーマット
pnpm lint            # ESLint（eslint .）→ oxlint（jsx-a11y。.oxlintrc.json）
pnpm typecheck
pnpm format          # 整形して書き込む
pnpm format:check    # 整形の確認のみ
```

## 実行結果（2026-10-12。最終テスト（手順11）の対応後）

| コマンド | 結果 |
|----------|------|
| `pnpm lint` / `pnpm typecheck` | 成功。`pnpm format:check` は、未追跡の `.vscode/settings.json` の1ファイルだけが警告（このファイルは、本作業で作成したものではなく、触っていない） |
| `pnpm test:unit`（単体・結合） | 53 ファイル・1513 件（成功 1511・スキップ 2。スキップは、Windows では実行しないファイル権限のテスト）。約68秒。カバレッジ: 行 99.39%・分岐 96.03%・関数 99.79%・文 99.41%（基準は、すべて 95% 以上） |
| `pnpm test`（単体・結合 → E2E の通し） | 成功（終了コード 0）。約46分 |
| `pnpm test:e2e`（E2E） | 764 件（UC-01〜UC-24 の 754 件と、`scenario-*.ts` の 10 件）、すべて成功（約45分）。スクリーンショットの撮影のたびに、画面の機械検査（はみ出し・重なり・表の列の潰れ・ページ下の余計な空白）を実行 |
| `pnpm test:stress`（負荷テスト） | 4 件（単独利用・同時接続・取り込みの大量実行・モバイル幅の表示）成功。443 操作すべてが許容時間内（NG 0）。約2分。結果は `test-result/stresstest.result.log` |

## ローカルでの動かし方

- `.env.example` を `.env` にコピーして使う（値はダミー。`.env` は Git 管理外）。`SEED_MODE=DEMO` で、デモの設備・合成データ・評価が入る。ログインは、`.env` の `INITIAL_USER_ID`・`INITIAL_USER_PASSWORD`
- バックエンドとフロントエンドを、それぞれ別のターミナルで起動し、`http://127.0.0.1:5173` を開く
- 初期ユーザーでのログイン手順は、次節
- ファイルサーバーのモックに、合成データのファイル（`tests/fixtures/file-server/` を参考）を、`.local-data/file-server/robot/` や `.local-data/file-server/environment-sensor/` に置くと、取り込みの対象になる
- 開発用 API（時計・モックの停止・ジョブの起動・リセット）は、既定で無効。`.env` に `DEV_API_ENABLED=true` を指定したときだけ有効（E2E の設定は、指定済み）。dev_spec.md 3.8

### 初期ユーザーでのログイン手順（ローカル）

1. `.env.example` を `.env` にコピーする（`.env` は Git 管理外。ダミー値のままでも動く）。`.env` に、`INITIAL_USER_ID`・`INITIAL_USER_NAME`・`INITIAL_USER_PASSWORD` の3つがそろっていること（`.env.example` のダミー値は、ユーザーID `local-user`、パスワード `Dummy-Passw0rd-local`）。パスワードは、8文字以上で英大文字・英小文字・数字を含むこと（満たさないと、バックエンドが起動しない）
2. `pnpm dev:backend` と `pnpm dev:frontend` を、別のターミナルで起動する（バックエンドは、起動時に、ユーザーが1人もいなければ、初期ユーザーを作る。ログに「最初のユーザーを作成しました」と出る）
3. ブラウザで `http://127.0.0.1:5173` を開く（未ログインなら、ログイン画面へ移る）。ユーザーIDとパスワードを入力して「ログイン」を押すと、ダッシュボードへ移る。利用を終えたら、ヘッダーの「ログアウト」を押す
4. 失敗が同じ接続元から15分で5回続くと、しばらくログインできない（15分後に解ける。バックエンドを再起動しても解ける。接続元は、`TRUSTED_PROXY_HOPS`（既定 0）に従う。dev_spec.md 4章 No.3・33）

注意:

- 初期ユーザーは、ユーザーが1人もいないときだけ作られる。`PERSISTENCE=file`（`.env.example` の既定）では、`.local-data/store.json` にユーザーが保存されるため、2回目以降の起動で `.env` のユーザーIDやパスワードを変えても、反映されない（変えるときは、ログイン後に、ユーザー管理（SC-14）で、パスワードを再設定する。または、`.local-data/store.json` を削除して、作り直す）
- `INITIAL_USER_*` を指定しないと、ユーザーが作られず、ログインできない
- 初期ユーザーのロールは、既定の1ロール `worker`（全権限）。`ROLE_DEFINITIONS_JSON`・`INITIAL_USER_ROLE` で変えられる（dev_spec.md 3.3）
- パスワードは、ハッシュ化（scrypt）して保存し、ログに出さない（security.md）。実際の運用では、`.env.example` のダミー値を使わず、別の値にする

## テストの出力

| 出力 | 場所 |
|------|------|
| カバレッジ（HTML・lcov・サマリ） | `./test-result/coverage/`（`index.html`） |
| E2E の動画・スクリーンショット・トレース | `./test-result/e2e/` |
| E2E の HTML レポート | `./test-result/playwright-report/` |

`./test-result/` は Git 管理外（負荷テストのログ・レポートと、テスト仕様書 `test.spec.md` を除く）。

## 負荷テスト

```bash
pnpm test:stress     # 大量データの状態で、全ユースケースの操作の応答時間を計測する（単独利用・同時接続・取り込みの大量実行）と、375px・768px 幅の表示の確認。約2分
```

- バックエンド（起動時に、約63万件の観測値などの合成データを投入）と、フロントエンド（本番ビルドを `vite preview` で配信）を起動して実行する。ポートは E2E と同じ（5173・8787）のため、`pnpm test:e2e` と同時に実行しない
- 許容時間は `tests/stress/support/limits.ts`（NFR-3.x）。超えた操作があると、テストは失敗する
- 許容時間の倍率: 環境変数 `STRESS_LIMIT_FACTOR`（1 以上 3 以下。既定 1 = NFR の値のまま。範囲外・数値でない値はエラー）。実行環境の速さが揺れるとき（CI）のために設けた。例: `STRESS_LIMIT_FACTOR=1.5 pnpm test:stress`（操作は 3 秒 → 4.5 秒）。倍率は、結果ログに記録される。**手元の実行・NFR の確認は、既定の 1 で行う**
- 出力: `./test-result/stresstest.result.log`（操作ごとの応答時間・次の操作が可能になるまでの時間・判定、集計。Git 管理）、`./test-result/stress/`（スクリーンショット・HTML レポート。Git 管理外）。報告は `./test-result/stresstest.report.md`
- 構成の詳細は dev_spec.md 6.5

## CI（GitHub Actions）

`.github/workflows/ci.yml`。PR ごとに、次のコマンドを実行する（手元で同じコマンドを実行して、事前に確認できる）。マージ先ごとの必須のチェックは [git-workflow.md](../40_operations/git-workflow.md)「PRの作り方」を参照する。

| ジョブ | 実行するコマンド | 実行する PR |
|--------|------------------|-------------|
| `lint` | `pnpm lint`・`pnpm format:check` | `develop`・`main` 宛て |
| `typecheck` | `pnpm typecheck` | 同上 |
| `unit-test` | `pnpm test:unit` | 同上 |
| `build` | `pnpm build` | 同上 |
| `e2e` | `pnpm test:e2e` | `main` 宛て、またはラベル `ci:full` |
| `stress` | `pnpm test:stress` | 同上 |

- 実行環境は、ubuntu-latest・Node.js 24・`packageManager` に指定した pnpm。E2E・負荷テストは、`pnpm exec playwright install --with-deps chromium` でブラウザを入れてから実行する
- 手元（Windows）では実行しないファイル権限のテスト（2 件）は、CI（Linux）で実行される
- CI の `stress` ジョブは、`STRESS_LIMIT_FACTOR=1.5`（許容時間を 1.5 倍）で実行する。GitHub のランナーは、CPU の速さが実行のたびに違い、同時 10 人の保存（UC-06）が、許容 3 秒付近（約 2〜3.5 秒）で、超えたり超えなかったりしたため（PR #58）。NFR の値そのものは、変えていない
- 画面のレイアウトの検査（E2E・負荷テスト）は、フォントに依存するため、`e2e`・`stress` のジョブで、日本語のフォント（`fonts-noto-cjk`）を入れる
- 失敗したときの E2E の動画・レポートと、負荷テストの結果ログは、Actions の成果物（Artifacts）から取得できる

## 環境変数

必要な環境変数は、リポジトリ直下の `.env.example` に変数名とダミー値を記載する。実際の値は `.env` に記載し、Git管理には含めない（詳細は [security.md](../20_development/security.md)を参照）。各変数の意味は dev_spec.md 3.3。

## 外部サービス

開発・テストに、外部サービスは不要（ファイルサーバー・農業情報基盤・Web Push は、ローカルのモック。dev_spec.md 3.5）。本番の接続先は未確定（Q-002、Q-005）。
