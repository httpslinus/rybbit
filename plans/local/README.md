# Local Rybbit Docker instance

Dashboard: http://localhost:18033. Create a local account through Sign up on first use. The dashboard/API share this origin through Caddy, preserving browser authentication and API paths.

The application images build this checkout. ClickHouse, Postgres and Redis use dedicated `rybbit-local` volumes and containers; database ports are not published. Only the proxy binds `127.0.0.1:18033`. An existing unrelated Postgres container on host port 5432 is unaffected. Telemetry is disabled; signup is enabled; the backend uses one worker.

The local dashboard start wrapper also forwards its container-local `127.0.0.1:18033` to the backend. This lets server rendering reach the same build-time localhost API URL used by the host browser. It uses Node's standard HTTP module and does not change application source or publish another port.

Run commands from the repository root:

```sh
# Start or rebuild after source changes
docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml up -d --build

# Status
docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml ps

# Application logs
docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml logs --tail 100 backend client

# Stop; retain local data
docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml stop

# Remove containers/network; retain local data
docker compose --env-file plans/local/.env.local -p rybbit-local -f docker-compose.yml -f plans/local/compose.yaml down

# Health check
curl -fsS http://localhost:18033/api/health
```

`plans/local/.env.local` contains newly generated local-only authentication/database secrets, is Git-ignored, and has mode 0600. Keep it to preserve access to the local database volumes. Do not replace it with production credentials. Optional Mapbox and OpenRouter environment warnings are expected when no token is configured.

On a new checkout, generate this file before starting (never print generated secret values):

```sh
python3 - <<'PY'
from pathlib import Path
import secrets
p = Path('plans/local/.env.local')
if p.exists():
    raise SystemExit('Local env already exists; leaving it unchanged')
p.write_text('\n'.join([
    'BASE_URL=http://localhost:18033', 'DOMAIN_NAME=localhost',
    'BETTER_AUTH_SECRET=' + secrets.token_hex(32),
    'POSTGRES_PASSWORD=' + secrets.token_hex(24),
    'CLICKHOUSE_PASSWORD=' + secrets.token_hex(24),
    'REDIS_PASSWORD=' + secrets.token_hex(24),
    'DISABLE_SIGNUP=false', 'DISABLE_TELEMETRY=true',
    'CLUSTER_WORKERS=1', 'DEPLOYMENT=', 'LITE_DASHBOARD=false',
]) + '\n')
p.chmod(0o600)
PY
```

The standard backend entrypoint initializes the isolated local Postgres schema on startup, and the application initializes ClickHouse tables. No VPS or production database participates. Docker Engine 28.5.1 was available; the installed Compose supports the `!reset` override used to remove host database/application ports.
