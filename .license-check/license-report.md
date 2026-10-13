# 依存パッケージのライセンス確認レポート

- 対象: 収穫ロボット・スマートハウス向け稼働モニタリング基盤（`smart-farm-monitoring`。ブランチ `feature/app-foundation`）
- 確認日: 2026-10-11
- 依頼: コピーレフトのライセンス（GPL など）の製品が、このソフトウェアに含まれないことを確認する。含まれる場合は、削除・代替の投入・再確認・テストを、含まれなくなり、テストが通るまで繰り返す
- 結論: **強いコピーレフト（GPL・AGPL・LGPL など）の npm 依存は、確認の時点で 1 件もなかった。弱いコピーレフトの MPL-2.0 が 13 件（axe-core 1 件、lightningcss 12 件）あったため、代替を投入して、すべて取り除いた。** 再確認の結果、320 件の依存に、コピーレフトはない。判断待ちの事項は、「8. 判断待ちの事項」に挙げる
- 作成: 本レポートの本文は、ライセンスチェックを担当したサブエージェントの報告を、メインエージェントが転記した。付録は、サブエージェントが生成した一覧（スクリプト出力）を連結した

## 1. 調査の方法と日付

実施日は 2026-10-11。環境は、Node.js v25.9.0・pnpm 12.8.2・Windows 11。

| 手順 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `pnpm licenses list --json`（インストール済みの依存のライセンス）を取得した。ただし、この出力は、ルートの依存の木のみを対象とし、`src/backend`・`src/frontend` だけが持つ依存（`@hono/aws-lambda`・`@hono/node-server`・`@vitejs/plugin-react`）が漏れるため、次の手順で補った                                                                                                                                                                                                                                                                                  |
| 2    | `pnpm-lock.yaml`（プロジェクトの部分。`packages:` と `snapshots:`）を解析し、全パッケージ（推移的な依存を含む）と、依存の経路を取得した。`node_modules/.pnpm/*/node_modules/*/package.json` の `license`・`licenses` フィールドを読んで、ライセンスを取得した                                                                                                                                                                                                                                                                                                   |
| 3    | この環境（Windows）にインストールされない、他の OS・CPU 向けのバイナリ（`optionalDependencies`。`@rolldown/binding-*`・`@esbuild/*`・`@oxlint/binding-*`・`lightningcss-*`・`fsevents`。58 件）は、npm レジストリ（`registry.npmjs.org`）の、版ごとのメタ情報の `license` を読んだ                                                                                                                                                                                                                                                                              |
| 4    | ライセンスが空・`UNKNOWN`・`SEE LICENSE IN`、または `OR` / `AND` を含む式のものを探した（**該当なし**。全 320 件が、単一のライセンス識別子を持つ）                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5    | インストール済みの 262 件のパッケージのディレクトリにある `LICENSE`・`COPYING`・`NOTICE` 類のファイルを、キーワード（GNU・GPL・LGPL・AGPL・Mozilla Public・Eclipse Public・CDDL・EUPL・SSPL・ShareAlike・NonCommercial・Creative Commons・Python Software Foundation など）で検索した。ヒットした `argparse`（Python-2.0）・`caniuse-lite`（CC-BY-4.0）・`mdn-data`（CC0-1.0）の LICENSE は、全文を読んだ。LICENSE ファイルを持たない 10 件は、`package.json` の `license` を採用した（プラットフォーム別のバイナリ 3 件のほか、7 件。名前は付録 D に含まれる） |
| 6    | 依存の経路は、`pnpm why axe-core lightningcss argparse caniuse-lite` で確認した（事実に基づいて、代替を判断するため）                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7    | 配布物（`dist/frontend`）に含まれる依存は、`vite build src/frontend --sourcemap` で、ソースマップの `sources` を調べて確認した（含まれる npm パッケージは、`react`・`react-dom`・`scheduler`・`zod` の 4 件のみ）                                                                                                                                                                                                                                                                                                                                               |
| 8    | 変更の前後で、同じ手順を実施した。変更後は、`pnpm audit` も実行した                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

- 調査の対象は、`package.json`（ルート・`src/shared`・`src/backend`・`src/frontend`）から、`pnpm-lock.yaml` で固定されたすべての依存（推移的な依存を含む）。ワークスペースの自作パッケージ（`@smart-farm/shared`・`@smart-farm/backend`・`@smart-farm/frontend`。`private: true`）は、自作のコードであり、対象外
- パッケージマネージャ自身（`pnpm@12.8.2` と、`@pnpm/exe.*` の 14 件。ロックファイルの先頭の、`packageManager` 用の部分）は、アプリの依存ではない。全 15 件の `license` は `MIT`
- npm のパッケージではないもの（Playwright が取得するブラウザ・ffmpeg など）は、「3.4」に別に記載する
- 限界: ネイティブのバイナリ（rolldown・esbuild・oxlint など）が、内部に取り込んでいる別のライブラリ（Rust・Go のクレート・モジュール）のライセンスは、npm のメタ情報からは確認できない。これらは、開発・ビルドのみに使い、配布物には含まれない

## 2. 判定の基準

