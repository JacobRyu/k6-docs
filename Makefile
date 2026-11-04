# よく使う実行コマンド。
# 認証情報は .env（git 管理外）に置く。必要な変数だけを -e で渡し、
# k6 には -e で明示的に渡す（v2 はシステム環境変数も __ENV に入るため）。
-include .env

BASE_URL ?= http://localhost:8080
K6 ?= k6
# v2 は --include-system-env-vars が既定 true。意図しない秘密情報を
# __ENV に入れないよう、Makefile 経由の実行では明示的に無効化する。
K6_RUN ?= $(K6) run --include-system-env-vars=false
REPORT_DIR ?= reports
RUN_ID ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
K6_PROMETHEUS_RW_SERVER_URL ?= http://localhost:9090/api/v1/write
K6_PROMETHEUS_RW_TREND_STATS ?= p(95),p(99),max

.PHONY: help mock smoke script auth load load-raw stress soak dashboard check stack-up stack-down prom otel-smoke clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

mock: ## モック API を起動（別ターミナルで実行）
	python3 mock/server.py

smoke: ## 最小構成の疎通確認（1 VU / 10s）
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" 01-introduction/smoke.js

script: ## スクリプト基礎のサンプル
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" 02-scripting/http-checks.js

auth: ## 認証付きシナリオ（モックは demo/demo）
	@if [ "$(BASE_URL)" != "http://localhost:8080" ] && { [ -z "$(USERNAME)" ] || [ -z "$(PASSWORD)" ]; }; then \
		echo "USERNAME/PASSWORD を .env か環境変数で指定してください（非ローカル環境）"; \
		exit 1; \
	fi
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" \
		-e USERNAME="$(if $(USERNAME),$(USERNAME),demo)" \
		-e PASSWORD="$(if $(PASSWORD),$(PASSWORD),demo)" \
		04-data-and-auth/auth.js

load: ## 想定負荷での試験（集計 JSON を保存）
	mkdir -p $(REPORT_DIR)
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" \
		--tag testid="$(RUN_ID)" \
		--summary-export=$(REPORT_DIR)/load-summary.json \
		03-load-profiles/ramping-vus.js

load-raw: ## 想定負荷 + 全サンプル JSON（容量に注意）
	mkdir -p $(REPORT_DIR)
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" \
		--tag testid="$(RUN_ID)" \
		--out json=$(REPORT_DIR)/load-raw.json \
		03-load-profiles/ramping-vus.js

stress: ## 開いたモデルで限界を探す（arrival-rate）
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" 03-load-profiles/arrival-rate.js

soak: ## 長時間試験（stages を編集して使う）
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" 03-load-profiles/ramping-vus.js

report: ## 集計レポート（summary.json / junit.xml）を生成
	mkdir -p $(REPORT_DIR)
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" -e RUN_ID="$(RUN_ID)" \
		06-results/summary.js

dashboard: ## Web ダッシュボード付きで実行
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" -o web-dashboard 03-load-profiles/ramping-vus.js

check: ## 全スクリプトの構文・設定を検証
	@for f in $$(find . -name '*.js' -not -path './node_modules/*' -not -path './reports/*'); do \
		$(K6) inspect "$$f" > /dev/null || exit 1; \
		echo "ok $$f"; \
	done

stack-up: ## Prometheus + Grafana + OTel Collector を起動
	cd 10-integrations/stack && docker compose up -d

stack-down: ## 連携スタックを停止
	cd 10-integrations/stack && docker compose down

prom: ## Prometheus remote write で負荷試験を実行
	K6_PROMETHEUS_RW_SERVER_URL="$(K6_PROMETHEUS_RW_SERVER_URL)" \
	K6_PROMETHEUS_RW_TREND_STATS="$(K6_PROMETHEUS_RW_TREND_STATS)" \
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" \
		--tag testid="local-$$(date +%s)" --tag environment=local \
		-o experimental-prometheus-rw 03-load-profiles/ramping-vus.js

otel-smoke: ## OTel Collector 経由でスモークテスト
	K6_OTEL_GRPC_EXPORTER_ENDPOINT=localhost:4317 \
	K6_OTEL_GRPC_EXPORTER_INSECURE=true \
	K6_OTEL_METRIC_PREFIX=k6_ \
	$(K6_RUN) -e BASE_URL="$(BASE_URL)" -o opentelemetry 01-introduction/smoke.js

clean:
	rm -rf $(REPORT_DIR)

docker-smoke: ## Docker で実行（バージョン固定）
	docker run --rm -i -e BASE_URL="$(BASE_URL)" grafana/k6:2.3.0 run - < 01-introduction/smoke.js
