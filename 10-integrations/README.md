# 10. 他製品との連携

k6 単体でも合否判定・標準出力・JSON/CSV/Web ダッシュボードまではできますが、実務では、結果を既存の監視基盤に流し、**アプリ側のメトリクスと重ねてボトルネックを特定**するところまでがセットです。

この章では、代表的な連携先と、実際に動く設定・クエリを扱います。

```
                          ┌────────────────────┐
   k6 (script) ──────────▶│ Prometheus         │──▶ Grafana
        │                 │ (remote write)     │
        │                 └────────────────────┘
        │
        ├────────────────▶ OTLP Collector ──▶ Prometheus / Datadog / New Relic / ...
        │
        ├────────────────▶ InfluxDB v1（組込） / v2（拡張）
        │
        └────────────────▶ JSON / CSV / handleSummary（Webhook・Slack）
```

> 同梱スタックには Alertmanager を含みません。`prometheus/alerts.yml` は Prometheus UI で確認し、通知が必要な場合は Alertmanager または Grafana Alerting を別途追加してください。

## 1. どの経路を選ぶか

| 状況 | 推奨する経路 | 理由 |
|---|---|---|
| すでに Prometheus + Grafana がある | **Prometheus remote write** | 既存の PromQL・アラート・ダッシュボードをそのまま使える |
| OTel で統一している / 複数バックエンドへ配りたい | **OpenTelemetry output**（v2 組込） | 1 つの出力で Collector 経由で複数へ送れる |
| Grafana Cloud を使っている | **Grafana Cloud k6** または Cloud Prometheus へ remote write | 実行基盤と保存先をマネージドにできる |
| Datadog / New Relic が主基盤 | **OTLP**（推奨）または StatsD 拡張 | アプリの APM と同じ画面で相関できる |
| InfluxDB v1 がある | **組込 `-o influxdb`** | 追加ビルド不要 |
| まずは結果を残したいだけ | **JSON / CSV / `handleSummary`** | 依存がなく CI の成果物にしやすい |

> **重要**: どの経路でも、**テスト実行を識別するタグ**（`testid`）と**環境タグ**（`environment`）を必ず付けます。これがないと、過去の実行と混ざって比較できません。

## 2. 共通の作法

### 2.1 実行識別タグを付ける

```bash
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"

k6 run \
  --tag testid="$RUN_ID" \
  --tag environment=staging \
  -o experimental-prometheus-rw \
  03-load-profiles/ramping-vus.js
```

`--tag` は全メトリクスに付与されます。スクリプト側で `tags` を指定している場合は、そちらが優先されます。

### 2.2 時刻を合わせる

k6 は実行マシンの時計でサンプルを送ります。アプリ側のメトリクスと重ねる場合、**k6 実行ホストと監視対象の NTP 同期**は必須です。数秒ずれるだけで「負荷をかけた瞬間に遅延が上がった」という因果が読めなくなります。

### 2.3 保存期間と粒度を決める

- Prometheus の保持期間はデフォルト 15 日。四半期比較をするなら remote write 先を長期保存（Thanos / Mimir / Grafana Cloud）にする
- 生の JSON を毎回コミットしない。CI の artifact に保存し、保持日数を決める
- ダッシュボードは「実行中に見るもの」、合否は threshold / CI が正とする

## 3. Prometheus 連携（本命）

### 3.1 仕組み

k6 の `experimental-prometheus-rw` 出力が、テスト中のメトリクスを **Prometheus remote write プロトコル**で送信します。Prometheus 側は receiver を有効にするだけです。

```bash
# Prometheus 起動オプション
--web.enable-remote-write-receiver
```

### 3.2 ローカルで試す

`10-integrations/stack/` に Prometheus + Grafana + OTel Collector の構成を用意しています。

```bash
cd 10-integrations/stack
docker compose up -d prometheus grafana
# Grafana: http://localhost:3000（anonymous admin）
# Prometheus: http://localhost:9090
```

別ターミナルでモック API と k6 を起動します。

```bash
python3 mock/server.py

RUN_ID="local-$(date +%s)"
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),max \
K6_PROMETHEUS_RW_STALE_MARKERS=true \
k6 run --tag testid="$RUN_ID" --tag environment=local \
  -o experimental-prometheus-rw \
  03-load-profiles/ramping-vus.js
```

Grafana の **k6 Overview** ダッシュボードを開き、`testid` を選ぶと実行中の値が表示されます。

### 3.3 メトリクス名の対応

| k6 | Prometheus | 例 |
|---|---|---|
| Counter | `k6_*_total` | `k6_http_reqs_total` |
| Gauge | `k6_*` | `k6_vus` |
| Rate | `k6_*_rate`（0〜1） | `k6_http_req_failed_rate` |
| Trend | `k6_*_<stat>`（既定は p99 のみ） | `k6_http_req_duration_p95` |

