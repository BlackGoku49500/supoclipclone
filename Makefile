MODEL_DIR ?= data/models/whisper-base
PYTHON ?= python3

.PHONY: up down model check test test-e2e
up:
	docker compose up --build -d
down:
	docker compose down
model:
	$(PYTHON) worker/model.py "$(MODEL_DIR)"
check:
	npm run lint
	npm run check
test:
	npm run test:brain
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v
test-e2e:
	npm run build
	SUPO_MODEL_DIR="$${SUPO_MODEL_DIR:-$(abspath $(MODEL_DIR))}" npm run test:http
