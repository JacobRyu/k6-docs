# 03. 負荷プロファイル

この章のゴール:

1. 「閉じたモデル」と「開いたモデル」の違いを説明できる
2. 目的別に試験の種類（スモーク/ロード/ストレス/スパイク/ソーク）を選べる
3. executor を設計し、複数シナリオを同時に動かせる

---

## 1. まず負荷モデルを決める

### 閉じたモデル（closed model）

> 「N 人が同時に操作している」

- VU 数を固定する。VU はレスポンスが返るまで次のリクエストを投げない。
- 実装: `constant-vus` / `ramping-vus` / `shared-iterations` / `per-vu-iterations`
- 向く場面: Web サイトの同時接続ユーザー、社内システムの利用者数
- 注意: サーバーが遅くなると**自然に RPS が下がる**（負荷が逃げる）。「遅いけど落ちない」を見逃しやすい。

### 開いたモデル（open model）

> 「毎秒 N リクエストが外部から到着する」

- 到着率（rate）を固定する。処理能力を超えると待ち行列が伸び、VU が足りなければ**リクエストが落ちる**（`dropped_iterations`）。
- 実装: `constant-arrival-rate` / `ramping-arrival-rate`
- 向く場面: API、バッチ、他サービスからの呼び出し、負荷分散配下のエンドポイント
- 注意: `preAllocatedVUs` / `maxVUs` が不足すると意図した負荷をかけられない。

### リトルの法則

```
同時実行数 ≒ スループット × 平均レイテンシ
```

例: 100 RPS、平均 200ms → 20 並行。VU 20 で足りる計算。
到着率モデルで VU 数を見積もるときの出発点になります（実際は p95 基準 + 余裕で 1.5〜2 倍）。

---

## 2. executor 一覧

| executor | モデル | 指定するもの | 主な用途 |
| --- | --- | --- | --- |
| `shared-iterations` | 閉 | `vus`, `iterations` | 決まった件数を処理（バッチ検証） |
| `per-vu-iterations` | 閉 | `vus`, `iterations` | 各 VU が同じ回数だけ実行（公平な比較） |
| `constant-vus` | 閉 | `vus`, `duration` | 定常負荷 |
| `ramping-vus` | 閉 | `stages`, `startVUs` | 段階的に増減。最も一般的 |
| `constant-arrival-rate` | 開 | `rate`, `timeUnit`, `duration` | 一定 RPS を保証 |
| `ramping-arrival-rate` | 開 | `stages`（rate の target）, `preAllocatedVUs` | RPS を段階的に増やす |

> k6 v2.0 で `externally-controlled` executor は削除されました。手動での負荷調整が必要な場合は、`ramping-vus` と実行時間の分割で代替します。

> `vus` + `duration` だけ書いた場合、内部的には `constant-vus` 相当になります。
> `vus` + `iterations` は `shared-iterations` です。

---

## 3. 試験の種類

| 種類 | 目的 | 典型プロファイル | 合否の見方 |
| --- | --- | --- | --- |
| スモーク | スクリプトと環境の疎通 | 1〜2 VU / 1〜2 分 | エラー 0、check 100% |
| ロード | 想定ピークで SLO を満たすか | ピークまで ramp → 10〜30 分定常 | p95/p99、エラー率 |
| ストレス | 限界点と劣化の仕方 | 段階的に増やし続ける | どこで折れるか、回復するか |
| スパイク | 急増への耐性 | 数十秒で 10 倍 → 即戻す | エラー、復旧時間、オートスケール |
| ソーク | 長時間の安定性 | ピークの 50〜70% で 2〜8 時間 | メモリリーク、コネクション枯渇 |
| ブレークポイント | キャパシティ上限の特定 | 線形に増加、失敗まで | 飽和点の RPS |

**いきなりストレス試験をしない**。スモーク → ロード → ストレスの順で、前段が通ってから次へ進みます。

---

