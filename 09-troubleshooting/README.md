# 09. トラブルシューティング

症状から引ける形でまとめます。まずは**1 VU / 1 iteration で再現**させるのが原則です。

```bash
k6 run --vus 1 --iterations 1 script.js
k6 run --http-debug="full" script.js
k6 inspect script.js          # 実行せず設定を確認
k6 archive script.js -O out.tar # 実行環境を丸ごと固める
```

---

## 1. 起動・構文エラー

| メッセージ | 原因 | 対処 |
| --- | --- | --- |
| `k6: command not found` | 未インストール / PATH | `brew install k6`、Docker を使う |
| `Cannot find module 'k6/...'` | バージョン違い（experimental → stable） | 対象バージョンのドキュメントでパスを確認 |
| `couldn't load JS module` | import パス誤り / 相対パス | 拡張子とパスを確認。jslib は URL で import |
| `SyntaxError: Unexpected token 'export'` | CommonJS 前提のコード | k6 は ES modules。`module.exports` は使わない |
| `only supported in the init context` | `open()` を default 内で呼んだ | init（トップレベル）へ移動 |
| `http.get is not a function` | import 漏れ | `import http from 'k6/http'` |
| `options.stages` が効かない | executor と併用 | `scenarios` と `stages` を混在させない |
| `unsupported executor` | 名前の typo | `constant-arrival-rate` 等、綴りを確認 |

### `open()` のパス

`open('./data/users.csv')` は**スクリプトファイルからの相対パス**です。実行時のカレントディレクトリではありません。

---

## 2. ネットワーク・TLS

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `dial tcp: lookup ... no such host` | DNS | `dig` / `nslookup` で確認。VPN、コンテナの DNS |
| `connection refused` | ポート違い / 起動していない | `curl -v` で同じ URL を確認 |
| `i/o timeout` / `context deadline exceeded` | ファイアウォール / SG / タイムアウト | `timeout` を延ばす前に経路を確認 |
| `x509: certificate signed by unknown authority` | 自己署名 / 社内 CA | `options.insecureSkipTLSVerify: true`（**検証環境のみ**） |
| `remote error: tls: handshake failure` | TLS バージョン / SNI | サーバー設定を確認 |
| `EOF` / `connection reset by peer` | サーバー側の接続上限、LB の idle timeout | keep-alive 設定、`--no-vu-connection-reuse` で切り分け |
| プロキシ環境で外に出られない | プロキシ未設定 | `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` を設定 |
| `status 0` | ネットワークエラー（HTTP レスポンスなし） | `res.error` / `res.error_code` を確認 |

```js
// 検証環境のみ
export const options = { insecureSkipTLSVerify: true };
```

### 接続再利用の切り分け

```bash
# 同一 VU のイテレーション間で接続を再利用しない（挙動が変わるか確認）
k6 run --no-vu-connection-reuse script.js

# 全リクエストで新規接続
k6 run --no-connection-reuse script.js
```

差が出るなら、サーバー/LB の keep-alive かコネクションプールが原因です。

---

## 3. 認証・HTTP ステータス

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| 全部 401 | トークン未設定 / 期限切れ | `__ENV` を確認、VU ごと再ログイン |
| 全部 403 | WAF / 権限 / User-Agent | 許可リスト、専用アカウント |
| 429 多発 | レート制限 | 負荷を下げる、専用枠を確保、`Retry-After` を尊重 |
| 302 が返る | リダイレクト未追従 / 認証リダイレクト | `redirects: 0` で確認、Cookie を確認 |
| 400 が返る | Content-Type / ボディ形式 | `--http-debug="full"` で送信内容を確認 |
| 5xx が増える | サーバー過負荷 | 負荷を下げて再現、サーバーログを確認 |

```js
// 期待するステータスを明示（4xx を失敗扱いしない）
http.setResponseCallback(http.expectedStatuses(200, 201, 404));
```

