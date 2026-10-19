# Coolify deployment

Coolify builds `docker-compose.coolify.yml` from this repository's `master` branch. A signed GitHub push webhook triggers deployments.

The application contains the API, dashboard, and an internal Nginx proxy. PostgreSQL, ClickHouse, and Redis remain in the existing Coolify storage service (`ngf5qoiio1rvzlp5cyg99spg`). Their data directories are not part of this application's lifecycle.

`BASE_URL` is the canonical API and authentication URL (`https://data.linus.systems`). The Coolify compose file also trusts `https://data.nullzwei.com` as a dashboard origin. Override `TRUSTED_ORIGINS` with a comma-separated list to configure additional origins; both CORS and Better Auth use this list alongside `BASE_URL`.

The dashboard is built with an empty `NEXT_PUBLIC_BACKEND_URL`. API and login requests use the opened dashboard's origin through Nginx, so each domain gets first-party session cookies. Keep this empty at build time and runtime; using the canonical domain here makes alias logins depend on third-party cookies.

Backend credentials are stored in the application’s Coolify environment variables, copied from the existing `/srv/rybbit/credentials/backend.env` on cyberia. Keep that file, all other credentials, and database backups out of Git. The public HTTPS proxy forwards to the application's localhost port 18032; it also retains the temporary Umami compatibility routes.

The backend entrypoint runs PostgreSQL migrations, and startup applies ClickHouse schema updates. Back up both databases before deploying schema changes. The initial migration backup is stored at `/srv/backups/rybbit/pre-fork-20261010` and copied to ssh-sys.

The Umami importer preservation changes are built from source in this fork. Do not mount the old compiled importer overrides into the new application.

The dashboard footer links to this fork's source. Keep the deployed commit available in the repository, together with its build files and AGPL license.