Trend は既定で **`p(99)` しか出ません**。p95 を使うなら `K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),max` のように明示してください。

### 3.4 PromQL レシピ

よく使うクエリは [`prometheus/queries.md`](prometheus/queries.md) にまとめています。代表例:

```promql
# 全体の RPS
sum(rate(k6_http_reqs_total{testid="$testid"}[$__rate_interval]))

# エラー率（最も悪いエンドポイント, %）
max(k6_http_req_failed_rate{testid="$testid"}) * 100

# 全体のエラー率（%）
100 * sum(rate(k6_http_reqs_total{testid="$testid", expected_response="false"}[$__rate_interval]))
    / sum(rate(k6_http_reqs_total{testid="$testid"}[$__rate_interval]))

# エンドポイント別 p95
k6_http_req_duration_p95{testid="$testid"}

# 負荷生成側の飽和（取りこぼし）
sum(rate(k6_dropped_iterations_total{testid="$testid"}[$__rate_interval]))
```

### 3.5 アラート

テスト中に「エラー率が上がった」「p95 が SLO を超えた」を検知したい場合は、Prometheus のルールを使います。[`prometheus/alerts.yml`](prometheus/alerts.yml) を参照してください。

```yaml
- alert: K6ErrorRateHigh
  expr: max by (testid, scenario) (k6_http_req_failed_rate) > 0.01
  for: 1m
```

> この式は「シナリオ内で最も悪いエンドポイント」を見ます。全体のエラー率は `expected_response="false"` のリクエスト数から計算してください（`prometheus/queries.md` 参照）。

> アラートは**長時間試験（soak / stress）向け**です。数分の CI スモークは k6 の threshold と exit code で判定してください。アラートを CI の合否に使うと、発火タイミングのブレでフレーキーになります。

### 3.6 ネイティブヒストグラム

Trend をヒストグラムとして送ると、パーセンタイルを後から自由に計算できます。

```bash
# Prometheus 側
--enable-feature=native-histograms

# k6 側
K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
k6 run -o experimental-prometheus-rw script.js
```

```promql
# ネイティブヒストグラムは単一の時系列として保存される
histogram_quantile(0.95,
  sum(rate(k6_http_req_duration{testid="$testid"}[$__rate_interval])))
```

ネイティブヒストグラム非対応の保存先もあるため、導入前に互換性を確認してください。

### 3.7 Grafana Cloud / 認証付きエンドポイント

```bash
K6_PROMETHEUS_RW_SERVER_URL="https://prometheus-prod-xx.grafana.net/api/prom/push" \
K6_PROMETHEUS_RW_USERNAME="<instance-id>" \
K6_PROMETHEUS_RW_PASSWORD="<token>" \
k6 run -o experimental-prometheus-rw script.js
```

- Basic 認証: `K6_PROMETHEUS_RW_USERNAME` / `K6_PROMETHEUS_RW_PASSWORD`
- Bearer: `K6_PROMETHEUS_RW_BEARER_TOKEN`
- 追加ヘッダ: `K6_PROMETHEUS_RW_HTTP_HEADERS="key1:value1,key2:value2"`
- 静的ラベル: `K6_PROMETHEUS_RW_LABELS="environment=staging,runner=ci-01"`

認証情報は `.env` や CI Secrets に置き、スクリプトやリポジトリに書かないでください。

## 4. OpenTelemetry 連携

k6 v2 では **OTel 出力が本体に組み込まれています**（`-o opentelemetry`）。Collector を挟むと、Prometheus・Datadog・New Relic などへ同時に配れます。

### 4.1 Collector 経由で Prometheus へ

`stack/otel-collector.yaml` は OTLP（gRPC 4317 / HTTP 4318）を受け、Prometheus exporter（8889）で公開します。Prometheus がそれを scrape します。

```bash
cd 10-integrations/stack
docker compose up -d otel-collector prometheus grafana
```

```bash
K6_OTEL_GRPC_EXPORTER_ENDPOINT=localhost:4317 \
K6_OTEL_GRPC_EXPORTER_INSECURE=true \
K6_OTEL_METRIC_PREFIX=k6_ \
k6 run --tag testid="otel-$(date +%s)" -o opentelemetry 01-introduction/smoke.js
```

HTTP/protobuf を使う場合:

```bash
K6_OTEL_EXPORTER_PROTOCOL=http/protobuf \
K6_OTEL_HTTP_EXPORTER_ENDPOINT=localhost:4318 \
K6_OTEL_HTTP_EXPORTER_INSECURE=true \
k6 run -o opentelemetry script.js
```

### 4.2 OTel 特有の注意

