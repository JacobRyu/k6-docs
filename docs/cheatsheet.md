# k6 早見表

## コマンド

```bash
k6 run script.js                       # 実行
k6 run --vus 10 --duration 30s script.js
k6 run -e BASE_URL=https://x script.js # 環境変数
k6 run --out json=results.json script.js
k6 run --out csv=results.csv script.js
k6 inspect script.js                   # 実行せず設定確認
k6 archive -O test.tar script.js       # スクリプト+データを固める
k6 run test.tar
k6 new my-test.js                      # テンプレート生成
k6 version
```

### 実行時オプション

| オプション | 用途 |
| --- | --- |
| `-e KEY=VALUE` | `__ENV.KEY` に渡す |
| `--vus N` / `--duration 30s` | options を上書き |
| `--iterations N` | 反復回数 |
| `--http-debug[=full]` | HTTP の送受信を表示 |
| `--no-connection-reuse` | 接続を再利用しない（切り分け） |
| `--no-vu-connection-reuse` | 同一 VU のイテレーション間で接続を再利用しない |
| `--quiet` | 進捗バーを抑制 |
| `--summary-export=summary.json` | 集計を JSON 出力（handleSummary 推奨） |
| `--summary-mode=compact` / `full` / `disabled` | 標準出力のサマリ形式（v2） |
| `--discard-response-bodies` | レスポンスボディを保持しない |
| `-w`, `--throw` | HTTP エラーを例外として扱う |
| `--config file.json` | 設定ファイル |
| `--out web-dashboard` | Web UI 出力 |

---

## スクリプトの骨格

```js
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  vus: 10,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export function setup() { /* 1 回 */ return {}; }
export default function (data) { /* VU ごと */ }
export function teardown(data) { /* 1 回 */ }

export function handleSummary(data) {
  return { stdout: JSON.stringify(data.metrics, null, 2) };
}
```

---

## executor

| executor | 主な設定 | モデル |
| --- | --- | --- |
| `shared-iterations` | `vus`, `iterations` | 閉 |
| `per-vu-iterations` | `vus`, `iterations` | 閉 |
| `constant-vus` | `vus`, `duration` | 閉 |
| `ramping-vus` | `stages`, `startVUs`, `gracefulRampDown` | 閉 |
| `constant-arrival-rate` | `rate`, `timeUnit`, `duration`, `preAllocatedVUs`, `maxVUs` | 開 |
| `ramping-arrival-rate` | `startRate`, `stages`, `preAllocatedVUs`, `maxVUs` | 開 |

> `externally-controlled` は v2.0 で削除されました。

```js
scenarios: {
  s1: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 50 },
      { duration: '10m', target: 50 },
      { duration: '2m', target: 0 },
    ],
    exec: 'myFlow',
    tags: { scenario: 's1' },
    gracefulRampDown: '30s',
  },
}
```

---

## 主要メトリクス

| メトリクス | 型 | 意味 |
| --- | --- | --- |
| `http_reqs` | Counter | 総リクエスト数（rate = RPS） |
| `http_req_duration` | Trend | 合計時間 |
| `http_req_waiting` | Trend | TTFB |
| `http_req_connecting` | Trend | TCP 接続 |
| `http_req_blocked` | Trend | コネクション待ち |
| `http_req_failed` | Rate | 失敗率 |
| `iteration_duration` | Trend | 反復時間 |
| `iterations` | Counter | 完了反復数 |
| `checks` | Rate | check 成功率 |
| `vus` / `vus_max` | Gauge | VU 数 |
| `dropped_iterations` | Counter | 開始できなかった反復 |
| `data_received` / `data_sent` | Counter | 通信量 |

---

## しきい値

```js
thresholds: {
  http_req_duration: ['p(95)<500', 'p(99)<1500'],
  http_req_failed: ['rate<0.01'],
  http_reqs: ['count>1000'],
  'http_req_duration{api:list}': ['avg<200'],
  'http_req_duration{scenario:browse}': ['p(95)<800'],
  checks: ['rate>0.99'],
  // 違反時に中止
  http_req_failed: [{
    threshold: 'rate<0.05',
    abortOnFail: true,
    delayAbortEval: '30s',
  }],
}
```

集計関数: `avg` `min` `max` `med` `p(N)` `rate` `count` `value`

---

## タグ

