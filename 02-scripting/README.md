# 02. スクリプト基礎

この章のゴール:

1. ライフサイクル（init / setup / default / teardown）を説明できる
2. HTTP リクエストを正しく投げ、レスポンスを検証できる
3. `check` と `thresholds` の役割の違いを理解する
4. タグでメトリクスを分類できる

---

## 1. ライフサイクル

```
┌─ init コンテキスト ─────────────────────────────┐
│ import、options、定数、open() によるファイル読込 │  ← VU ごとに 1 回
└─────────────────────────────────────────────────┘
                    ↓
┌─ setup() ───────────────────────────────────────┐
│ テスト全体で 1 回。トークン取得、初期データ作成 │
│ 戻り値は default / teardown に渡る              │
└─────────────────────────────────────────────────┘
                    ↓
┌─ default(data) ─────────────────────────────────┐
│ VU ごとに繰り返し実行。ここが負荷の本体         │
└─────────────────────────────────────────────────┘
                    ↓
┌─ teardown(data) ────────────────────────────────┐
│ テスト全体で 1 回。後始末、集計                 │
└─────────────────────────────────────────────────┘
```

### init でやってはいけないこと

```js
// NG: init で HTTP を投げる
const res = http.get('https://example.com'); // 実行時にエラー
```

init は**各 VU の起動時に 1 回**走ります。ここでリクエストを投げると、VU 数分の想定外リクエストが発生します。通信は `setup()` か `default()` で行います。

`open()` も init でのみ使えます。読み込んだファイルはアーカイブに同梱されます。

---

## 2. options の書き方

### パターン A: スクリプト内で export（基本）

```js
export const options = {
  vus: 10,
  duration: '1m',
};
```

### パターン B: 環境変数で上書き

```bash
k6 run -e K6_VUS=50 -e K6_DURATION=5m script.js
```

`K6_` + オプション名（大文字）で上書きできます。CI でパラメータを変えるときに便利です。

### パターン C: 設定ファイル

```bash
k6 run --config config/load.json script.js
```

```json
{
  "vus": 20,
  "duration": "3m",
  "thresholds": { "http_req_duration": ["p(95)<500"] }
}
```

**優先順位**: 環境変数 > `--config` > スクリプト内 `options`。
チームで運用するなら「スクリプトには安全な既定値、環境差は `-e`」が扱いやすいです。

---

## 3. HTTP リクエスト

```js
import http from 'k6/http';

// GET
http.get('https://api.example.com/items');

// クエリパラメータ
http.get('https://api.example.com/items?page=2&limit=50');

// POST (JSON)
const payload = JSON.stringify({ name: 'croc', sex: 'M' });
const params = { headers: { 'Content-Type': 'application/json' } };
http.post('https://api.example.com/items', payload, params);

// PUT / PATCH / DELETE
http.put(url, payload, params);
http.patch(url, payload, params);
http.del(url);
```

### params でよく使うもの

| キー | 用途 |
| --- | --- |
| `headers` | ヘッダー。`Content-Type`、`Authorization` など |
| `tags` | メトリクスの分類ラベル（後述） |
| `timeout` | 個別タイムアウト（既定 60s） |
| `redirects` | リダイレクト追従数（0 で追従しない） |
| `responseType` | `'text'`（既定）/ `'binary'` |
| `auth` | `'basic'` など |

### レスポンスオブジェクト

```js
const res = http.get(url);

res.status;          // 200
res.body;            // 文字列（discardResponseBodies: true なら null）
res.json();          // パース済みオブジェクト
res.json('data.id'); // JSON パス指定
res.headers['Content-Type'];
res.timings.duration;    // 合計 (ms)
res.timings.waiting;     // TTFB
res.timings.connecting;  // TCP 接続
res.timings.tls_handshaking;
res.timings.sending;
res.timings.receiving;
res.error;               // ネットワークエラー時の文字列
res.error_code;          // 数値コード（1000 番台は接続系）
```

### タイムアウトとエラーの扱い

```js
const res = http.get(url, { timeout: '5s' });

if (res.error) {
  // 接続拒否、DNS 失敗、TLS 失敗など。status は 0。
  console.error(`network error: ${res.error} (${res.error_code})`);
}
```

`check` は `status === 200` を見ますが、**status 0 のネットワークエラーも検知**できるように `!res.error` も条件に入れると堅牢です（成功時は空文字、失敗時はエラー文字列が入ります）。

