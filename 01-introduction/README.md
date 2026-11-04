# 01. はじめの一歩

この章のゴール:

1. k6 をインストールして 1 本実行できる
2. VU / iteration / メトリクスの意味が分かる
3. 出力された数値から「良し悪し」を言える

---

## 1. k6 とは

- Go 製の負荷試験ツール。**単一バイナリ**で動く（Node.js 不要）。
- シナリオは JavaScript。ただし **Node.js ではなく goja** という JS エンジン上で動くため、`fs` や `npm` パッケージは使えない。
- 1 プロセスで数千 VU を捌ける。分散実行は k6 Operator か Grafana Cloud k6 を使う。
- OSS 版は無料。クラウド版は結果保存・分散実行・チーム共有が付く。

### 向いていること

- HTTP / gRPC / WebSocket の API 負荷試験
- CI での性能回帰テスト（しきい値で exit code を返せる）
- 開発者がコードとして管理できるテスト（レビュー可能）

### 向いていないこと（代替を検討）

- ブラウザの描画性能測定 → Playwright / Lighthouse（k6 の browser モジュールでも可だが用途が違う）
- 複雑な GUI 操作の E2E → Playwright / Cypress
- プロトコルレベルの低レイヤ検証 → wrk2 / vegeta なども選択肢

---

## 2. インストール

```bash
# macOS
brew install k6

# Windows
winget install k6 --source winget

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker（バージョン固定を推奨）
docker run --rm -i grafana/k6:2.3.0 run - < smoke.js
```

バージョンは**固定**してください。CI とローカルで違うと結果が変わります。

```bash
k6 version
# k6 v2.3.0 (go1.27.x, darwin/arm64)
```

---

## 3. 最初のスクリプト

[`smoke.js`](smoke.js) を実行します。先にモック API を起動してください。

```bash
# ターミナル 1
python3 mock/server.py

# ターミナル 2
k6 run 01-introduction/smoke.js
```

```js
import http from 'k6/http';
import { check, sleep } from 'k6';

// 同梱モック API を既定の宛先にする
const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  vus: 1,
  duration: '10s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/products?limit=5`);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has items': (r) => Array.isArray(r.json('items')),
    'items are not empty': (r) => r.json('items').length > 0,
  });

  sleep(1);
}
```

### 実行の流れ

```
init コンテキスト（1 回）
  └─ import / options / グローバル変数の定義
        ↓
setup()（1 回・任意）
        ↓
default()（VU ごとに繰り返し）
        ↓
teardown()（1 回・任意）
```

- **VU（Virtual User）**: 擬似ユーザー。`vus: 10` なら 10 人が並行して `default()` を回す。
- **iteration**: `default()` 1 回分の実行。
- `vus: 1, duration: '10s'` は「1 人が 10 秒間、ひたすら繰り返す」。
- `sleep(1)` は**思考時間（think time）**。実ユーザーの間隔を模す。これを入れないと 1 VU が機械的に連打し、非現実的な負荷になる。

---

## 4. 出力の読み方

以下は実行例です（数値は環境・負荷で変わります）。

```
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: smoke.js
     output: -

  scenarios: (100.00%) 1 scenario, 1 max VUs, 40s max duration
           * default: 1 looping VUs for 10s (gracefulStop: 30s)