| 区分                           | ライセンス                                                                                                                         | 扱い                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 強いコピーレフト               | GPL・AGPL・LGPL・SSPL・EUPL・CC-BY-SA・CC-BY-NC など                                                                               | **不可**。見つかった場合は、削除し、代替を投入する                                                                                                                                                                                                                                                                                                                                 |
| 弱いコピーレフト               | MPL-2.0・EPL・CDDL                                                                                                                 | ファイル単位のコピーレフトで、改変せずに利用する限り、派生物へは及ばない。(1) 配布物（dist）に含まれるか、(2) 改変して使っているか、を確認する。ただし、ユーザーの依頼は「コピーレフトのライセンスの製品を含まない」ことであり、**代替が現実的に可能なら、代替を実施する**。代替が現実的でない・品質を大きく損なう場合は、勝手に妥協せず、理由・影響・リスクを整理して、判断を仰ぐ |
| 許容的（コピーレフトではない） | MIT・MIT-0・Apache-2.0・BSD-2/3-Clause・ISC・0BSD・BlueOak-1.0.0・CC0-1.0・Python-2.0（PSF 系）・CC-BY-4.0（表示義務のみ。データ） | 可。表示義務（著作権表示・ライセンス文の保持）のみ                                                                                                                                                                                                                                                                                                                                 |

依存の区分は、次の 3 つに分ける。

| 区分                    | 意味                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| 配布物（dist/frontend） | フロントエンドのビルド成果物（利用者のブラウザへ配信されるもの）に、コードが含まれる  |
| バックエンド実行時      | サーバー（Node サーバー・Lambda）の実行時に読み込まれる。配布物ではないが、本番で動く |
| 開発のみ                | 開発・ビルド・テスト・Lint・型検査のみに使い、配布物にも本番の実行にも含まれない      |

## 3. 全依存の件数とライセンス別の内訳

### 3.1 変更前と変更後

| 時点   | 依存の件数（`pnpm-lock.yaml` の `packages`）             | 強いコピーレフト | 弱いコピーレフト（MPL-2.0）              |
| ------ | -------------------------------------------------------- | ---------------- | ---------------------------------------- |
| 変更前 | 394 件                                                   | 0 件             | **13 件**（axe-core 1、lightningcss 12） |
| 変更後 | 320 件（別名のパッケージ 309。同名で版が違うものを含む） | 0 件             | 0 件                                     |

変更後の 320 件のうち、262 件がこの環境にインストールされ、58 件は他の OS・CPU 向けのバイナリ（この環境ではインストールされない）。

### 3.2 変更後のライセンス別の件数（区分ごと）

| ライセンス    | 計      | 配布物のみ                       | 配布物＋バックエンド | バックエンドのみ                               | 開発のみ | 種別                           |
| ------------- | ------- | -------------------------------- | -------------------- | ---------------------------------------------- | -------- | ------------------------------ |
| MIT           | 265     | 3（react・react-dom・scheduler） | 1（zod）             | 3（hono・@hono/node-server・@hono/aws-lambda） | 258      | 許容的                         |
| Apache-2.0    | 21      | 0                                | 0                    | 0                                              | 21       | 許容的                         |
| ISC           | 13      | 0                                | 0                    | 0                                              | 13       | 許容的                         |
| BSD-2-Clause  | 8       | 0                                | 0                    | 0                                              | 8        | 許容的                         |
| BSD-3-Clause  | 6       | 0                                | 0                    | 0                                              | 6        | 許容的                         |
| MIT-0         | 2       | 0                                | 0                    | 0                                              | 2        | 許容的                         |
| BlueOak-1.0.0 | 2       | 0                                | 0                    | 0                                              | 2        | 許容的                         |
| CC0-1.0       | 1       | 0                                | 0                    | 0                                              | 1        | 許容的（パブリックドメイン）   |
| Python-2.0    | 1       | 0                                | 0                    | 0                                              | 1        | 許容的（PSF 系）               |
| CC-BY-4.0     | 1       | 0                                | 0                    | 0                                              | 1        | 許容的（表示義務のみ。データ） |
| **計**        | **320** | **3**                            | **1**                | **3**                                          | **313**  |                                |

### 3.3 配布物・バックエンドに含まれる依存

| パッケージ        | 版      | ライセンス | 区分                       |
| ----------------- | ------- | ---------- | -------------------------- |
| react             | 19.3.0  | MIT        | 配布物                     |
| react-dom         | 19.3.0  | MIT        | 配布物                     |
| scheduler         | 0.28.0  | MIT        | 配布物                     |
| zod               | 4.6.5   | MIT        | 配布物＋バックエンド実行時 |
| hono              | 4.13.13 | MIT        | バックエンド実行時         |
| @hono/node-server | 2.1.4   | MIT        | バックエンド実行時         |
| @hono/aws-lambda  | 1.0.1   | MIT        | バックエンド実行時         |

`dist/frontend` には、このほかに、自作のコード（`src/frontend`・`src/shared`）と、自作のサービスワーカー（`public/sw.js`）・マニフェストのみが含まれる。**配布物・本番の実行に含まれる依存は、すべて MIT で、コピーレフトはない**（変更の前後で同じ）。

### 3.4 npm の依存ではない、テスト時のみの外部ツール

| ツール                                                                                                                                                           | ライセンス                                                                                                                                          | 区分                                                                     | 扱い                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium（Playwright が `playwright install chromium` で取得する、テスト用のブラウザ。`playwright.config.ts` の `projects` は `Desktop Chrome`（Chromium）のみ） | BSD-3-Clause を主とし、多数の第三者のコンポーネントを含む（ブラウザの性質上、LGPL・MPL などのコンポーネントも含まれ得る。個別の確認は、していない） | テスト実行時のみ。配布物にもサーバーにも含まれない                       | 対応不要。**配布物に含まれないことを確認した**（`dist/frontend` のソースマップに含まれる npm パッケージは 4 件のみ。ブラウザのファイルは `%LOCALAPPDATA%\ms-playwright` にあり、リポジトリ外） |
| **ffmpeg**（Playwright が動画の撮影のために取得する実行ファイル `ffmpeg-win64.exe`。`video: { mode: 'on' }` で使う）                                             | **LGPL-2.1**（取得したディレクトリに `COPYING.LGPLv2.1` がある）                                                                                    | テスト実行時のみ。別プロセスの実行ファイル。製品にリンクも同梱もされない | **コピーレフト（LGPL）だが、製品に含まれない開発用ツール**。判断を仰ぐ（「8」）                                                                                                                |
| Firefox・WebKit（`ms-playwright` に存在するが、使っていない）                                                                                                    | -                                                                                                                                                   | 使っていない                                                             | 対象外                                                                                                                                                                                         |

