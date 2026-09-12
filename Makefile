BASEDIR := $(CURDIR)
SHELL := /bin/bash
PNPM ?= pnpm

.PHONY: help install build typecheck lint format format-check test check dev start clean version publish release

help: ## Show available targets
	@echo "Usage: make <target>"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies with pnpm
	$(PNPM) install

build: ## Compile TypeScript to dist/
	$(PNPM) build

typecheck: ## TypeScript type check (tsc --noEmit)
	$(PNPM) typecheck

lint: ## Run ESLint
	$(PNPM) lint

format: ## Format with Prettier (write)
	$(PNPM) format

format-check: ## Verify formatting with Prettier (no write)
	$(PNPM) format:check

test: ## Run the Vitest suite once
	$(PNPM) test

check: typecheck lint test ## Type check, lint and test

dev: ## Watch build (tsc --watch)
	$(PNPM) dev

start: build ## Build then run the Streamable HTTP server
	$(PNPM) start

clean: ## Remove build output
	rm -rf dist dist-test

version: ## Bump the patch version (no git tag)
	$(PNPM) version patch --no-git-tag-version

publish: build ## Publish the npm package
	$(PNPM) publish

release: check version publish ## Verify, bump version and publish
