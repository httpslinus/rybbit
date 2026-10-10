# Coolify deployment

Coolify builds `docker-compose.coolify.yml` from this repository's `master` branch. A signed GitHub push webhook triggers deployments.

The application contains the API, dashboard, and an internal Nginx proxy. PostgreSQL, ClickHouse, and Redis remain in the existing Coolify storage service (`ngf5qoiio1rvzlp5cyg99spg`). Their data directories are not part of this application's lifecycle.

The backend reads credentials from `/srv/rybbit/credentials/backend.env` on cyberia. Keep that file, all other credentials, and database backups out of Git. The public HTTPS proxy forwards to the application's localhost port 18032; it also retains the temporary Umami compatibility routes.

The backend entrypoint runs PostgreSQL migrations, and startup applies ClickHouse schema updates. Back up both databases before deploying schema changes. The initial migration backup is stored at `/srv/backups/rybbit/pre-fork-20261010` and copied to ssh-sys.

The Umami importer preservation changes are built from source in this fork. Do not mount the old compiled importer overrides into the new application.

The dashboard footer links to this fork's source. Keep the deployed commit available in the repository, together with its build files and AGPL license.