## 4. コピーレフトの検出結果と対応

### 4.1 検出したもの（変更前）

強いコピーレフトは、なかった。弱いコピーレフト（MPL-2.0）が、次の 13 件あった（全件は付録 C）。いずれも、**開発のみ・配布物に含まれない・改変していない**。

| パッケージ                                                                                                                                                                                                                                 | 版     | ライセンス | 依存の経路                                                                                     | 区分               | 配布物に含まれるか                                        | 対応                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------- | ---------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| axe-core                                                                                                                                                                                                                                   | 4.14.0 | MPL-2.0    | `eslint-plugin-jsx-a11y` → `axe-core`（`autocomplete-valid` ルールが `runVirtualRule` を使う） | 開発のみ（Lint）   | 含まれない                                                | **削除し、代替（oxlint）を投入**                      |
| lightningcss                                                                                                                                                                                                                               | 1.33.0 | MPL-2.0    | `vite@8.3.3` → `lightningcss`（Vite 8 が必須の依存として宣言。CSS の最小化の既定）             | 開発のみ（ビルド） | 含まれない（ビルドの道具。出力の CSS にコードは入らない） | **削除し、代替（esbuild による CSS の最小化）を投入** |
| lightningcss-\* の 11 件（`-android-arm64`・`-darwin-arm64`・`-darwin-x64`・`-freebsd-x64`・`-linux-arm-gnueabihf`・`-linux-arm64-gnu`・`-linux-arm64-musl`・`-linux-x64-gnu`・`-linux-x64-musl`・`-win32-arm64-msvc`・`-win32-x64-msvc`） | 1.33.0 | MPL-2.0    | lightningcss のプラットフォーム別バイナリ（`optionalDependencies`）                            | 開発のみ           | 含まれない                                                | lightningcss とともに削除                             |

- MPL-2.0 はファイル単位のコピーレフトで、改変せずに使うだけなら、製品のコードへは及ばない。そのため、変更前の状態でも、製品の配布に実害のあるライセンス上の問題はなかったと考える。ただし、依頼に従い、代替が現実的に可能なため、代替を実施した
- `Python-2.0`（argparse）・`CC-BY-4.0`（caniuse-lite）は、次の理由で、コピーレフトではないと判断した

| パッケージ                             | ライセンス | 判断の根拠（1 行）                                                                                                                                                                                                                 |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| argparse 2.0.1                         | Python-2.0 | PSF License 系で、著作権表示・ライセンス文・免責の保持のみを求める許容的なライセンス。派生物へのソース公開義務はない（LICENSE の全文を確認）。開発のみ（js-yaml 経由で ESLint が使う）                                             |
| caniuse-lite 1.0.30001815              | CC-BY-4.0  | ブラウザの対応表のデータ。CC-BY は表示（帰属）義務のみで、ShareAlike（SA）の条件を持たず、コピーレフトではない（LICENSE の全文を確認）。開発のみ（browserslist 経由で、react-hooks プラグインの Babel が使う）。配布物に含まれない |
| language-subtag-registry（変更前のみ） | CC0-1.0    | パブリックドメインへの献呈（今回の変更で削除された）                                                                                                                                                                               |

### 4.2 代替の検討と採用

**axe-core（eslint-plugin-jsx-a11y）**

- 事実: `eslint-plugin-jsx-a11y@6.10.2` が `axe-core` を必須の依存として宣言し、ルール `autocomplete-valid` のファイルの先頭で `require("axe-core")` する（ほかのルールは使わない）。axe-core だけを取り除くと、プラグインの読み込みに失敗する。このプロジェクトで `autoComplete` を使うのは、`manual-entry-form.tsx` の `autoComplete="off"` の 1 か所のみ
- 検討した代替（レジストリで確認）: `eslint-plugin-jsx-a11y-x`（0.2.0）・`@htmlacademy/eslint-plugin-jsx-a11y`（6.11.0）・`jsx-a11y-unstable`（7.0.4）は、いずれも `axe-core` に依存しており、代替にならない。axe-core を自作のスタブに置き換える案（`overrides`）、プラグインにパッチを当てる案（`pnpm patch`）は、他人の依存の挙動を書き換える回避策になるため、採らなかった
- **採用: `oxlint`（MIT）の `jsx-a11y` プラグインを使い、`eslint-plugin-jsx-a11y` を削除した**
  - `oxlint` は、同じルール名・同じオプションを持つ。推奨設定（recommended）の有効な 31 ルールを、オプションも含めて `.oxlintrc.json` に移した
  - 検査の範囲は、これまでと同じ（`src/frontend` の `.tsx`）。`pnpm lint` は、`eslint .` に続けて `oxlint -c .oxlintrc.json src/frontend` を実行する
  - 同等性の確認: (a) 現在のコードで違反 0 件（これまでの ESLint と同じ）、(b) 故意に違反を書いた確認用のファイルで、`alt-text`・`click-events-have-key-events`・`no-static-element-interactions`・`no-autofocus`・`autocomplete-valid`・`anchor-is-valid`・`label-has-associated-control` の 7 件を検出し、終了コード 1 になる、(c) `oxlint-disable-next-line` による例外の指定が効く
  - `src/frontend/components/form-controls.tsx` の `eslint-disable-next-line jsx-a11y/no-autofocus` を、`oxlint-disable-next-line jsx-a11y/no-autofocus` に変えた（ESLint が未使用の指示として報告するのを避けるため。理由の文は、そのまま）
  - 版は `~1.84.0`（公開から 20 日が経過した版。1.x はマイナーバージョンでルールが変わり得るため、パッチのみ許す指定にした）。pnpm の供給網の保護の範囲内（インストール時に `Lockfile passes supply-chain policies` を確認）