`http_req_failed` は既定で 2xx 以外を失敗にします（3xx も失敗扱い）。「404 は正常」「302 を成功扱い」という API では上記で調整します。

---

## 4. 負荷がかからない・意図と違う

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `dropped_iterations` > 0 | VU 不足 | `preAllocatedVUs` / `maxVUs` を増やす |
| RPS が上がらない | sleep、逐次処理、VU 上限 | think time を見直す、arrival-rate を使う |
| VU が増えない | `stages` の target 誤り | `k6 inspect` で確認 |
| 1 VU だけで異常に速い | `sleep` なし | 思考時間を入れる |
| テストがすぐ終わる | `iterations` 指定 | `duration` と executor を確認 |
| 終了に時間がかかる | `gracefulStop` / `gracefulRampDown` | 既定 30s。必要に応じて短縮 |
| 到着率が維持できない | k6 側の CPU/メモリ不足 | VU 削減、`discardResponseBodies`、分散実行 |

---

## 5. 結果がおかしい・毎回違う

| 症状 | 確認すること |
| --- | --- |
| 数値がばらつく | 同時ジョブ、キャッシュ状態、データ量、外部依存 |
| 初回だけ遅い | ウォームアップ不足。判定区間を後ろにずらす |
| 時間とともに悪化 | メモリリーク、コネクション/FD 枯渇、GC |
| サーバーは余裕なのに遅い | k6 側のボトルネック、ネットワーク、プロキシ |
| p95 は良いが p99 が悪い | 一部の重いリクエスト、ロック、GC スパイク |
| エラー 0 なのに check が失敗 | ステータスは 200 だがボディが不正 |
| 前回と条件が違う | k6 バージョン、データ、インスタンス、設定 |

### k6 自身がボトルネックか

```bash
# 実行中の CPU / メモリを見る
k6 run --out json=results.json script.js
# 別ターミナルで
top -pid $(pgrep -n k6)
```

- 1 コアが 100% に張り付く → VU を減らす、check を減らす、`discardResponseBodies: true`
- メモリが増え続ける → レスポンスボディを保持していないか確認

---

## 6. しきい値・CI

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| exit code 99 | しきい値違反 | サマリの ✗ を確認。意図した違反か切り分け |
| CI でだけ落ちる | 環境差、Secrets、ネットワーク | ランナーから `curl`、`-e` の渡し方を確認 |
| ログにトークンが出る | `set -x` / `console.log` | デバッグ出力を削除、マスク |
| テストがタイムアウト | 負荷過多 | `timeout-minutes`、スモークと分離 |
| `handleSummary` で画面が空 | `stdout` を返していない | `textSummary` を返す |
| レポートが出ない | ディレクトリ未作成 | `mkdir -p reports` |

---

## 7. デバッグの順序（推奨）

1. **1 VU / 1 iteration** で動かす
2. `--http-debug="full"` でリクエスト/レスポンスを見る
3. 同じリクエストを `curl` で再現する（k6 か環境か切り分け）
4. `k6 inspect` で options を確認
5. ネットワーク（DNS / ポート / TLS / プロキシ）を確認
6. サーバーログ・APM を確認
7. 負荷を 10% に落として再現する
8. `k6 archive` で実行環境を固定し、他者と共有する

```bash
# 再現性のためのアーカイブ（スクリプト + データ + 設定）
k6 archive -O test.tar script.js
k6 run test.tar
```

---

## 8. それでも分からないとき

- `k6 version` と実行環境（OS / Docker / CI）を記録
- 最小再現スクリプトを作る（10 行程度）
- サーバー側の該当時刻のログ・メトリクスを集める
- 公式フォーラム / GitHub Issues を検索（エラーメッセージをそのまま）
- Grafana Cloud k6 のサポートに問い合わせる（有償）

---

## 次章

→ [早見表](../docs/cheatsheet.md)
