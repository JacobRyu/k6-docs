# PromQL レシピ

`experimental-prometheus-rw` で送った k6 メトリクスを引くためのクエリ集です。
`$testid` は Grafana の変数、`$__rate_interval` は Grafana が自動調整する間隔に置き換えてください。

## 前提

Trend を p95/p99 で使うには、実行時に統計を明示します。

```bash
K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),max,avg
```

メトリクス名の対応:

| k6 | Prometheus |
|---|---|
| `http_reqs` | `k6_http_reqs_total` |
| `http_req_failed` | `k6_http_req_failed_rate` |
| `http_req_duration` | `k6_http_req_duration_{p95,p99,max,avg}` |
| `vus` | `k6_vus` |
| `iterations` | `k6_iterations_total` |
| `dropped_iterations` | `k6_dropped_iterations_total` |
| `checks` | `k6_checks_rate` |

## スループット

```promql
# 全体の RPS
sum(rate(k6_http_reqs_total{testid="$testid"}[$__rate_interval]))

# シナリオ別
sum by (scenario) (
  rate(k6_http_reqs_total{testid="$testid"}[$__rate_interval])
)

# エンドポイント別
sum by (name) (
  rate(k6_http_reqs_total{testid="$testid"}[$__rate_interval])
)

# 累計リクエスト数
sum(increase(k6_http_reqs_total{testid="$testid"}[$__range]))
```

## エラー

```promql
# エラー率（最も悪いエンドポイント, 0〜1）
max(k6_http_req_failed_rate{testid="$testid"})

# パーセント表示
max(k6_http_req_failed_rate{testid="$testid"}) * 100

# 全体のエラー率（0〜1）
sum(rate(k6_http_reqs_total{testid="$testid", expected_response="false"}[$__rate_interval]))
/
sum(rate(k6_http_reqs_total{testid="$testid"}[$__rate_interval]))

# ステータスコード別の失敗数
sum by (status) (
  increase(k6_http_reqs_total{testid="$testid", expected_response="false"}[$__range])
)

# check の成功率
min(k6_checks_rate{testid="$testid"})
```

> `http_req_failed` は「2xx 以外（3xx を含む）を失敗とみなす」Rate メトリクスです。業務上 3xx/4xx が正常な API では、`expected_response` タグや check 側で制御してください。

## レイテンシ

```promql
# エンドポイント別 p95
k6_http_req_duration_p95{testid="$testid"}

# 全体の「最悪エンドポイント」p95（百分位は合算できないので max）
max(k6_http_req_duration_p95{testid="$testid"})

# p99
max(k6_http_req_duration_p99{testid="$testid"})

# 平均
avg(k6_http_req_duration_avg{testid="$testid"})

# 遅い順トップ 5
topk(5, max by (name) (k6_http_req_duration_p95{testid="$testid"}))
```

**注意**: パーセンタイルは足し算できません。`sum(k6_http_req_duration_p95)` は意味のない値になります。全体値が必要なら、ネイティブヒストグラムから計算するか、`max` を「最悪値」として扱ってください。

```promql
# ネイティブヒストグラム（remote write で K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true）
histogram_quantile(
  0.95,
  sum(rate(k6_http_req_duration{testid="$testid"}[$__rate_interval]))
)
```

```promql
# クラシックなバケット（OTel Collector の Prometheus exporter 経由など）
histogram_quantile(
  0.95,
  sum by (le) (rate(k6_http_req_duration_bucket{testid="$testid"}[$__rate_interval]))
)
```

`_bucket` と `le` があるかどうかでクエリが変わります。保存先のヒストグラム形式を確認してください。

## 負荷生成側の状態

```promql
# 現在の VU 数
max(k6_vus{testid="$testid"})

# 1 秒あたりの完了イテレーション
sum(rate(k6_iterations_total{testid="$testid"}[$__rate_interval]))

# 取りこぼしたイテレーション（0 でないなら負荷不足）
sum(rate(k6_dropped_iterations_total{testid="$testid"}[$__rate_interval]))

# 送受信バイト数
sum(rate(k6_data_sent_total{testid="$testid"}[$__rate_interval]))
sum(rate(k6_data_received_total{testid="$testid"}[$__rate_interval]))
```

## 実行同士の比較

```promql
# 直前 2 回の p95 を並べる（testid を増やす）
max by (testid) (k6_http_req_duration_p95{testid=~"$testid"})

# 同一シナリオの RPS 比較
sum by (testid) (rate(k6_http_reqs_total{testid=~"$testid"}[$__rate_interval]))
```

Grafana では `testid` を複数選択できる変数にし、`legendFormat` を `{{testid}}` にすると比較しやすくなります。

## SLO との突き合わせ

例: p95 < 500ms、エラー率 < 1% を 30 日で 99% 満たす。

```promql
# ネイティブヒストグラム: 500ms 以下だった割合
histogram_fraction(
  0, 500,
  sum(rate(k6_http_req_duration{testid="$testid"}[30d]))
)
```

```promql
# クラシックバケット: 500ms 以下だった割合
sum(rate(k6_http_req_duration_bucket{testid="$testid", le="500"}[30d]))
/
sum(rate(k6_http_req_duration_count{testid="$testid"}[30d]))
```

`le` / `histogram_fraction` の境界値は Trend メトリクスの単位（`http_req_duration` は ms）に合わせます。長期 SLO はアプリ側のメトリクスで測るのが基本で、k6 の値は「試験時の確認」に使います。

## OTel 経由の場合

OTel 出力では Rate が Counter + `condition` 属性になります。

```promql
# 失敗率
sum(rate(k6_http_req_failed_total{condition="nonzero"}[$__rate_interval]))
/
sum(rate(k6_http_req_failed_total[$__rate_interval]))
```

Trend は Histogram になるため、`_bucket` に対する `histogram_quantile` を使います（Collector の Prometheus exporter 経由）。