running (10.0s), 0/1 VUs, 10 complete and 0 interrupted iterations
default ✓ [======================================] 1 VUs  10s

     ✓ status is 200
     ✓ body has items
     ✓ items are not empty

     checks.........................: 100.00% ✓ 30  ✗ 0
     data_received..................: 6.0 kB  600 B/s
     data_sent......................: 900 B   90 B/s
     http_req_blocked...............: avg=1.2ms    min=1µs      med=3µs      max=45ms     p(90)=5µs      p(95)=6µs
     http_req_connecting............: avg=800µs    min=0s       med=0s       max=30ms     p(90)=0s       p(95)=0s
     http_req_duration..............: avg=145.3ms  min=120.1ms  med=142ms    max=210ms    p(90)=160ms    p(95)=178ms
       { expected_response:true }...: avg=145.3ms  min=120.1ms  med=142ms    max=210ms    p(90)=160ms    p(95)=178ms
     http_req_failed................: 0.00%   ✓ 0        ✗ 0
     http_req_receiving.............: avg=1.1ms    min=0s       med=1ms      max=5ms      p(90)=2ms      p(95)=3ms
     http_req_sending...............: avg=90µs     min=40µs     med=80µs     max=300µs    p(90)=120µs    p(95)=150µs
     http_req_tls_handshaking.......: avg=0s       min=0s       med=0s       max=0s       p(90)=0s       p(95)=0s
     http_req_waiting...............: avg=143ms    min=118ms    med=140ms    max=205ms    p(90)=158ms    p(95)=176ms
     http_reqs......................: 10      1/s
     iteration_duration.............: avg=1.14s    min=1.12s    med=1.13s    max=1.21s    p(90)=1.15s    p(95)=1.16s
     iterations.....................: 10      1/s
     vus............................: 1       min=1      max=1
     vus_max........................: 1       min=1      max=1
```

### 必ず見る 5 つ

| メトリクス | 意味 | 見方 |
| --- | --- | --- |
| `http_req_duration` | リクエスト全体の所要時間（ms） | **p(95) / p(99)** を見る。平均は外れ値で嘘をつく |
| `http_req_failed` | 失敗率（2xx 以外は既定で失敗。3xx も含む） | 0.01 = 1% を超えたら赤信号 |
| `http_reqs` | 総リクエスト数と RPS | スループット。目標値に届いているか |
| `iteration_duration` | 1 イテレーションの所要時間 | `http_req_duration` + sleep + 前後処理 |
| `vus_max` / `dropped_iterations` | VU 上限と、開始できなかった反復 | dropped > 0 は負荷不足のサイン（第 3 章） |

### どう判断するか

「p(95) < 500ms」は**このスクリプト内で宣言した合否基準**です。閾値を満たさなければ k6 は **exit code 99** で終了します。これが CI 連携の鍵です。

```bash
k6 run smoke.js; echo "exit=$?"
# 閾値違反があると exit=99
```

> 平均 145ms でも、p(99) が 3 秒なら 100 人に 1 人は 3 秒待っています。SLO は分布で語ります。

---

## 5. 用語の整理

| 用語 | 意味 | 補足 |
| --- | --- | --- |
| VU | 仮想ユーザー | 並行実行の単位。実プロセスではなく goroutine |
| iteration | `default()` 1 回 | VU ごとに独立した JS ランタイムを持つ |
| think time | `sleep()` | 実ユーザーの操作間隔 |
| throughput | 単位時間あたりの処理数 | RPS / iterations/s |
| latency | 応答時間 | k6 では `http_req_duration` |
| percentile | 分位点 | p(95)=95% のリクエストがこの値以下 |
| closed model | VU 数で負荷を決める | VU が空くまで次を投げない |
| open model | 到着率で負荷を決める | 処理能力を超えると待ち行列が伸びる |
| SLO | サービスレベル目標 | 例: p95 < 300ms を 99.9% の時間で満たす |
| SLI | 指標 | レイテンシ、エラー率、可用性 |

---

## 6. 最初にやりがちな失敗

- **`sleep` を入れない** → 1 VU が数千 RPS を出し、VU 数の意味がなくなる
- **`duration` を短くしすぎる** → コネクションプール・DNS・TLS セッション・キャッシュが温まらず過小評価
- **平均値で合否を決める** → テールレイテンシを見落とす
- **しきい値を書かない** → 毎回グラフを目視する属人的運用になる
- **本番 DB に向ける** → 事故。第 8 章のガードレールを先に読む

---

## 次章

→ [02. スクリプト基礎](../02-scripting/README.md)