**lightningcss（Vite 8）**

- 事実: `vite@8.3.3` は `lightningcss` を必須の依存（`dependencies`）として宣言する。使われるのは、(a) CSS の最小化（`build.cssMinify` の既定が実質 lightningcss）と、(b) `css.transformer: 'lightningcss'` を指定したときのみ。このプロジェクトは (b) を使っていない（既定の PostCSS）。CSS の最小化を別の方法にすれば、lightningcss は実行時に読み込まれない
- 検討: (1) `build.cssMinify: false`（追加なし。CSS が最小化されなくなる）、(2) **`build.cssMinify: 'esbuild'`（MIT の esbuild を追加。最小化を維持できる）**。後者を採用した
- **採用**:
  - `src/frontend/vite.config.ts` に `build.cssMinify: 'esbuild'` を追加した
  - `esbuild`（`^0.28.0`。MIT。Vite 8.3 の peer の範囲 `^0.27.0 || ^0.28.0` に合う）を、ルートと `src/frontend` の `devDependencies` に追加した（`vite` を持つ 2 か所に置き、どちらの Vite からも peer が解決されるようにした）
  - `pnpm-workspace.yaml` に `overrides: { lightningcss: '-' }` を追加し、lightningcss とそのプラットフォーム別バイナリをインストールしないようにした
  - `esbuild` のインストール時スクリプト（`postinstall`）は、`allowBuilds: { esbuild: false }` で実行しない設定にした（pnpm 12 は、未承認のスクリプトがあるとインストールを失敗させる。esbuild はプラットフォーム別パッケージ `@esbuild/*` だけで動く。スクリプトの実行を許可するかは別の判断なので、拒否の側に倒した）
  - 出力の確認: `pnpm build` が成功した。CSS は 21.49 kB → 21.58 kB（gzip 4.60 kB → 4.49 kB）。整形して比較すると、違いは宣言の並び順・色の表記（`#fff` → `#ffffff`）・メディアクエリの表記（`(width<=720px)` → `(max-width: 720px)`）・SVG の `stroke-width` の単位（`1px` → `1`）などの表記のみで、規則の中身は同じ。変更前後のビルド成果物を `vite preview` で配信して撮影したログイン画面も同一だった（「7.3」）

### 4.3 残したもの

- コピーレフトで、代替が現実的でなく残した npm の依存は**ない**
- コピーレフトで、製品に含まれないため残しているものは、「3.4」の Playwright の ffmpeg（LGPL-2.1）のみ（判断待ち）

## 5. 変更内容

以降のファイルは Git で未追跡のため `git diff` は使えない。変更前のファイルを退避して比較した。

### 5.1 パッケージ・設定

