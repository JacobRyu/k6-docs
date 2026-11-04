# k6 実務ガイド — 入門から本番運用まで

k6（Grafana k6）は、Go 製のオープンソース負荷試験ツールです。
JavaScript（ES2015+ / goja）でシナリオを書き、単一バイナリで動きます。

このリポジトリは「読むだけの資料」ではなく、**手を動かしながら本番運用レベルまで到達する**ための教材 + 実運用テンプレート集です。

---

## 対象読者

| レベル | 前提知識 | この資料で得られるもの |
| --- | --- | --- |
| 初級 | HTTP の基礎、JS の基本文法 | スクリプトが書ける、結果が読める |
| 中級 | API 開発/運用の経験 | 負荷モデル設計、しきい値による合否判定、CI 組込み |
| 上級 | SLO/監視/インフラ運用 | 本番試験の計画・実施・判定・運用への定着 |

負荷試験の経験は不要です。ただし「負荷試験はツールの使い方ではなく、**何を検証したいかを決める仕事**」という前提で書いています。

---

## 学習ロードマップ

| # | 章 | テーマ | 主な成果物 | 目安 |
| --- | --- | --- | --- | --- |
| 01 | [はじめの一歩](01-introduction/README.md) | インストール、初回実行、結果の読み方 | `smoke.js` | 1h |
| 02 | [スクリプト基礎](02-scripting/README.md) | ライフサイクル、HTTP、check、group/tag | 3 本のスクリプト | 3h |
| 03 | [負荷プロファイル](03-load-profiles/README.md) | executor、閉じた/開いたモデル、試験の種類 | 3 本のシナリオ | 3h |
| 04 | [テストデータと認証](04-data-and-auth/README.md) | 環境変数、CSV/SharedArray、トークン、cookie | 認証付きシナリオ | 3h |
| 05 | [メトリクスとしきい値](05-metrics-thresholds/README.md) | 標準/カスタムメトリクス、SLO との対応、abort | 合否判定付きテスト | 3h |
| 06 | [結果の出力と可視化](06-results/README.md) | handleSummary、Prometheus/Grafana | レポート生成 | 2h |
| 07 | [CI/CD への組込み](07-ci-cd/README.md) | PR ゲート、夜間試験、分散実行 | GitHub Actions | 3h |
| 08 | [本番運用プレイブック](08-production-playbook/README.md) | 計画・実施・判定・定着 | 試験計画書/報告書 | 4h |
| 09 | [トラブルシューティング](09-troubleshooting/README.md) | よくある失敗と切り分け | チェックリスト | 随時 |
| 10 | [他製品との連携](10-integrations/README.md) | Prometheus / OTel / Datadog / New Relic、相関分析 | 監視スタック | 3h |

**最短コース（1 日）**: 01 → 02 → 03 → 05 を読み、最後に 08 のチェックリストを通す。
**本番導入コース（1 週間）**: 全章 + 自社 API で 1 シナリオを書き、CI に smoke を入れる。

---

## クイックスタート

```bash
# macOS
brew install k6

# または Docker（バージョン固定を推奨）
docker run --rm -i grafana/k6:2.3.0 run - < 01-introduction/smoke.js

# 動作確認
k6 version
```

サンプルの宛先は同梱のモック API です。**ターミナルを 2 つ使います**。

```bash
# ターミナル 1: モック API（Python 3 標準ライブラリのみ）
python3 mock/server.py
# [mock] listening on http://127.0.0.1:8080

# ターミナル 2: テスト実行
k6 run 01-introduction/smoke.js
```

`http_req_duration` の `p(95)` と `http_req_failed` が表示され、`✓ status is 200` が並べば成功です。
外部 SaaS に依存しません（jslib を使う一部スクリプトは初回にネットワークが必要です）。

### Makefile

```bash
make mock     # モック API を起動（別ターミナル）
make smoke    # 疎通確認
make auth     # 認証付きシナリオ（demo/demo）
make report   # reports/summary.json と junit.xml を生成
make check    # 全スクリプトの構文・設定を検証
```

---

## ディレクトリ構成

```
.
├── 01-introduction/         # 初回実行と結果の読み方
├── 02-scripting/            # スクリプトの書き方
├── 03-load-profiles/        # 負荷のかけ方（executor）
├── 04-data-and-auth/        # データ駆動・認証
├── 05-metrics-thresholds/   # メトリクスと合否判定
├── 06-results/              # レポート・可視化
├── 07-ci-cd/                # CI 組込み
├── 08-production-playbook/  # 本番運用の進め方
│   └── templates/           # 試験計画書・報告書の雛形
├── 09-troubleshooting/      # 困ったとき
├── 10-integrations/         # Prometheus / OTel など外部製品との連携
│   ├── stack/               # Prometheus + Grafana + OTel Collector
│   └── prometheus/          # PromQL 集・アラートルール
├── mock/                    # サンプル用モック API（Python 標準ライブラリ）
├── docs/cheatsheet.md       # コマンド/API 早見表
├── .github/workflows/k6.yml # GitHub Actions の実例
└── Makefile                 # よく使う実行コマンド
```

---

## 共通の前提

- 対象バージョン: **k6 v2.x**（検証は v2.3.0）。v1 系との差分は各章で補足しています。
- サンプルの宛先は環境変数 `BASE_URL` で差し替えられます。未指定時は同梱モック（`http://localhost:8080`）です。
- 認証情報は**絶対にスクリプトに直書きしない**でください（第 4 章・第 7 章参照）。

```bash
export BASE_URL=https://api.example.com
k6 run -e BASE_URL="$BASE_URL" 02-scripting/http-checks.js
```

---

## 本番運用の要点（先に結論）

1. **目的と合否基準を先に決める**。「速いか遅いか」ではなく「SLO を満たすか」。
2. **しきい値（thresholds）を必ず書く**。人がグラフを眺める運用は続かない。
3. **平均値で判断しない**。p95 / p99 とエラー率、そして飽和点を見る。
4. **負荷モデルを意識する**。ユーザー数（閉じたモデル）か、リクエスト毎秒（開いたモデル）か。
5. **本番同等環境**で測る。データ量・ネットワーク・外部依存・キャッシュを合わせる。
6. **書き込み系は隔離する**。専用アカウント・専用テナント・後始末までを設計する。
7. **k6 はクライアント視点**。サーバ側の CPU/DB/キュー/外部 API と必ず突き合わせる。
8. **結果を残す**。スクリプト・データ・設定・バージョン・実行 ID をセットで保存。
9. **段階的に負荷を上げ、自動停止を用意する**（`abortOnFail`、キルスイッチ）。
10. **定期実行して回帰を検知する**。単発の試験は一度きりの行事で終わる。

---

## 参考リンク

- 公式ドキュメント: https://grafana.com/docs/k6/latest/
- jslib（便利ライブラリ）: https://jslib.k6.io
- Grafana Cloud k6: https://grafana.com/products/cloud/k6/
