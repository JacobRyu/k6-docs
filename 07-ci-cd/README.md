# 07. CI/CD への組込み

この章のゴール:

1. PR ごとに短い性能ゲートを回せる
2. 夜間に重い試験を回して回帰を検知できる
3. 結果を成果物として残し、判断を自動化できる
4. 大規模実行が必要になったときの選択肢を知る

---

## 1. 3 層に分ける

| 層 | タイミング | 時間 | 内容 | 失敗時の扱い |
| --- | --- | --- | --- | --- |
| スモーク | PR / push | 1〜3 分 | 1〜2 VU、主要 1〜2 エンドポイント | **マージブロック** |
| ロード | 夜間 / リリース前 | 10〜30 分 | 想定ピーク、しきい値判定 | チケット化・リリース判断 |
| ソーク/ストレス | 週次 / リリース前 | 1〜8 時間 | 長時間・限界点 | 計画的に対応 |

**PR で重い試験を回さない**。遅くて不安定になり、やがて無視されます。PR は「壊れていないか」、夜間は「性能が劣化していないか」に分けます。

---

## 2. 合否は exit code で決める

```bash
k6 run script.js
# 0  : 成功
# 99 : しきい値違反
# その他: 実行エラー（スクリプト、接続、設定）
```

CI では「ログを人間が読む」のではなく、**しきい値で自動判定**します。

```yaml
- run: k6 run -e BASE_URL="$BASE_URL" 01-introduction/smoke.js
```

これだけで、しきい値違反時にジョブが失敗します。

---

## 3. GitHub Actions

実例: [`.github/workflows/k6.yml`](../.github/workflows/k6.yml)

```yaml
- uses: grafana/setup-k6-action@v1
- run: |
    mkdir -p reports
    k6 run -e BASE_URL="$BASE_URL" \
      --tag testid="smoke-$GITHUB_SHA" \
      --summary-export=reports/smoke-summary.json \
      01-introduction/smoke.js
  env:
    BASE_URL: ${{ vars.K6_BASE_URL }}
```

ポイント:

- **`grafana/setup-k6-action@v1`** で k6 を導入（バージョン固定も可能）。
- `grafana/run-k6-action@v1` を使うとレポート連携が楽。CLI 直実行なら env の扱いが明確。
- 秘密情報は `secrets`、非秘密の設定は `vars` に置く。
- `actions/upload-artifact@v4` で `reports/` を必ず保存（`if: always()`）。
- `timeout-minutes` を設定して暴走を防ぐ。
- `concurrency` で同一ブランチの重複実行をキャンセル。

### Secrets の渡し方

```yaml
- run: |
    k6 run \
      -e BASE_URL="$BASE_URL" \
      -e USERNAME="$K6_USER" \
      -e PASSWORD="$K6_PASS" \
      04-data-and-auth/auth.js
  env:
    BASE_URL: ${{ vars.K6_BASE_URL }}
    K6_USER: ${{ secrets.K6_USER }}
    K6_PASS: ${{ secrets.K6_PASS }}
```

> `-e` の値をログに出さないこと。`set -x` を有効にすると引数がそのまま出ます。
> v2 では `--include-system-env-vars` が既定で有効なため、指定しなければランナーの環境変数も `__ENV` に入ります。秘密情報を守るには `--include-system-env-vars=false` を付け、必要な値だけ `-e` で渡してください。

### 結果の比較（回帰検知）

k6 OSS には「前回との比較」機能がありません。実務では:

1. `summary.json` を保存し、前回の値を S3/Artifacts から取得
2. p95 が N% 悪化したら失敗、をスクリプトで判定
3. または Grafana Cloud k6 の比較機能を使う

```bash
jq '.metrics.http_req_duration.values["p(95)"]' reports/summary.json
```

しきい値（絶対値）だけだと「変化」を見逃すので、**絶対値 + 前回比**の両方を持つと強いです。

---

## 4. 分散実行

OSS の k6 は 1 プロセス。1 台で出せる負荷を超える場合:

| 方法 | 向く場面 |
| --- | --- |
| 複数台で手動実行（`--out` を同じ保存先へ） | 簡易。集計が面倒 |
| **k6 Operator**（Kubernetes） | 既に k8s がある。TestRun CRD で分散 |
| **Grafana Cloud k6** | 運用を任せたい。地理分散・大規模 |
| クラウド VM を複数立てる | 一時的な大規模試験 |

k6 Operator の例:

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: k6-load-test
spec:
  parallelism: 4          # 4 Pod に分割
  script:
    configMap:
      name: k6-script
      file: script.js
  arguments: -e BASE_URL=https://staging.example.com
```

> 分散すると VU は各 Pod に配分されます。**合計**が目標値になるように設計してください。
> 到着率モデルは Pod ごとに rate が設定されるため、`rate × parallelism` が総 RPS になります。

---

## 5. 失敗しやすいポイント

| 症状 | 原因 | 対策 |
| --- | --- | --- |
| PR が常に赤い | 共有 staging が不安定 | 専用環境、リトライではなくしきい値見直し |
| たまに落ちる（flaky） | ウォームアップ不足、外部依存 | ramp-up、`delayAbortEval`、依存のモック |
| 結果が毎回違う | データ量・キャッシュ・同時ジョブ | 環境を固定、実行を直列化 |
| 時間切れ | 負荷が重すぎる | スモークとロードを分離、`timeout-minutes` |
| 認証で落ちる | トークン期限切れ | 有効期限を確認、VU ごと再ログイン |
| 本番に誤爆 | URL の取り違え | 既定値を staging に、本番は明示的な承認ジョブ |

---

## 6. チェックリスト

- [ ] PR 用のスモークが 3 分以内に終わる
- [ ] しきい値が設定され、exit code で判定している
- [ ] 結果（summary.json / JUnit / ダッシュボード URL）を保存している
- [ ] Secrets を使い、ログに出していない
- [ ] `timeout-minutes` と `concurrency` を設定した
- [ ] 夜間試験の失敗が誰かに届く（通知・チケット）
- [ ] 本番向けは手動承認を挟んでいる

---

## 次章

→ [08. 本番運用プレイブック](../08-production-playbook/README.md)