- **Rate は 1 つの Counter + `condition` 属性**（`zero` / `nonzero`）に変換されます。`http_req_failed` の率を出すときは `condition="nonzero"` 側を見ます
- **Trend は Histogram** になります。Prometheus 経由なら `_bucket` に対する `histogram_quantile` を使います
- 送信間隔は `K6_OTEL_EXPORT_INTERVAL`（既定 10s）、flush は `K6_OTEL_FLUSH_INTERVAL`（既定 1s）
- サービス名は `K6_OTEL_SERVICE_NAME`（既定 `k6`）。実行ごとに変えると識別しやすい

```promql
# OTel Collector の Prometheus exporter 経由の場合
histogram_quantile(0.95,
  sum by (le) (rate(k6_http_req_duration_bucket[5m])))
```

### 4.3 主な環境変数

| 変数 | 用途 |
|---|---|
| `K6_OTEL_GRPC_EXPORTER_ENDPOINT` | gRPC 宛先（既定 `localhost:4317`） |
| `K6_OTEL_HTTP_EXPORTER_ENDPOINT` | HTTP 宛先（既定 `localhost:4318`） |
| `K6_OTEL_EXPORTER_PROTOCOL` | `grpc` / `http/protobuf` |
| `K6_OTEL_METRIC_PREFIX` | メトリクス接頭辞 |
| `K6_OTEL_HEADERS` | 認証ヘッダ等（`k1=v1,k2=v2`） |
| `K6_OTEL_TLS_INSECURE_SKIP_VERIFY` | 検証環境で TLS 検証を省略 |

## 5. InfluxDB

### v1（組込）

```bash
k6 run --out influxdb=http://localhost:8086/k6 script.js
```

DB がなければ自動作成されます。Grafana の InfluxQL データソースで可視化できます。

### v2（拡張）

v2 は Flux 前提のため、`xk6-output-influxdb` で k6 をビルドします。

```bash
go install go.k6.io/xk6/cmd/xk6@latest
xk6 build --with github.com/grafana/xk6-output-influxdb

K6_INFLUXDB_ORGANIZATION=my-org \
K6_INFLUXDB_BUCKET=k6 \
K6_INFLUXDB_TOKEN="$INFLUX_TOKEN" \
K6_INFLUXDB_ADDR=http://localhost:8086 \
./k6 run -o xk6-influxdb script.js
```

> InfluxDB v1 はサポート終了が近いため、新規構築なら Prometheus か OTel を検討してください。

## 6. Datadog / New Relic / その他

### Datadog

第一候補は **OTel 出力 → Datadog Agent の OTLP 取り込み**です。

```bash
# Datadog Agent 側で OTLP を有効化（例）
DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_GRPC_ENDPOINT=0.0.0.0:4317

# k6 側
K6_OTEL_GRPC_EXPORTER_ENDPOINT=localhost:4317 \
K6_OTEL_GRPC_EXPORTER_INSECURE=true \
k6 run -o opentelemetry script.js
```

StatsD 経由が必要な場合は `xk6-output-statsd` 拡張でビルドします（組込 StatsD は v0.55 で削除済み）。

```bash
xk6 build --with github.com/LeonAdato/xk6-output-statsd
K6_STATSD_ENABLE_TAGS=true ./k6 run -o output-statsd script.js
```

### New Relic

OTLP エンドポイントへ直接送れます。

```bash
K6_OTEL_GRPC_EXPORTER_ENDPOINT=otlp.nr-data.net:4317 \
K6_OTEL_HEADERS="api-key=$NEW_RELIC_LICENSE_KEY" \
K6_OTEL_GRPC_EXPORTER_INSECURE=false \
k6 run -o opentelemetry script.js
```

EU リージョンは `otlp.eu01.nr-data.net:4317` を使います。

### その他のバックエンド

Kafka / Amazon CloudWatch / Dynatrace / Elasticsearch / TimescaleDB などは、**OTel Collector の exporter** を使うのが最も保守しやすい方法です。Collector を 1 つ立て、k6 は OTLP だけを話す構成にすると、バックエンド変更時も k6 側は変更不要になります。

| バックエンド | 経路 |
|---|---|
| Kafka | Collector の `kafka` exporter |
| CloudWatch | Collector の `awsemf` / `awsxray` exporter |
| Dynatrace | OTLP 直送または Collector |
| Elasticsearch | Collector の `elasticsearch` exporter |
| TimescaleDB | `xk6-output-timescaledb` 拡張 |

## 7. Kubernetes / CI / Cloud

