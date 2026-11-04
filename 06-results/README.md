# 06. 結果の出力と可視化

この章のゴール:

1. 結果を「残る形」で出力できる
2. `handleSummary` でレポートを自動生成できる
3. Prometheus / Grafana に流して継続的に見られる
4. レポートに載せるべき項目が分かる

---

## 1. 出力方法の全体像

| 方法 | コマンド/設定 | 用途 |
| --- | --- | --- |
| 標準出力 | 既定 | 人が見る。CI ログにも残る |
| JSON（生データ） | `--out json=results.json` | 全サンプル。分析用。**巨大になる** |
| CSV | `--out csv=results.csv` | Excel/BI で分析 |
| 集計 JSON | `handleSummary` / `--summary-export` | 指標の集計値だけ |
| Web ダッシュボード | `-o web-dashboard` | 実行中にブラウザで確認 |
| Prometheus | `-o experimental-prometheus-rw` | Grafana で継続監視 |
| OpenTelemetry | `-o opentelemetry` | OTLP Collector 経由で複数基盤へ |
| InfluxDB | `--out influxdb=http://...` | 時系列保存（レガシー構成） |
| Grafana Cloud k6 | `k6 cloud run` | 分散実行 + チーム共有 |

> 認証・タグ設計・PromQL・アラートまで含めた連携の詳細は [10 章](../10-integrations/README.md) にまとめています。

### 生データと集計値の違い

- `--out json` は**1 リクエストごとのサンプル**。数十万行になる。原因分析には強いが、共有には不向き。
- `handleSummary` は**集計済み**。レポート・CI の成果物・比較に向く。

実務では「集計を残す（必須）+ 必要なら生データ（任意）」が扱いやすいです。

---

## 2. handleSummary

k6 はテスト終了時に `handleSummary(data)` を 1 回呼びます。戻り値のオブジェクトのキーが出力先です。

```js
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'reports/summary.json': JSON.stringify(data, null, 2),
    'reports/junit.xml': toJUnit(data),
  };
}
```

`data` の中身:

```js
data.metrics.http_req_duration.values   // { avg, min, med, max, 'p(90)', 'p(95)', ... }
data.metrics.http_req_duration.thresholds // { 'p(95)<500': { ok: true } }
data.state.testRunDurationMs
data.root_group
data.options
```

### 出力例（summary.js）

[`summary.js`](summary.js) は以下を生成します。

- `stdout`: 色付きサマリ
- `reports/summary.json`: 集計値（比較・ダッシュボード用）
- `reports/junit.xml`: CI のテストレポート用

```bash
mkdir -p reports
k6 run 06-results/summary.js
ls reports/
```

> `handleSummary` は **1 回だけ**呼ばれ、VU からは呼べません。重い処理を書くと終了が遅くなるので、集計とファイル出力に留めます。

---

## 3. 標準サマリを消さない

`handleSummary` を定義すると既定の標準出力が**置き換わります**。`stdout` キーを返さないと画面に何も出ません。

```js
// NG: ファイルだけ返して画面が空になる
return { 'reports/summary.json': JSON.stringify(data) };
```

`textSummary` を使うと従来の見た目を維持できます。

---

## 4. Web ダッシュボード（追加ツール不要）

```bash
# v2 では web-dashboard が組み込み（http://127.0.0.1:5665）
k6 run -o web-dashboard 03-load-profiles/ramping-vus.js

# 終了時に HTML として保存
K6_WEB_DASHBOARD_EXPORT=reports/report.html \
  k6 run -o web-dashboard 03-load-profiles/ramping-vus.js
```

ローカルでの確認や、関係者への「1 ファイルで送れる」報告に向きます。

---

## 5. Prometheus + Grafana

### 起動

10 章の連携スタックを使います（Prometheus / Grafana / OTel Collector）。

```bash
cd 10-integrations/stack
docker compose up -d
# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3000 (anonymous admin)
```

