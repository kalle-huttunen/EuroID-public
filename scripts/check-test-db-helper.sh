#!/usr/bin/env bash
# check-test-db-helper.sh: fail when a backend spec starts its own in-memory MongoDB.
#
# Jest's globalSetup (backend/test/mongo-global-setup.ts) starts one MongoMemoryServer per run,
# and each suite takes its own database on it through backend/src/testing/test-db.ts (testDbUri,
# connectTestDb, closeTestDb). A spec that starts a server of its own pays the start-up again for
# every suite and brings back "Instance failed to start within 10000ms" on a loaded machine.
#
# Rule: no `MongoMemoryServer.create` or `new MongoMemoryServer` in a *.spec.ts or *.e2e-spec.ts
# under backend/, except in backend/src/testing/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HITS="$(cd "$REPO_ROOT" && grep -rlE 'MongoMemoryServer\.create|new MongoMemoryServer\b' \
  --include='*.spec.ts' --include='*.e2e-spec.ts' --exclude-dir=node_modules --exclude-dir=dist \
  backend | grep -v '^backend/src/testing/' | sort || true)"

if [[ -n "$HITS" ]]; then
  echo "$HITS" >&2
  echo "" >&2
  echo "These specs start their own in-memory MongoDB. Use testDbUri(), connectTestDb() and" >&2
  echo "closeTestDb() from backend/src/testing/test-db.ts (backend/docs/TESTING.md, In-Memory" >&2
  echo "Database): the run's globalSetup starts one server for every suite." >&2
  exit 1
fi

echo "OK: no spec starts its own in-memory MongoDB"