- **k6 Operator**: `TestRun` CRD で Kubernetes 上に分散実行。結果は Prometheus へ remote write するのが定番
- **GitHub Actions**: 07 章のワークフロー参照。結果は artifact + Prometheus の両方に残す
- **Grafana Cloud k6**: `k6 cloud run script.js`。ローカル実行のまま結果だけ送るなら `k6 cloud run --local-execution script.js`
- **分散実行時の注意**: 複数 Pod から同じ Prometheus へ送る場合、`K6_PROMETHEUS_RW_LABELS="runner=$POD_NAME"` のように**送信元ラベル**を付ける

## 8. アプリ側メトリクスとの相関

負荷試験の価値は「k6 の数値」ではなく「**アプリのどこが詰まったか**」にあります。

### 8.1 見るべき組み合わせ

| レイヤ | メトリクス | 何が分かるか |
|---|---|---|
| k6 | `http_req_duration` p95/p99、`http_req_failed` | ユーザー視点の遅さ・失敗 |
| k6 | `dropped_iterations` | 負荷生成側の限界（結果が過小評価になる） |
| APM | レイテンシ、エラー率、スループット | どのサービスが遅いか |
| ホスト/コンテナ | CPU、メモリ、GC、I/O、コネクション数 | 飽和しているリソース |
| DB | スロークエリ、待ち時間、プール使用率 | DB 起因かどうか |
| ネットワーク | 帯域、再送、LB の 5xx | 経路の問題 |

### 8.2 Grafana アノテーションで実行区間を可視化

テスト開始・終了をアノテーションとして残すと、アプリのグラフと因果を読みやすくなります。

```bash
curl -X POST "$GRAFANA_URL/api/annotations" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"k6 load test start ($RUN_ID)\",\"tags\":[\"k6\",\"$RUN_ID\"],\"time\":$(date +%s000)}"
```

### 8.3 切り分けの順序

1. k6 側の `dropped_iterations` が 0 か（負荷が出せているか）
2. エラー率が上がっているか（成功している前提か）
3. p95 の上昇が特定の `name`（エンドポイント）に偏っていないか
4. 同時刻の APM / ホスト / DB メトリクスで飽和している resource はどれか
5. アプリのログで例外・タイムアウト・プール枯渇を確認

## 9. 結果通知（Webhook / Slack）

CI の完了通知や Slack への投稿は `handleSummary` で行えます。[`webhook-summary.js`](webhook-summary.js) は、標準出力にサマリを出しつつ、`WEBHOOK_URL` があれば JSON を POST します。

```bash
WEBHOOK_URL=https://hooks.slack.com/services/XXX \
k6 run 10-integrations/webhook-summary.js
```

> Webhook には**要約だけ**を送ります。全メトリクスを送ると通知が読めなくなり、レート制限にも当たります。詳細は artifact / ダッシュボードへのリンクにします。

## 10. アンチパターン

| アンチパターン | 何が起きるか | 対策 |
|---|---|---|
| 全リクエストの生データを Prometheus へ送る | カーディナリティ爆発・保存コスト増 | remote write / OTel の集約に任せる |
| `name` タグに生の URL・ID を入れる | 時系列が無限に増える | `GET /api/products/:id` のようにテンプレート化 |
| `testid` を付けない | 過去実行と混ざって比較不能 | 実行ごとに一意な ID を付与 |
| ダッシュボードの目視だけで合否判定 | 属人的・再現不能 | threshold + exit code を正とする |
| k6 と対象の時計がずれている | 因果が読めない | NTP 同期、同一タイムゾーン |
| 認証情報をスクリプトに直書き | 漏えい | `.env` / CI Secrets / Vault |
| 負荷生成側の飽和を無視 | 性能を過小評価 | `dropped_iterations` を監視 |

## 11. チェックリスト

- [ ] 連携先を 1 つに決めた（Prometheus / OTel / Cloud）
- [ ] `testid` と `environment` タグを全実行に付けた
- [ ] Trend の統計（p95/p99）を明示した
- [ ] Grafana ダッシュボードで実行中に p95・エラー率・RPS・VU を確認できる
- [ ] アプリ側の RED / USE メトリクスと同じ画面で見られる
- [ ] 長時間試験用のアラートを設定した（CI は threshold で判定）
- [ ] 認証情報を Secret 管理に置いた
- [ ] 結果の保存期間と artifact の保持日数を決めた
- [ ] `dropped_iterations` を監視対象にした

## 参考

- [Prometheus remote write](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/)
- [OpenTelemetry output](https://grafana.com/docs/k6/latest/results-output/real-time/opentelemetry/)
- [InfluxDB](https://grafana.com/docs/k6/latest/results-output/real-time/influxdb/)
- [Datadog](https://grafana.com/docs/k6/latest/results-output/real-time/datadog/)
- [New Relic](https://grafana.com/docs/k6/latest/results-output/real-time/new-relic/)
- [Grafana ダッシュボード 19665](https://grafana.com/grafana/dashboards/19665-k6-prometheus/)
