# Vibeworks · common commands. Run `make` to list them.
#
# `make dev` serves the app on ordinary localhost and runs the modeling bridge beside it.
# Portless is optional: use `make dev-portless` or `make preview-portless` for named HTTPS URLs.
# Ctrl+C stops the processes started by that target.

SHELL := /bin/bash
NAME ?= vibeworks
VIBEWORKS_BRIDGE_PORT ?= 4318
VIBEWORKS_WEB_PORT ?= 5173
export VIBEWORKS_BRIDGE_PORT VIBEWORKS_WEB_PORT
NODE ?= $(shell command -v node)
export PATH := $(CURDIR)/node_modules/.bin:$(PATH)

.DEFAULT_GOAL := help
.PHONY: help install renderer-install dev dev-plain dev-web dev-portless preview preview-portless url check typecheck test build demo demo-mechanical inspect tools doctor mcp-config headless verify-headless clean

help: ## List commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the exact locked dependencies
	pnpm install --frozen-lockfile

renderer-install: node_modules ## Install Chromium for images, GLB and browser checks (ARGS=--with-deps on Linux)
	pnpm run renderer:install $(ARGS)

node_modules: package.json pnpm-lock.yaml pnpm-workspace.yaml
	pnpm install --frozen-lockfile
	@touch node_modules

dev: node_modules ## App at http://127.0.0.1:5173 + modeling bridge; Ctrl+C stops both
	pnpm run dev

dev-plain: dev ## Alias for make dev

dev-web: node_modules ## Run only the web UI beside an existing headless service
	pnpm run dev:web

dev-portless: node_modules ## Optional: named HTTPS app URL through an existing portless installation
	@command -v portless >/dev/null || { echo "Portless is optional. Install it separately or use make dev."; exit 1; }
	@url=$$(portless get $(NAME)) && echo "Vibeworks: $$url  ·  bridge: http://127.0.0.1:$(VIBEWORKS_BRIDGE_PORT)  ·  Ctrl+C stops both" && \
	VIBEWORKS_WEB_ORIGIN=$$url concurrently --kill-others --names bridge,web --prefix-colors blue,green \
		"tsx src/bridge/server.ts" "portless $(NAME) vite"

preview: build ## Build and serve the production UI at http://127.0.0.1:5173 + modeling bridge
	concurrently --kill-others --names bridge,web --prefix-colors blue,green \
		"tsx src/bridge/server.ts" "vite preview"

preview-portless: build ## Optional: production preview through an existing portless installation
	@command -v portless >/dev/null || { echo "Portless is optional. Install it separately or use make preview."; exit 1; }
	@url=$$(portless get $(NAME)) && echo "Vibeworks (production build): $$url" && \
	VIBEWORKS_WEB_ORIGIN=$$url concurrently --kill-others --names bridge,web --prefix-colors blue,green \
		"tsx src/bridge/server.ts" "portless $(NAME) vite preview"

url: ## Optional: print the app's portless URL
	@portless get $(NAME)

check: typecheck test build ## Typecheck, unit/kernel tests and production build

typecheck: node_modules ## TypeScript check
	pnpm run typecheck

test: node_modules ## Node tests (protocol, edits, parameters, real OCCT kernel)
	pnpm test

build: node_modules ## Typecheck and production bundle into dist/
	pnpm run build

headless: node_modules ## Node geometry authority, SQLite and automatic output renderer; no human tab
	pnpm run headless

verify-headless: node_modules ## Verify the headless workflow in an isolated workspace
	pnpm run verify:headless $(ARGS)

demo: node_modules ## Acceptance plate over MCP against the Node authority (ARGS=--reset replaces its document)
	pnpm run demo:mcp $(ARGS)

demo-mechanical: node_modules ## Bracket and shaft workflow over MCP (ARGS=--reset replaces its document)
	pnpm run demo:mechanical $(ARGS)

inspect: node_modules ## Show the connected document via the CLI (needs make headless or make dev)
	@pnpm --silent run cad inspect_model

doctor: node_modules ## Diagnose Node workers, renderer, queue and contract versions
	@pnpm --silent run cad doctor

tools: node_modules ## List the CLI/MCP tools; run one with: pnpm --silent run cad <tool> '<json>' --latest
	@pnpm --silent run cad tools

mcp-config: ## Print session-only Codex/Claude launch commands with CAD tools approved
	@echo "Claude Code (this session only):"
	@echo "  claude --strict-mcp-config --mcp-config '{\"mcpServers\":{\"cad\":{\"type\":\"stdio\",\"command\":\"$(NODE)\",\"args\":[\"--import\",\"$(CURDIR)/node_modules/tsx/dist/loader.mjs\",\"$(CURDIR)/src/bridge/mcp.ts\"]}}}' --allowedTools 'mcp__cad__*'"
	@echo "Codex (this invocation only):"
	@echo "  codex -C \"$(CURDIR)\" -c 'mcp_servers.cad.command=\"$(NODE)\"' -c 'mcp_servers.cad.args=[\"--import\",\"$(CURDIR)/node_modules/tsx/dist/loader.mjs\",\"$(CURDIR)/src/bridge/mcp.ts\"]' -c 'mcp_servers.cad.tool_timeout_sec=70' -c 'mcp_servers.cad.default_tools_approval_mode=\"approve\"'"

clean: ## Remove the production bundle
	rm -rf dist