## 4. stages の読み方

```js
stages: [
  { duration: '2m', target: 50 },  // 2 分かけて 0 → 50 VU
  { duration: '10m', target: 50 }, // 10 分間 50 VU を維持
  { duration: '2m', target: 0 },   // 2 分かけて 0 に戻す
]
```

- `target` は「その stage 終了時の値」。現在値から線形補間される。
- ramp-up 中は**ウォームアップ**（コネクションプール、DNS、TLS セッション、アプリキャッシュ）が進む。判定は定常区間で行う。
- 終了時の `gracefulRampDown`（既定 30s）で実行中のイテレーションを待つ。

### VU が足りないとき

```
dropped_iterations: 1200   ← これが 0 でないなら負荷不足
```

- `preAllocatedVUs` を増やす（起動コストを先払い）
- `maxVUs` を増やす（必要時に追加生成。ただしメモリと CPU を使う）
- それでも足りない → **1 台で出せる負荷の限界**。分散実行を検討（第 7 章）

### k6 自身がボトルネックか確認する

```bash
k6 run --out json=... script.js
# 実行中の CPU 使用率が 1 コア 100% に張り付いていないか
```

k6 は VU あたりのメモリと CPU を使います。高 RPS では `discardResponseBodies: true`、check の削減、`http.batch` の活用で軽くなります。

---

## 5. 複数シナリオ

1 つのテストで「閲覧」「検索」「購入」を別々の負荷で動かせます。

```js
export const options = {
  scenarios: {
    browse: {
      executor: 'constant-vus',
      vus: 30,
      duration: '10m',
      exec: 'browse',            // 実行する関数名
      tags: { scenario: 'browse' },
    },
    search: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      stages: [
        { target: 30, duration: '5m' },
        { target: 30, duration: '5m' },
      ],
      preAllocatedVUs: 30,
      maxVUs: 100,
      exec: 'search',
    },
  },
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<800'],
    'http_req_duration{scenario:search}': ['p(95)<400'],
  },
};

export function browse() { /* ... */ }
export function search() { /* ... */ }
```

- `exec` を省略すると `default` が使われます。
- `startTime: '2m'` で開始をずらせる（ウォームアップ後に本命を開始する等）。
- `scenario` タグは自動付与されるので、threshold の絞り込みに使えます。
- シナリオごとに `gracefulStop` を設定可能。

### arrival-rate では sleep を入れない

開いたモデルでは到着率が主役です。`sleep` を入れると VU を無駄に占有し、`dropped_iterations` の原因になります。待ち時間を模したい場合は、対象 API の応答時間に任せるか、閉じたモデルを選びます。

---

## 6. サンプル

| ファイル | 内容 |
| --- | --- |
| [`ramping-vus.js`](ramping-vus.js) | ロードテストの王道。ramp-up → 定常 → ramp-down |
| [`arrival-rate.js`](arrival-rate.js) | 開いたモデル。RPS を段階的に増やし限界を探る |
| [`mixed-scenarios.js`](mixed-scenarios.js) | 3 シナリオ同時実行 + シナリオ別しきい値 |

```bash
k6 run 03-load-profiles/ramping-vus.js
k6 run 03-load-profiles/arrival-rate.js
k6 run 03-load-profiles/mixed-scenarios.js
```

---

## 7. 設計チェックリスト

- [ ] 目的は「SLO を満たすか」「限界はどこか」「長時間もつか」のどれか
- [ ] 閉じた/開いたモデルを意識して選んだ
- [ ] ピーク値の根拠がある（現状ピーク、事業計画、ログ集計）
- [ ] ramp-up と判定区間を分けた
- [ ] `dropped_iterations` を監視している
- [ ] 負荷試験中の k6 側リソースを確認した
- [ ] 試験後に負荷を 0 に戻す stage がある

---

## 次章

→ [04. テストデータと認証](../04-data-and-auth/README.md)
