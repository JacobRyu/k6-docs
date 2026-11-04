# 05. メトリクスとしきい値

この章のゴール:

1. k6 の標準メトリクスを読み分けられる
2. カスタムメトリクスでビジネス指標を測れる
3. しきい値で「合否」を自動判定できる（exit code 99）
4. SLO からしきい値を逆算できる

---

## 1. メトリクスの種類

| 型 | 意味 | 集計 | 例 |
| --- | --- | --- | --- |
| `Counter` | 累積カウント | `count`, `rate` | エラー件数、注文件数 |
| `Gauge` | ある時点の値 | `value`, `min`, `max` | キュー長、残在高 |
| `Rate` | 割合（0〜1） | `rate` | 成功率、キャッシュヒット率 |
| `Trend` | 分布（値の列） | `avg`, `min`, `max`, `med`, `p(90)`, `p(95)`, `p(99)` | レイテンシ、レスポンスサイズ |

```js
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';

const errors = new Counter('business_errors');
const successRate = new Rate('order_success');
const queueDepth = new Gauge('queue_depth');
const latency = new Trend('order_latency', true); // 第2引数 true = 時間として表示

errors.add(1, { reason: 'timeout' });
successRate.add(res.status === 201);
queueDepth.add(res.json('queue_depth'));
latency.add(res.timings.duration, { api: 'order' });
```

カスタムメトリクスも**タグで絞り込めます**。

```js
thresholds: {
  'business_errors{reason:timeout}': ['count<10'],
  'order_latency{api:order}': ['p(95)<500'],
}
```

---

## 2. 標準メトリクス

| メトリクス | 型 | 意味 | 見どころ |
| --- | --- | --- | --- |
| `http_reqs` | Counter | 総リクエスト数 | `rate` が RPS |
| `http_req_duration` | Trend | リクエスト全体の時間 | **p95 / p99** |
| `http_req_waiting` | Trend | 最初のバイトまで（TTFB） | サーバー処理時間の近似 |
| `http_req_connecting` | Trend | TCP 接続時間 | コネクション再利用の効き |
| `http_req_tls_handshaking` | Trend | TLS ハンドシェイク | 新規接続のコスト |
| `http_req_sending` | Trend | 送信時間 | 上り回線・大きなボディ |
| `http_req_receiving` | Trend | 受信時間 | 下り回線・大きなレスポンス |
| `http_req_blocked` | Trend | 空きコネクション待ち | プール枯渇のサイン |
| `http_req_failed` | Rate | 失敗率（既定は 2xx 以外。3xx も失敗） | 可用性 |
| `iteration_duration` | Trend | 1 反復の時間 | sleep 込み |
| `iterations` | Counter | 完了した反復数 | スループット |
| `checks` | Rate | check 成功率 | 機能的正しさ |
| `vus` / `vus_max` | Gauge | 現在/最大 VU | 負荷の実態 |
| `dropped_iterations` | Counter | 開始できなかった反復 | **0 であるべき** |
| `data_received` / `data_sent` | Counter | 通信量 | 帯域・コスト |

### どこを見て原因を切り分けるか

```
http_req_duration が遅い
├─ http_req_waiting も遅い     → サーバー処理（AP/DB/外部API）
├─ http_req_connecting が遅い  → ネットワーク/DNS/接続確立
├─ http_req_blocked が遅い     → コネクションプール枯渇
└─ http_req_receiving が遅い   → レスポンスサイズ/帯域
```

> k6 の時間は**クライアント側**の計測です。サーバー内の内訳は APM・DB メトリクス・CPU 使用率で確認します（第 8 章）。

---

## 3. タグ

自動で付くタグ:

| タグ | 例 |
| --- | --- |
| `name` | `GET /api/products/:id`（`tags.name` で上書き可） |
| `method` | `GET` |
| `status` | `200` |
| `url` | 実際の URL |
| `expected_response` | `true` / `false` |
| `group` | `group()` の名前 |
| `scenario` | シナリオ名 |
| `error` / `error_code` | ネットワークエラー時 |

カスタムタグは `params.tags` で付与します。**カーディナリティを意識**してください。

---

## 4. しきい値（thresholds）

```js
export const options = {
  thresholds: {
    // 分布
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    // 割合
    http_req_failed: ['rate<0.01'],
    // 回数
    http_reqs: ['count>5000'],
    // check
    checks: ['rate>0.99'],
    // タグで絞る
    'http_req_duration{api:checkout}': ['p(95)<1200'],
    // カスタムメトリクス
    business_errors: ['rate<0.05'],
  },
};
```

### 使える集計関数

| 型 | 関数 |
| --- | --- |
| Trend | `avg`, `min`, `max`, `med`, `p(N)` |
| Counter | `count`, `rate` |
| Rate | `rate` |
| Gauge | `value`, `min`, `max` |

### 失敗時にテストを止める

```js
thresholds: {
  http_req_failed: [
    {
      threshold: 'rate<0.05',
      abortOnFail: true,
      delayAbortEval: '30s', // 30 秒経過してから判定（ウォームアップ考慮）
    },
  ],
}
```

- `abortOnFail` は**そのしきい値が破られた時点でテスト全体を中止**します。
- 本番環境への試験では必須の安全装置です（暴走防止）。
- `delayAbortEval` を入れないと、起動直後の一過性エラーで止まることがあります。

### しきい値違反の終了コード

```
exit code 99 → しきい値違反
exit code 0  → すべて合格
```

CI はこの 99 を見て落とすのが基本です（第 7 章）。

---

## 5. SLO からしきい値を作る

| SLO | しきい値の例 |
| --- | --- |
| 可用性 99.9%（月間） | `http_req_failed: ['rate<0.001']` |
| レイテンシ p95 < 300ms | `http_req_duration: ['p(95)<300']` |
| レイテンシ p99 < 1s | `http_req_duration: ['p(99)<1000']` |
| スループット 200 RPS | `http_reqs: ['rate>200']` |
| 機能成功率 99% | `checks: ['rate>0.99']` |

**注意**: 負荷試験のしきい値は「本番の SLO そのもの」ではありません。試験環境・負荷レベル・データ量が違うため、**SLO に安全率をかけた値**を設定します（例: SLO p95 300ms に対し、試験では p95 250ms）。

---

## 6. check をしきい値に昇格させる

```js
const ok = check(res, {
  'status is 200': (r) => r.status === 200,
  'schema is valid': (r) => r.json('id') !== undefined,
});

// check 自体はテストを止めない。合否にしたいなら:
// thresholds: { checks: ['rate>0.99'] }
```

「check は書いたが threshold がない」→ **CI が緑のまま品質が落ちる**典型パターンです。
重要な check は必ず `checks` の threshold で担保します。

---

## 7. サンプル

| ファイル | 内容 |
| --- | --- |
| [`thresholds.js`](thresholds.js) | タグ別・abortOnFail・checks の合否判定 |
| [`custom-metrics.js`](custom-metrics.js) | 4 種類のカスタムメトリクスとタグ |

```bash
k6 run 05-metrics-thresholds/thresholds.js
k6 run 05-metrics-thresholds/custom-metrics.js
echo $?   # 99 ならしきい値違反
```

---

## 次章

→ [06. 結果の出力と可視化](../06-results/README.md)
