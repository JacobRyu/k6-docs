# モック API

サンプルスクリプトの宛先です。Python 3.8 以上の標準ライブラリだけで動きます（追加インストール不要）。

```bash
python3 mock/server.py
# [mock] listening on http://127.0.0.1:8080
```

別ターミナルで:

```bash
curl http://localhost:8080/health
curl 'http://localhost:8080/api/products?limit=3'
```

- ポート変更: `PORT=9090 python3 mock/server.py`
- ログ抑制: `QUIET=1 python3 mock/server.py`
- 停止: `Ctrl-C`

## エンドポイント

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/health` | 死活確認 |
| GET | `/api/products?limit=N` | 商品一覧（最大 100） |
| GET | `/api/products/{id}` | 商品詳細（存在しなければ 404） |
| POST | `/api/products` | 商品作成（**Bearer 必須**） |
| POST | `/api/auth/login` | `{"username":"demo","password":"demo"}` → `access_token` |
| GET | `/api/me` | 認証ユーザー（**Bearer 必須**） |
| POST | `/api/session/login` | Cookie セッション開始 |
| GET | `/api/session/me` | Cookie で認証 |
| DELETE | `/api/session` | ログアウト |
| POST | `/api/orders` | 注文作成（201 を返す） |
| POST | `/api/echo` | 送信 JSON をそのまま返す |
| GET | `/api/slow?ms=500` | 指定時間待ってから 200（最大 5000ms） |
| GET | `/api/error?status=500` | 指定ステータスを返す（400〜599） |
| GET | `/api/flaky?fail_rate=0.1` | 指定確率で 503 |

## 認証の例

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo"}' | jq -r .access_token)

curl -s http://localhost:8080/api/me -H "Authorization: Bearer $TOKEN"
```

## 注意

- データはメモリ上のみ。再起動でリセットされます。
- 負荷試験用の簡易実装です。本番の代替ではありません。
- 障害・遅延の再現（`/api/error`、`/api/slow`、`/api/flaky`）は、しきい値や `abortOnFail` の動作確認に使えます。
- **負荷試験では `QUIET=1` を推奨**します。リクエストごとの stdout 出力は、高 RPS ではログ I/O がボトルネックになり測定を歪めます。
- アクセストークンは 1 時間で失効します（ログイン時に期限切れを掃除）。
- `ThreadingHTTPServer` のスレッド/コネクション型です。高 VU では**モック自体が飽和**するため、性能測定の対象にしないでください。
- 入力値は検証します（`limit` 1〜100、`ms` 0〜5000、`status` 400〜599、`fail_rate` 0〜1）。不正な値は 400 を返します。
