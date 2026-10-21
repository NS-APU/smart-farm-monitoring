# 用語集

目的: プロジェクト固有の用語・略語の表記と意味を統一する。新しい業務用語・略語を使う場合は、先にこの表へ追加する（[documentation-guidelines.md](./documentation-guidelines.md) 参照）。

## 記載ルール

- 一般的な教養があれば語句から意味を推測できる用語は載せない。載せるのは、略語、このプロジェクト固有の意味を持つ用語、一般的な意味と異なる用語のみとする
- 「定義」は、このプロジェクトでの意味を書く。一般的な意味と異なる場合は、その旨を明記する
- 別名・略称がある場合は「別名・略称」に記載し、文書中ではこの表の「用語」の表記に統一する
- 定義の出典となるドキュメントがあれば「参照」にリンクする

## 用語一覧

| 用語 | 別名・略称 | 定義 | 参照 |
|------|------------|------|------|
| 第三者評価 | - | イチゴ収穫ロボットの運用の信頼性・実用性を、安全性・稼働率・復旧容易性・メンテナンス性・代替作業手段の確保といった観点から客観的に評価すること | [project-overview.md](./project-overview.md) |
| ヒューマン・イン・ザ・ループ | HITL | システムの分析結果をもとに、人が状況を確認し、判断・対応（復旧・調整・承認など）を行う方式。本システムではダッシュボードでの提示が入口となる | [goals.md](./goals.md) |
| ステータスコード | - | ロボットの状態を表すコード。正常／注意／異常のカテゴリを持ち、観点の判定の入力に使う | [functional-requirements.md](../10_design/requirements/functional-requirements.md) |
| 短期視点・長期視点 | - | 観点の評価の2つの見方。短期は直近値、長期は選んだ期間（当日〜直近90日）の集計値にもとづく | [evaluation.md](../10_design/viewpoint/evaluation.md) |
| 平均故障間隔 | MTBF | 故障から次の故障までの平均時間。ロボット運用の信頼性を示す指標 | [project-overview.md](./project-overview.md) |
| 平均修復時間 | MTTR | 故障から復旧までにかかる平均時間。復旧のしやすさを示す指標 | [project-overview.md](./project-overview.md) |
| 経済生産性 | EconomicProductivity | 運用コストに対する収穫の成果の比（無次元）。（収穫成功率 × 収穫速度 × 可用率）÷ 運用コスト。コスト効率の観点の判定に使う | [robot-health.md](../10_design/viewpoint/robot-health.md) |
| 設計判断の記録 | ADR | 重要な技術選定・設計判断と、その理由を残した記録 | [documentation-guidelines.md](./documentation-guidelines.md) |
| 開発サイト | - | 開発の間の、出来栄えの評価に使う環境。`develop` ブランチを基本としてデプロイし、合成データのみを扱う。現在の評価環境（`SfmData`・`SfmEvaluation`） | [ADR-0013](../10_design/adr/0013-environments-and-access-control.md) |
| 本番サイト | - | 現場での実証実験に使う環境。`main` ブランチだけからデプロイし、実データ（個人情報は不可）を扱える。開発サイトとは、データ・ユーザー・URL を共有しない。実証実験の前に用意する（未作成） | [ADR-0013](../10_design/adr/0013-environments-and-access-control.md) |
| 管理者 | `admin` | ロールの 1 つ。すべての操作ができる | [ADR-0013](../10_design/adr/0013-environments-and-access-control.md) |
| 一般 | `general` | ロールの 1 つ。割り当てられた設備の閲覧・手動入力・自身のユーザー情報の編集に限る（実装は、未） | [ADR-0013](../10_design/adr/0013-environments-and-access-control.md) |
