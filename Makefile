CONTAINER := yena
# Allocate a TTY only when run from a terminal, so targets also work in scripts
EXEC      := docker exec -e YENA_LOG_LEVEL -e YENA_LOG -i $(shell [ -t 0 ] && echo -t) $(CONTAINER)

.DEFAULT_GOAL := help
.PHONY: help up down restart build rebuild ps logs yena start sh install typecheck test typecheck-modules test-modules check compile ensure-up claude

help: ## Show the list of commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

up: ## Start the container in the background
	docker compose up -d

# Start the container only if it is not already running
ensure-up:
	@docker ps -q --filter name=^$(CONTAINER)$$ | grep -q . || docker compose up -d

down: ## Stop and remove the container
	docker compose down

restart: ## Restart the container
	docker compose restart

build: ## Build the image
	docker compose build

rebuild: ## Rebuild the image and start the container
	docker compose up -d --build

ps: ## Container status
	docker compose ps

logs: ## Container logs
	docker compose logs -f

yena: ensure-up ## Run the app (dev, via tsx)
	$(EXEC) npm run dev

start: ensure-up ## Run the compiled app from dist/
	$(EXEC) npm start

sh: ensure-up ## Open a shell in the container
	$(EXEC) sh

install: ensure-up ## Install dependencies (npm install)
	$(EXEC) npm install

typecheck: ensure-up ## Check types
	$(EXEC) npm run typecheck

test: ensure-up ## Run the tests
	$(EXEC) npm test

typecheck-modules: ensure-up ## Check types of every module
	$(EXEC) npm run typecheck:modules

test-modules: ensure-up ## Run the tests of every module
	$(EXEC) npm run test:modules

check: typecheck test typecheck-modules test-modules ## Run type checks and tests (host and modules)

compile: ensure-up ## Compile TypeScript into dist/
	$(EXEC) npm run build

claude: ensure-up ## Run Claude Code in the container (arguments: make claude ARGS="...")
	@test -x modules/claude/bin/claude || { echo "The claude module is not installed: mod install git@github.com:hyenayena/claude.git"; exit 1; }
	$(EXEC) modules/claude/bin/claude $(ARGS)