| ファイル                                    | 変更                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`（ルート）                    | `devDependencies`: `eslint-plugin-jsx-a11y`（`^6.10.2`）を削除。`esbuild`（`^0.28.0`）・`oxlint`（`~1.84.0`）を追加。`scripts.lint`: `eslint .` → `eslint . && oxlint -c .oxlintrc.json src/frontend` |
| `src/frontend/package.json`                 | `devDependencies`: `esbuild`（`^0.28.0`）を追加                                                                                                                                                       |
| `pnpm-workspace.yaml`                       | `overrides: { lightningcss: '-' }` と `allowBuilds: { esbuild: false }` を追加（理由のコメントつき）                                                                                                  |
| `pnpm-lock.yaml`                            | `pnpm install` で更新。394 件 → 320 件（追加 47 件、削除 121 件。`overrides` の記録を含む）                                                                                                           |
| `src/frontend/vite.config.ts`               | `build.cssMinify: 'esbuild'` を追加                                                                                                                                                                   |
| `eslint.config.js`                          | `eslint-plugin-jsx-a11y` の import と `.tsx` への適用を削除。理由のコメントを追加                                                                                                                     |
| `.oxlintrc.json`（新規）                    | `jsx-a11y` プラグインの、推奨設定と同じ 31 ルール（オプションつき）                                                                                                                                   |
| `src/frontend/components/form-controls.tsx` | 例外の指示のコメントを `oxlint-disable-next-line` に変更（1 行）                                                                                                                                      |

CI・認証・インフラの設定は変更していない（`.github/workflows` は空）。

追加した依存（47 件）: `esbuild` 0.28.2 と `@esbuild/*` 25 件、`oxlint` 1.84.0 と `@oxlint/binding-*` 19 件（版は固定。ライセンスはすべて MIT）。削除した依存（121 件）: `eslint-plugin-jsx-a11y` とその依存の木（`axe-core`・`aria-query`・`axobject-query`・`jsx-ast-utils`・`language-tags`・`language-subtag-registry`・`damerau-levenshtein`・`emoji-regex@9`・`ast-types-flow` ほか）、`lightningcss` とプラットフォーム別バイナリ 11 件。

### 5.2 ドキュメント

| ファイル                                      | 変更                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/10_design/functions/dev_spec.md`        | 1.1（構成に `.oxlintrc.json`・`.license-check/`）、1.3（pnpm の `overrides`・`allowBuilds`、ESLint の記述、oxlint、Vite の CSS の最小化）、1.4（oxlint）、1.5（`pnpm lint`） |
| `docs/10_design/architecture/as-built.md`     | 「設計との差分」に D-20 を追加。「技術スタックの実際の版」に oxlint・esbuild を追加。jsx-a11y の記述を更新                                                                   |
| `docs/10_design/architecture/architecture.md` | **変更していない**（13.1 の Formatter / Linter は「Prettier、ESLint」のまま。更新するかは判断待ち）                                                                          |
| `docs/20_development/coding-standards.md`     | Linter の記述（oxlint）、設定ファイルの場所、依存の追加時にコピーレフトを避ける旨                                                                                            |
| `docs/00_project/commands.md`                 | `pnpm lint` の説明                                                                                                                                                           |
| `docs/00_project/document-index.md`           | 本レポートを追記                                                                                                                                                             |
| `docs/00_project/directory-structure.md`      | `.license-check/`・`.oxlintrc.json` を追記                                                                                                                                   |

## 6. 再確認の結果

変更後に、調査の手順 1〜5・7 を再実施した。

| 確認                                   | 結果                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 依存の件数                             | 320 件（インストール済み 262、プラットフォーム別の未インストール 58）。すべて単一のライセンス識別子。空・UNKNOWN・SEE LICENSE IN・OR / AND は 0 件                                                                                         |
| ライセンス別                           | MIT 265、Apache-2.0 21、ISC 13、BSD-2-Clause 8、BSD-3-Clause 6、MIT-0 2、BlueOak-1.0.0 2、CC0-1.0 1、Python-2.0 1、CC-BY-4.0 1                                                                                                             |
| 強いコピーレフト                       | **0 件**                                                                                                                                                                                                                                   |
| 弱いコピーレフト（MPL-2.0・EPL・CDDL） | **0 件**（`pnpm-lock.yaml` に `axe-core`・`eslint-plugin-jsx-a11y` は存在しない。`lightningcss` は `overrides` の記録のみ）                                                                                                                |
| LICENSE ファイルの全文検索             | GNU・GPL・LGPL・AGPL・Mozilla Public・Eclipse Public・CDDL・EUPL・SSPL・ShareAlike・NonCommercial のヒットは 0 件（ヒットしたのは Python Software Foundation（argparse）・Creative Commons（caniuse-lite・mdn-data）のみ。いずれも許容的） |
| 配布物（`dist/frontend`）の依存        | react・react-dom・scheduler・zod（すべて MIT）のみ                                                                                                                                                                                         |
| `pnpm audit`                           | `No known vulnerabilities found`                                                                                                                                                                                                           |

## 7. テスト結果

### 7.1 コマンドと結果

| コマンド                               | 結果                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                            | 成功（ESLint と oxlint の両方でエラーなし）                                                                                                     |
| `pnpm typecheck`                       | 成功                                                                                                                                            |
| `pnpm format:check`                    | 失敗は `.vscode/settings.json` の 1 ファイルのみ（このタスクで作成したファイルではなく、触っていない）。`.oxlintrc.json` は Prettier で整形済み |
| `pnpm test`（単体・結合 → E2E の通し） | 終了コード 0                                                                                                                                    |
| 　単体・結合（Vitest）                 | 34 ファイル・1259 件、すべて成功。カバレッジ: 文 99.61%・分岐 96.29%・関数 99.76%・行 99.6%（基準はすべて 95% 以上）                            |
| 　E2E（Playwright）                    | 759 件、すべて成功（41.3 分）                                                                                                                   |
| `pnpm build`                           | 成功                                                                                                                                            |

テストの期待値の書き換え・削除・スキップは行っていない。

### 7.2 E2E のスクリーンショットの目視確認

ダッシュボード（異常・不明が混在）と、満足度の詳細（レーダーチャート）のスクリーンショットを確認した。レイアウト・色・アイコン・文字の崩れはなかった。

### 7.3 最小化した CSS の確認

E2E は Vite の開発サーバーで動くため、CSS の最小化を通らない。そこで、変更前・変更後のビルド成果物を `vite preview` で配信し、ログイン画面を撮影して比較した。2 枚は同一だった。

## 8. 判断待ちの事項

1. **Playwright の ffmpeg（LGPL-2.1）**: `video: { mode: 'on' }` のために取得される、テスト時のみの別プロセスの実行ファイル。製品に同梱・リンクされない。動画撮影をやめれば不要になるが、テストの証跡に影響するため、変更していない。残すか、撮影をやめるかを判断してほしい
2. **architecture.md 13.1 の技術スタック**: oxlint・esbuild の追加を反映するか（今は as-built.md の D-20 にのみ記載）
3. **MIT の表示義務（参考）**: 現在の `dist` の JS には、react などの著作権表示が含まれていない。外部へ配布する場合は、第三者ライセンスの表記の同梱が別途必要
4. **ネイティブバイナリの内部ライセンス（限界）**: rolldown・esbuild・oxlint などが内部に含むライブラリのライセンスは、npm のメタ情報からは確認できない（開発・ビルドのみで、配布物には含まれない）
5. **ESLint 10**: 以前は jsx-a11y が未対応のため採用していなかった。同プラグインを外したので、ほかの依存の対応を確認すれば更新できる可能性がある（未確認）
6. **依存パッケージの変更の承認**: AGENTS.md は、依存パッケージの追加・更新・削除に事前確認を求めている。今回は、手順7の依頼文（コピーレフトのプロダクトの削除、代替手段の投入）が依存の変更を明示的に求めているため、その範囲に限って実施した（追加: esbuild・oxlint、削除: eslint-plugin-jsx-a11y、`pnpm-workspace.yaml` の `overrides`・`allowBuilds`）。範囲が意図と異なる場合は、元に戻す

## 付録 A. MIT・Apache-2.0・ISC・BSD 以外のライセンスの依存（全件）

| パッケージ                               | 版           | ライセンス    | 区分     | 判定の根拠                                                                                                   |
| ---------------------------------------- | ------------ | ------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| lru-cache                                | 11.5.3       | BlueOak-1.0.0 | 開発のみ | 許容的なライセンス（MIT 類似）。コピーレフトではない                                                         |
| minimatch                                | 10.2.6       | BlueOak-1.0.0 | 開発のみ | 許容的なライセンス（MIT 類似）。コピーレフトではない                                                         |
| caniuse-lite                             | 1.0.30001815 | CC-BY-4.0     | 開発のみ | データ（ブラウザの対応表）。表示（帰属）義務のみで、ShareAlike（SA）ではない。LICENSE の全文を確認した       |
| mdn-data                                 | 2.27.1       | CC0-1.0       | 開発のみ | パブリックドメインへの献呈。制約なし                                                                         |
| @csstools/color-helpers                  | 6.1.2        | MIT-0         | 開発のみ | MIT から表示義務を除いたもの。制約なし                                                                       |
| @csstools/css-syntax-patches-for-csstree | 1.1.15       | MIT-0         | 開発のみ | MIT から表示義務を除いたもの。制約なし                                                                       |
| argparse                                 | 2.0.1        | Python-2.0    | 開発のみ | PSF License 系の許容的なライセンス（表示・免責の保持のみ。派生物への公開義務なし）。LICENSE の全文を確認した |

（7 件。いずれもコピーレフトではない。）

## 付録 B. 配布物（dist/frontend）とバックエンド実行時に含まれる依存（全件）

| パッケージ        | 版      | ライセンス | 区分                       |
| ----------------- | ------- | ---------- | -------------------------- |
| @hono/aws-lambda  | 1.0.1   | MIT        | バックエンド実行時         |
| @hono/node-server | 2.1.4   | MIT        | バックエンド実行時         |
| hono              | 4.13.13 | MIT        | バックエンド実行時         |
| react             | 19.3.0  | MIT        | 配布物（dist/frontend）    |
| react-dom         | 19.3.0  | MIT        | 配布物（dist/frontend）    |
| scheduler         | 0.28.0  | MIT        | 配布物（dist/frontend）    |
| zod               | 4.6.5   | MIT        | 配布物＋バックエンド実行時 |

## 付録 C. 検出して除去したコピーレフト（MPL-2.0。全件）

| パッケージ                       | 版     | ライセンス | 経路                                                                       | 区分     | 配布物への混入 |
| -------------------------------- | ------ | ---------- | -------------------------------------------------------------------------- | -------- | -------------- |
| axe-core                         | 4.14.0 | MPL-2.0    | eslint-plugin-jsx-a11y → axe-core                                          | 開発のみ | なし           |
| lightningcss-android-arm64       | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-darwin-arm64        | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-darwin-x64          | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-freebsd-x64         | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-linux-arm-gnueabihf | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-linux-arm64-gnu     | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-linux-arm64-musl    | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-linux-x64-gnu       | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-linux-x64-musl      | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-win32-arm64-msvc    | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss-win32-x64-msvc      | 1.33.0 | MPL-2.0    | vite → lightningcss → プラットフォーム別のバイナリ（optionalDependencies） | 開発のみ | なし           |
| lightningcss                     | 1.33.0 | MPL-2.0    | vite → lightningcss                                                        | 開発のみ | なし           |

## 付録 D. ライセンスごとの全一覧（現在の 320 件。名前@版）

許容的なライセンスの大量の依存も、確認用に、名前と版のみ載せる。「区分」は、配布物・バックエンドの 4 件を除き、すべて開発のみ。

### MIT（265 件）

@asamuzakjp/css-color@7.1.3、@asamuzakjp/dom-selector@9.2.4、@babel/code-frame@7.29.7、@babel/compat-data@7.29.7、@babel/core@7.29.7、@babel/generator@7.29.8、@babel/helper-compilation-targets@7.29.7、@babel/helper-globals@7.29.7、@babel/helper-module-imports@7.29.7、@babel/helper-module-transforms@7.29.7、@babel/helper-string-parser@7.29.7、@babel/helper-validator-identifier@7.29.7、@babel/helper-validator-option@7.29.7、@babel/helpers@7.29.10、@babel/parser@7.29.9、@babel/runtime@7.29.10、@babel/template@7.29.7、@babel/traverse@7.29.10、@babel/types@7.29.8、@bcoe/v8-coverage@1.0.2、@bramus/specificity@2.4.3、@csstools/css-calc@3.4.3、@csstools/css-color-parser@4.2.6、@csstools/css-parser-algorithms@4.0.2、@csstools/css-tokenizer@4.0.2、@esbuild/aix-ppc64@0.28.2、@esbuild/android-arm64@0.28.2、@esbuild/android-arm@0.28.2、@esbuild/android-x64@0.28.2、@esbuild/darwin-arm64@0.28.2、@esbuild/darwin-x64@0.28.2、@esbuild/freebsd-arm64@0.28.2、@esbuild/freebsd-x64@0.28.2、@esbuild/linux-arm64@0.28.2、@esbuild/linux-arm@0.28.2、@esbuild/linux-ia32@0.28.2、@esbuild/linux-loong64@0.28.2、@esbuild/linux-mips64el@0.28.2、@esbuild/linux-ppc64@0.28.2、@esbuild/linux-riscv64@0.28.2、@esbuild/linux-s390x@0.28.2、@esbuild/linux-x64@0.28.2、@esbuild/netbsd-arm64@0.28.2、@esbuild/netbsd-x64@0.28.2、@esbuild/openbsd-arm64@0.28.2、@esbuild/openbsd-x64@0.28.2、@esbuild/openharmony-arm64@0.28.2、@esbuild/sunos-x64@0.28.2、@esbuild/win32-arm64@0.28.2、@esbuild/win32-ia32@0.28.2、@esbuild/win32-x64@0.28.2、@eslint-community/eslint-utils@4.10.1、@eslint-community/regexpp@4.12.2、@eslint/eslintrc@3.3.7、@eslint/js@9.39.5、@exodus/bytes@1.16.0、@hono/aws-lambda@1.0.1、@hono/node-server@2.1.4、@jridgewell/gen-mapping@0.3.13、@jridgewell/remapping@2.3.5、@jridgewell/resolve-uri@3.1.2、@jridgewell/sourcemap-codec@1.6.0、@jridgewell/trace-mapping@0.3.31、@oxc-project/types@0.153.0、@oxlint/binding-android-arm-eabi@1.84.0、@oxlint/binding-android-arm64@1.84.0、@oxlint/binding-darwin-arm64@1.84.0、@oxlint/binding-darwin-x64@1.84.0、@oxlint/binding-freebsd-x64@1.84.0、@oxlint/binding-linux-arm-gnueabihf@1.84.0、@oxlint/binding-linux-arm-musleabihf@1.84.0、@oxlint/binding-linux-arm64-gnu@1.84.0、@oxlint/binding-linux-arm64-musl@1.84.0、@oxlint/binding-linux-ppc64-gnu@1.84.0、@oxlint/binding-linux-riscv64-gnu@1.84.0、@oxlint/binding-linux-riscv64-musl@1.84.0、@oxlint/binding-linux-s390x-gnu@1.84.0、@oxlint/binding-linux-x64-gnu@1.84.0、@oxlint/binding-linux-x64-musl@1.84.0、@oxlint/binding-openharmony-arm64@1.84.0、@oxlint/binding-win32-arm64-msvc@1.84.0、@oxlint/binding-win32-ia32-msvc@1.84.0、@oxlint/binding-win32-x64-msvc@1.84.0、@rolldown/binding-android-arm-eabi@1.2.13、@rolldown/binding-android-arm64@1.2.13、@rolldown/binding-darwin-arm64@1.2.13、@rolldown/binding-darwin-x64@1.2.13、@rolldown/binding-freebsd-x64@1.2.13、@rolldown/binding-linux-arm-gnueabihf@1.2.13、@rolldown/binding-linux-arm64-gnu@1.2.13、@rolldown/binding-linux-arm64-musl@1.2.13、@rolldown/binding-linux-ppc64-gnu@1.2.13、@rolldown/binding-linux-s390x-gnu@1.2.13、@rolldown/binding-linux-x64-gnu@1.2.13、@rolldown/binding-linux-x64-musl@1.2.13、@rolldown/binding-openharmony-arm64@1.2.13、@rolldown/binding-win32-arm64-msvc@1.2.13、@rolldown/binding-win32-x64-msvc@1.2.13、@rolldown/pluginutils@1.0.1、@standard-schema/spec@1.1.0、@testing-library/dom@10.4.2、@testing-library/react@16.3.3、@types/aria-query@5.0.4、@types/chai@5.2.3、@types/deep-eql@4.0.2、@types/estree@1.0.9、@types/json-schema@7.0.15、@types/node@24.19.1、@types/react-dom@19.3.0、@types/react@19.3.0、@typescript-eslint/eslint-plugin@8.71.1、@typescript-eslint/parser@8.71.1、@typescript-eslint/project-service@8.71.1、@typescript-eslint/scope-manager@8.71.1、@typescript-eslint/tsconfig-utils@8.71.1、@typescript-eslint/type-utils@8.71.1、@typescript-eslint/types@8.71.1、@typescript-eslint/typescript-estree@8.71.1、@typescript-eslint/utils@8.71.1、@typescript-eslint/visitor-keys@8.71.1、@vitejs/plugin-react@6.1.2、@vitest/coverage-v8@4.1.11、@vitest/expect@4.1.11、@vitest/mocker@4.1.11、@vitest/pretty-format@4.1.11、@vitest/runner@4.1.11、@vitest/snapshot@4.1.11、@vitest/spy@4.1.11、@vitest/utils@4.1.11、acorn-jsx@5.3.2、acorn@8.19.0、ajv@6.15.0、ansi-regex@5.0.1、ansi-styles@4.3.0、ansi-styles@5.2.0、assertion-error@2.0.1、ast-v8-to-istanbul@1.0.7、balanced-match@1.0.2、balanced-match@4.0.4、bidi-js@1.1.0、brace-expansion@1.1.21、brace-expansion@5.0.12、browserslist@4.29.3、callsites@3.1.0、chai@6.3.0、chalk@4.1.2、color-convert@2.0.1、color-name@1.1.4、concat-map@0.0.1、convert-source-map@2.0.0、cross-spawn@7.0.6、css-tree@3.2.1、csstype@3.2.3、data-urls@8.0.0、debug@4.4.3、decimal.js@10.6.0、deep-is@0.1.4、dequal@2.0.3、dom-accessibility-api@0.5.16、es-module-lexer@2.3.2、esbuild@0.28.2、escalade@3.2.0、escape-string-regexp@4.0.0、eslint-config-prettier@10.1.8、eslint-plugin-react-hooks@7.1.1、eslint@9.39.5、estree-walker@3.0.3、fast-deep-equal@3.1.3、fast-json-stable-stringify@2.1.0、fast-levenshtein@2.0.6、fdir@6.5.0、file-entry-cache@8.0.0、find-up@5.0.0、flat-cache@4.0.1、fsevents@2.3.3、gensync@1.0.0-beta.2、globals@14.0.0、globals@16.5.0、has-flag@4.0.0、hermes-estree@0.25.1、hermes-parser@0.25.1、hono@4.13.13、html-encoding-sniffer@7.0.0、html-escaper@2.0.2、ignore@5.3.2、ignore@7.0.12、import-fresh@3.3.1、imurmurhash@0.1.4、is-extglob@2.1.1、is-glob@4.0.3、is-potential-custom-element-name@1.0.1、js-tokens@10.0.0、js-tokens@4.0.0、js-yaml@4.3.2、jsdom@30.1.2、jsesc@3.1.0、json-buffer@3.0.1、json-schema-traverse@0.4.1、json-stable-stringify-without-jsonify@1.0.1、json5@2.2.3、keyv@4.5.4、levn@0.4.1、locate-path@6.0.0、lodash.merge@4.6.2、lz-string@1.5.0、magic-string@0.30.21、magicast@0.5.5、make-dir@4.0.0、ms@2.1.3、nanoid@3.3.20、natural-compare@1.4.0、node-releases@2.0.58、obug@2.2.1、optionator@0.9.4、oxlint@1.84.0、p-limit@3.1.0、p-locate@5.0.0、parent-module@1.0.1、parse5@8.0.1、path-exists@4.0.0、path-key@3.1.1、pathe@2.0.3、picomatch@4.0.7、postcss@8.5.29、prelude-ls@1.2.1、prettier@3.9.9、pretty-format@27.5.1、punycode@2.3.1、react-dom@19.3.0、react-is@17.0.2、react@19.3.0、require-from-string@2.0.2、resolve-from@4.0.0、rolldown@1.2.13、scheduler@0.28.0、shebang-command@2.0.0、shebang-regex@3.0.0、stackback@0.0.2、std-env@4.3.0、strip-json-comments@3.1.1、supports-color@7.2.0、tinybench@2.9.0、tinyexec@1.3.1、tinyglobby@0.2.17、tinyrainbow@3.2.0、tldts-core@7.4.18、tldts@7.4.18、tr46@7.0.0、ts-api-utils@2.5.0、type-check@0.4.0、typescript-eslint@8.71.1、undici-types@7.24.6、undici@8.11.2、update-browserslist-db@1.3.4、vite@8.3.3、vitest@4.1.11、w3c-xmlserializer@6.0.0、whatwg-mimetype@5.0.0、whatwg-url@17.2.0、why-is-node-running@2.3.0、word-wrap@1.2.5、xmlchars@2.2.0、yocto-queue@0.1.0、zod-validation-error@4.0.2、zod@4.6.5

### Apache-2.0（21 件）

@eslint/config-array@0.21.2、@eslint/config-helpers@0.4.2、@eslint/core@0.17.0、@eslint/object-schema@2.1.7、@eslint/plugin-kit@0.4.1、@humanfs/core@0.19.2、@humanfs/node@0.16.8、@humanfs/types@0.15.0、@humanwhocodes/module-importer@1.0.1、@humanwhocodes/retry@0.4.3、@playwright/test@1.64.0、aria-query@5.3.0、baseline-browser-mapping@2.11.27、eslint-visitor-keys@3.4.3、eslint-visitor-keys@4.2.1、eslint-visitor-keys@5.0.1、expect-type@1.4.0、playwright-core@1.64.0、playwright@1.64.0、typescript@6.0.3、xml-name-validator@5.0.0

### ISC（13 件）

electron-to-chromium@1.5.451、flatted@3.4.4、glob-parent@6.0.2、isexe@2.0.0、lru-cache@5.1.1、minimatch@3.1.5、picocolors@1.1.1、saxes@6.0.0、semver@6.3.1、semver@7.8.5、siginfo@2.0.0、which@2.0.2、yallist@3.1.1

### BSD-2-Clause（8 件）

entities@8.1.0、eslint-scope@8.4.0、espree@10.4.0、esrecurse@4.3.0、estraverse@5.3.0、esutils@2.0.3、uri-js@4.4.1、webidl-conversions@8.0.1

### BSD-3-Clause（6 件）

esquery@1.7.0、istanbul-lib-coverage@3.2.2、istanbul-lib-report@3.0.1、istanbul-reports@3.2.0、source-map-js@1.2.2、tough-cookie@6.0.2

### MIT-0（2 件）

@csstools/color-helpers@6.1.2、@csstools/css-syntax-patches-for-csstree@1.1.15

### BlueOak-1.0.0（2 件）

lru-cache@11.5.3、minimatch@10.2.6

### Python-2.0（1 件）

argparse@2.0.1

### CC-BY-4.0（1 件）

caniuse-lite@1.0.30001815

### CC0-1.0（1 件）

mdn-data@2.27.1
