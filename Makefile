.PHONY: test typecheck

# canopy 是一個 Claude Code mod（mod/），repo 本身也是它的 marketplace（.claude-plugin/）。
# 沒有建置產物、沒有服務，裝法見 README。

# 測試要用 2.1.288 以上的 claude：更舊的測試工具不會把 userConfig 的值交給 mod。
# 預設的 claude 太舊時，指向別的執行檔：make test CLAUDE=/path/to/claude
CLAUDE ?= claude

test:
	$(CLAUDE) plugin validate . && $(CLAUDE) plugin validate mod && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 $(CLAUDE) plugin test mod

# 型別由引擎在載入 mod 時寫進 mod/.claude-plugin/types/，沒被載入過的那份（例如新開的 worktree）就沒有
typecheck:
	@test -f mod/.claude-plugin/types/tsconfig.json || { echo "這份 mod 沒被 Claude Code 載入過，沒有型別可查（見 CLAUDE.md 的驗證一節）"; exit 1; }
	npx --yes -p typescript@5.9 tsc -p mod
