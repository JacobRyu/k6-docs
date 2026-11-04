# 04. テストデータと認証

この章のゴール:

1. 環境変数で設定と認証情報を分離できる
2. CSV / JSON のテストデータをメモリ効率よく扱える
3. トークン認証・Cookie セッション・Basic 認証を実装できる
4. データの一意性と後始末を設計できる

---

## 1. 環境変数

```js
const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const USER = __ENV.USERNAME;
```

```bash
k6 run -e BASE_URL=https://staging.example.com -e USERNAME=loadtest script.js
```

**バージョンによる違い**: v2 では `--include-system-env-vars` が既定で有効なため、シェルの環境変数も `__ENV` に入ります（v1 は既定で無効）。ただし、どの環境でも同じように動くよう **`-e` で明示的に渡す**のを推奨します。全環境変数を渡す設定は、秘密情報の漏えいリスクがあるため本番では無効化してください（`--include-system-env-vars=false`）。

`.env` を読みたい場合は Makefile や CI の env 機能で読み込みます。ただし v2 は `--include-system-env-vars` が既定 true なので、**必要な変数だけを `-e` で渡し**、全環境変数の取り込みは無効化してください。本リポジトリの Makefile は `--include-system-env-vars=false` を付けて実行します。

```make
-include .env
# BASE_URL は Makefile 内で既定値を設定し、各ターゲットで -e する
# USERNAME / PASSWORD は auth ターゲット内で -e する
```

```bash
make load   # BASE_URL と testid を渡す（認証情報は auth ターゲット）
```

### 秘密情報の扱い

| NG | OK |
| --- | --- |
| スクリプトにパスワード直書き | CI の Secrets / Vault / SSM から注入 |
| `.env` をコミット | `.gitignore` + `.env.example` |
| ログに `console.log(token)` | マスクする、出力しない |
| 本番の管理者アカウント | 専用の負荷試験用アカウント（最小権限） |

---

## 2. 認証パターン

### A. Bearer トークン（推奨: setup で 1 回取得）

```js
export function setup() {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  return { token: res.json('access_token') };
}

export default function (data) {
  http.get(`${BASE}/api/me`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
}
```

- 1 回のログインで済むので、認証エンドポイントへの負荷を避けられる。
- トークンの有効期限がテスト時間より短い場合は使えない。

### B. VU ごとにキャッシュ（有効期限が短い / ユーザーを分けたい）

```js
let token = null; // モジュールスコープは VU ごとに独立

export default function () {
  if (!token) token = login(); // 各 VU が初回だけログイン
  // ...
}
```

- ログイン回数 = VU 数。VU ごとに別ユーザーにできる。
- 401 が返ったら `token = login()` で再取得する。

### C. Cookie セッション

k6 は **VU ごとに独立した Cookie Jar** を持ちます。ログイン後の Set-Cookie は自動で保持・送信されます。

```js
export default function () {
  http.post(`${BASE}/login`, { user, pass }); // Set-Cookie が保存される
  http.get(`${BASE}/mypage`);                 // 自動で Cookie が付く
}
```

明示操作:

```js
const jar = http.cookieJar();
jar.set('https://example.com', 'session', 'abc');
jar.clear('https://example.com'); // ログアウト
```

### D. Basic 認証

```js
import encoding from 'k6/encoding';

const creds = encoding.b64encode(`${__ENV.USERNAME}:${__ENV.PASSWORD}`);

http.get(url, { headers: { Authorization: `Basic ${creds}` } });
```

---

## 3. テストデータ

### 小さなデータ（数百件まで）

```js
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', () => JSON.parse(open('./data/users.json')));
```

### CSV

```js
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';
import { SharedArray } from 'k6/data';

const users = new SharedArray('users', () => {
  const rows = papaparse.parse(open('./data/users.csv'), { header: true }).data;
  return rows.filter((u) => u.email); // 末尾の空行を除去
});
```

### SharedArray の意味

- **init で 1 回だけ**読み込み、全 VU で**共有**する（コピーしない）。
- 数千〜数十万行でもメモリを圧迫しにくい。
- 中身は読み取り専用。VU ごとに書き換えたい場合は `Array` + インデックス管理にする。
- コールバック内は決定的であること（乱数で並べ替えない）。

### 行の選び方

```js
import exec from 'k6/execution';

// 全 VU で重複しない通し番号
const idx = exec.scenario.iterationInTest % users.length;
const user = users[idx];
```

- `Math.random()` は**重複する**。ユーザー作成など一意性が必要な場面では通し番号を使う。
- `exec.vu.idInTest` は VU ごとの固定 ID。ユーザーを VU に固定したいときに。
- `__VU` / `__ITER` も使えるが、`k6/execution` の方が分散実行でも一意。

### 一意な値の生成

```js
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const unique = `loadtest-${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${randomString(6)}`;
```

メールアドレスなら `+` エイリアス（`user+load1@example.com`）も有効ですが、ドメイン側の制約を確認してください。

---

## 4. データの後始末

負荷試験は**データを作る**。放置するとゴミが溜まり、次回の結果にも影響します。

| 方法 | 例 |
| --- | --- |
| 専用テナント/環境 | `tenant=loadtest` を全リクエストに付与 |
| TTL / 定期削除 | テスト用レコードに `expires_at` を設定 |
| teardown で削除 | 少量なら `teardown()` で API 削除 |
| 冪等な再実行 | 同じ ID に upsert し、何度でも流せるように |

`teardown()` で数千件を消すのは現実的ではありません（1 VU で逐次実行）。**TTL か専用環境**が基本です。

---

## 5. 相関（Correlation）

「作成した ID を次のリクエストで使う」など、レスポンスに依存する処理です。

```js
const created = http.post(`${BASE}/items`, payload, params);
const id = created.json('id');

const detail = http.get(`${BASE}/items/${id}`, {
  tags: { name: 'GET /items/:id' }, // 集約のためテンプレート化
});
```

- 動的 URL は `name` タグでまとめる（第 2 章）
- 失敗時に `id` が `undefined` にならないよう、`check` してから次へ
- 抽出は `res.json('path.to.field')` が簡潔。複雑な HTML は正規表現か、そもそも API で代替

---

## 6. サンプル

| ファイル | 内容 |
| --- | --- |
| [`auth.js`](auth.js) | Bearer トークン、VU ごとのキャッシュ、401 再ログイン |
| [`data-driven.js`](data-driven.js) | CSV + SharedArray + 一意な ID |
| [`data/users.csv`](data/users.csv) | テスト用ユーザー一覧 |

```bash
# モック API は demo / demo でログインできる
k6 run 04-data-and-auth/auth.js

# 実環境
k6 run -e BASE_URL=https://staging.example.com \
       -e USERNAME=your-user -e PASSWORD=your-pass \
       04-data-and-auth/auth.js

k6 run 04-data-and-auth/data-driven.js
```

> `auth.js` は既定でモック API の `demo / demo` を使います。実環境では必ず `-e` で上書きしてください。
> 認証情報を渡さないまま本番 URL に向けると、全リクエストが 401 になり「性能は良いが全部失敗」という無意味な結果になります。

---

## 7. チェックリスト

- [ ] 秘密情報はスクリプトに入っていない
- [ ] 認証は「1 回ログイン」か「VU ごと」か意図を決めた
- [ ] 401/403 の再試行方針がある
- [ ] テストデータは一意に生成される
- [ ] 大量データは SharedArray を使っている
- [ ] 後始末（TTL / 専用環境）を設計した
- [ ] 本番データをそのまま使っていない

---

## 次章

→ [05. メトリクスとしきい値](../05-metrics-thresholds/README.md)
