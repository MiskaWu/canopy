.PHONY: all web bin install status uninstall clean

# ── 腳印清單（機器上屬於 canopy 的東西，install／status／uninstall 都照這張表）──
#   1. ./canopy            binary（build 產物，住在 repo 裡，ExecStart 直接指這裡）
#   2. $(UNIT_DST)         systemd user unit 複本（repo 的 deploy/ 是源）
#   3. canopy.service      enable 註冊（開機自啟）
# 設定與狀態目錄：無。反安裝＝uninstall（拆服務）＋ clean（拆 build 產物）。

UNIT_SRC := deploy/canopy.service
UNIT_DST := $(HOME)/.config/systemd/user/canopy.service

all: web bin

web:
	cd web && npm run build
	rm -rf server/dist && cp -r web/dist server/dist

bin:
	go vet ./... && go build -o canopy ./server

install: all
	cp $(UNIT_SRC) $(UNIT_DST)
	systemctl --user daemon-reload
	systemctl --user enable canopy 2>/dev/null || true
	systemctl --user restart canopy

status:
	@test -x canopy && echo "ok    binary ./canopy（$$(stat -c %y canopy | cut -d. -f1) build）" || echo "缺    binary —— 跑 make"
	@if [ ! -f $(UNIT_DST) ]; then echo "缺    unit 複本 $(UNIT_DST) —— 跑 make install"; \
	elif cmp -s $(UNIT_SRC) $(UNIT_DST); then echo "ok    unit 複本與 repo 一致"; \
	else echo "⚠     unit 複本與 repo 分岔 —— diff $(UNIT_SRC) $(UNIT_DST) 看是哪邊新"; fi
	@echo "服務  $$(systemctl --user is-active canopy 2>/dev/null || echo '?')（$$(systemctl --user show canopy --property=UnitFileState --value 2>/dev/null)）"
	@curl -s -m 3 -o /dev/null -w '面板  HTTP %{http_code} @ 127.0.0.1:7777\n' http://127.0.0.1:7777/ 2>/dev/null || echo "面板  沒回應（服務沒起或埠不對）"

uninstall:
	-systemctl --user disable --now canopy 2>/dev/null
	rm -f $(UNIT_DST)
	systemctl --user daemon-reload
	@echo "服務已拆。build 產物還在 repo 裡，要清跑 make clean。"

clean:
	rm -rf canopy server/dist web/dist