### ボディを捨ててメモリを節約する

```js
export const options = {
  discardResponseBodies: true, // 大きいレスポンスを検証しない場合
};
```

数 GB のレスポンスを扱うと VU のメモリが膨らみます。ボディ不要なら必ず有効化します。ただし `res.json()` は使えなくなります。

---

## 4. check — その場の検証

```js
import { check } from 'k6';

const res = http.get(url);

check(res, {
  'status is 200': (r) => r.status === 200,
  'has items': (r) => r.json('items').length > 0,
  'fast enough': (r) => r.timings.duration < 1000,
});
```

- 失敗しても**テストは継続**し、`checks` メトリクスに記録される。
- 第 3 引数でタグを付けられる: `check(res, {...}, { api: 'list' })`。
- チェック名は一意に。同名が多いと集計が混ざる。

### check と threshold の違い

| | check | thresholds |
| --- | --- | --- |
| 役割 | 個々のレスポンスの検証 | テスト全体の合否判定 |
| 失敗時 | 記録して継続 | 終了時に exit code 99 |
| 単位 | boolean | メトリクスの集計値 |
| 用途 | 「このレスポンスは正しいか」 | 「この性能は許容できるか」 |

**check は書いたが threshold がない**のが最も多いアンチパターンです。check の結果は `checks` メトリクスとして集計されるので、`thresholds: { checks: ['rate>0.99'] }` で合否にできます。

---

## 5. group とタグ

### group — 論理的なまとまり

```js
import { group } from 'k6';

group('トップページ', () => {
  http.get(`${BASE}/`);
  http.get(`${BASE}/assets/app.js`);
});

group('商品一覧', () => {
  http.get(`${BASE}/items`);
});
```

`group` はメトリクスに `group` タグを付けます。ただし**ネストが深いとメモリとカーディナリティが増える**ため、多用は禁物です。

### tags — 分析の主役

```js
http.get(`${BASE}/api/products/${id}/`, {
  tags: { name: 'GET /api/products/:id', api: 'detail' },
});
```

- `name`: URL をテンプレート化して集計をまとめる（**動的 ID 対策の定番**）
- 任意のタグ: `api`, `endpoint`, `tenant`, `flow` など
- タグは threshold の絞り込みにも使える

```js
thresholds: {
  'http_req_duration{api:detail}': ['p(95)<300'],
  'http_req_failed{api:detail}': ['rate<0.01'],
}
```

> カーディナリティ注意: ユーザー ID やリクエスト ID をタグにすると時系列が爆発します。タグは**有限の分類**だけに。

---

## 6. 思考時間（think time）

```js
import { sleep } from 'k6';

export default function () {
  http.get(`${BASE}/items`);
  sleep(Math.random() * 3 + 2); // 2〜5 秒
}
```

- 実ユーザーの間隔を模す。入れないと「1 人が全力で連打する」負荷になる。
- arrival-rate executor では `sleep` の扱いが異なる（第 3 章）。
- ランダム化すると、リクエストの位相が揃って不自然なスパイクになるのを防げる。

---

## 7. デバッグ

```bash
# 送受信の全文を表示
k6 run --http-debug="full" script.js

# 1 VU / 1 イテレーションだけ動かす
k6 run --vus 1 --iterations 1 script.js

# 実行計画の確認（実行しない）
k6 inspect script.js

# 詳細ログ
k6 run --verbose script.js
```

スクリプト内:

```js
console.log('debug', res.status, res.body.slice(0, 200));
console.error('error', res.error);
```

`console.log` は VU ごとに大量に出るので、負荷試験中は残さないこと。

---

## 8. サンプル

| ファイル | 内容 |
| --- | --- |
| [`lifecycle.js`](lifecycle.js) | setup / default / teardown と `k6/execution` |
| [`http-checks.js`](http-checks.js) | GET/POST、check、batch、カスタムメトリクス |
| [`groups-tags.js`](groups-tags.js) | group、`name` タグによる URL 集約、タグ別 threshold |

```bash
k6 run 02-scripting/lifecycle.js
k6 run -e BASE_URL=http://localhost:8080 02-scripting/http-checks.js
```

> 先に `python3 mock/server.py` を起動してください。

---

## 次章

→ [03. 負荷プロファイル](../03-load-profiles/README.md)