```js
http.get(url, {
  tags: {
    name: 'GET /items/:id', // URL の集約
    api: 'items',
    scenario: 'browse',
  },
});
```

自動タグ: `name` `method` `status` `url` `expected_response` `group` `scenario` `error` `error_code`

---

## 認証

```js
// Bearer
http.get(url, { headers: { Authorization: `Bearer ${token}` } });

// VU ごとにキャッシュ
let token = null;
export default function () {
  if (!token) token = login();
}

// Basic
import encoding from 'k6/encoding';
const auth = encoding.b64encode(`${user}:${pass}`);
http.get(url, { headers: { Authorization: `Basic ${auth}` } });

// Cookie（VU ごとに自動管理）
const jar = http.cookieJar();
jar.set('https://example.com', 'session', 'abc');
jar.clear('https://example.com');
```

---

## データ

```js
import { SharedArray } from 'k6/data';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

const rows = new SharedArray('rows', () =>
  papaparse.parse(open('./data.csv'), { header: true }).data,
);

// 重複しない行選択
const row = rows[exec.scenario.iterationInTest % rows.length];
```

---

## よく使う jslib

```js
import { randomString, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';
```

---

## 環境変数

```js
const v = __ENV.MY_VAR;
```

```bash
k6 run -e MY_VAR=value script.js
k6 run -e K6_VUS=50 -e K6_DURATION=5m script.js
```

`-e` で渡した変数は `__ENV` に入ります。v2 では既定でシステム環境変数も入りますが、環境差を避けるため `-e` で明示するのがおすすめです。

---

## 出力

```bash
--out json=results.json                  # 全サンプル（大）
--out csv=results.csv
--out influxdb=http://localhost:8086/k6
-o experimental-prometheus-rw            # Prometheus remote write
-o web-dashboard                         # 実行中に http://127.0.0.1:5665
K6_WEB_DASHBOARD_EXPORT=report.html      # web-dashboard の HTML 保存
```

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),max \
k6 run -o experimental-prometheus-rw script.js
```

```bash
# OTel（v2 組込）
K6_OTEL_GRPC_EXPORTER_ENDPOINT=localhost:4317 \
K6_OTEL_GRPC_EXPORTER_INSECURE=true \
k6 run -o opentelemetry script.js
```

```bash
# 実行識別タグ（全メトリクスに付与）
k6 run --tag testid="$(date +%s)" --tag environment=staging script.js
```

---

## 外部連携

| 連携先 | 方法 |
| --- | --- |
| Prometheus | `-o experimental-prometheus-rw` + `K6_PROMETHEUS_RW_SERVER_URL` |
| OpenTelemetry | `-o opentelemetry` + `K6_OTEL_*` |
| InfluxDB v1 | `--out influxdb=http://host:8086/db` |
| InfluxDB v2 | `xk6-output-influxdb` でビルド |
| Datadog / New Relic | OTLP 直送、または StatsD 拡張 |
| Grafana Cloud | `k6 cloud run` |

```bash
# ローカル検証スタック（Prometheus + Grafana + OTel Collector）
cd 10-integrations/stack && docker compose up -d
# Grafana http://localhost:3000 / Prometheus http://localhost:9090
```

詳細: [`10-integrations/README.md`](../10-integrations/README.md)

---

## exit code

| code | 意味 |
| --- | --- |
| 0 | 成功（しきい値すべて合格） |
| 99 | しきい値違反 |
| その他 | 実行エラー（構文、接続、設定） |

---

## その他のプロトコル（概要）

```js
// WebSocket
import ws from 'k6/ws';
const res = ws.connect('wss://example.com/ws', {}, (socket) => {
  socket.on('message', (msg) => {});
  socket.send('hello');
  socket.setTimeout(() => socket.close(), 1000);
});

// gRPC
import grpc from 'k6/net/grpc';
const client = new grpc.Client();
client.load(['./proto'], 'service.proto');
client.connect('localhost:50051', { plaintext: true });
client.invoke('my.Service/Method', { id: 1 });

// Browser（Chromium が必要）
import { browser } from 'k6/browser';
export const options = { scenarios: { ui: { executor: 'constant-vus', vus: 1, duration: '30s',
  options: { browser: { type: 'chromium' } } } } };
export default async function () {
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await page.close();
}
```

> experimental だったモジュールはバージョンによってパスが変わります。使用する k6 のバージョンのドキュメントを確認してください。