> 06 章専用の最小スタックは廃止し、10 章に一本化しました。

### k6 から送る

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),max \
k6 run -o experimental-prometheus-rw 03-load-profiles/ramping-vus.js
```

- `TREND_STATS` の既定は **`p(99)` のみ**です。p95 も見たい場合は明示的に指定します。
- 送信間隔は `K6_PROMETHEUS_RW_PUSH_INTERVAL=5s` で調整できます。
- 実行を区別するには `--tag testid=<RUN_ID>` を付けます。ダッシュボードの絞り込みに便利です。
- Grafana の公式ダッシュボード: **19665**（k6 Prometheus）、**18030**（Native Histograms）。インポートするとすぐ可視化できます。
- 複数プロセスから送る場合は `K6_PROMETHEUS_RW_LABELS=environment=staging,server=srv1` で静的なラベルを付与できます。

### 本番構成での注意

- Prometheus の remote write receiver を有効にする（`--web.enable-remote-write-receiver`）。
- ラベルが増えすぎると時系列が爆発する。**カスタムタグは有限の分類のみ**。
- 長期保存は Grafana Mimir / Thanos / Cloud に送る。
- k6 のメトリクスは**クライアント側**。サーバー側（APM、DB、CPU）と**同じ時間軸で重ねる**こと。

---

## 6. Grafana Cloud k6

OSS 版は 1 プロセスで完結しますが、以下が必要ならクラウド版を検討します。

- 大規模な分散実行（数十万 RPS）
- 結果のチーム共有・比較
- スケジュール実行とアラート
- クラウドからの地理分散試験

```bash
# v2 ではスタックの指定が必須
k6 cloud login
k6 cloud run script.js
```

スクリプト内でプロジェクトを指定:

```js
export const options = {
  cloud: {
    projectID: 123456,
    name: 'checkout-load-test',
  },
};
```

---

## 7. 結果を読むときの順番

1. **しきい値は通ったか**（exit code / サマリの ✓ ✗）
2. **エラー率とエラーの種類**（3xx / 4xx / 5xx か、タイムアウトか）
3. **p95 / p99 の推移**（時間方向で悪化していないか）
4. **スループット**（意図した RPS が出ているか、`dropped_iterations` は 0 か）
5. **サーバー側メトリクス**（CPU、DB 接続、キュー、外部 API）
6. **ボトルネックの特定**（待ち時間の内訳、`http_req_waiting` 等）

### レポートに必ず書くこと

| 項目 | 例 |
| --- | --- |
| 目的・合否基準 | 「ピーク 2 倍で p95 < 800ms」 |
| 環境 | staging / 本番同等スペック、データ量 |
| 負荷モデル | ramping-vus 20→50、10 分定常 |
| 実行 ID | コミット SHA、k6 バージョン、実行日時 |
| 結果 | p95/p99、エラー率、RPS、しきい値判定 |
| ボトルネック | 特定した箇所と根拠 |
| 判断 | リリース可否、改善項目、再試験条件 |
| 添付 | summary.json、ダッシュボード URL、生データ |

テンプレート: [`08-production-playbook/templates/report.md`](../08-production-playbook/templates/report.md)

---

## 8. 保存ポリシー

**スクリプトだけ残しても再現できません。** 以下をセットで保存します。

- スクリプト（git 管理、コミット SHA をタグに付与）
- 実行した設定（`-e` の値、`--config`、k6 バージョン）
- テストデータのスナップショット（または生成方法）
- 結果（summary.json / JUnit / ダッシュボード URL）
- 環境情報（インスタンスタイプ、データ量、同時に動いていたジョブ）

```js
// 実行識別子をタグに入れると後から追跡できる
const RUN_ID = __ENV.RUN_ID || 'local';
http.get(url, { tags: { testid: RUN_ID } });
```

> タグに入れるのは**実行単位の有限な値**まで。リクエスト ID は入れない。

---

## 次章

→ [07. CI/CD への組込み](../07-ci-cd/README.md)
