# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

Docker Desktop is the only hard prerequisite for running the stack:

```bash
./setup.sh          # or .\setup.ps1 on Windows — generates secrets into .env*
docker compose --env-file .env.docker up -d
```

That runs the **local Docker backend** (`EXECUTOR=docker`), which works on any modern host. See
[DEMO.md](./DEMO.md) for the guided version.

For API work without Docker, you need Node 20+ and a PostgreSQL you can point `DATABASE_URL` at:

```bash
npm install
npx prisma migrate dev
npm run dev         # tsx watch, port 4000
```

The frontend is independent:

```bash
cd web && npm install && npm run dev    # port 3000
```

## Before you open a PR

Both packages must typecheck and build. CI runs exactly this:

```bash
npx prisma generate && npm run typecheck && npm run build
cd web && npm run build
```

If you touched the execution path, run the end-to-end suite too. It drives the real HTTP surface —
auth, queue, poll to terminal, artifact download, and the Postgres rows:

```bash
docker compose --env-file .env.docker up -d
bash scripts/e2e.sh
```

It exits non-zero on the first failed assertion, and prints a pass/fail line per assertion.

## Working on Judge0 specifically

Judge0 1.13.x requires a **cgroup v1** host. On cgroup v2 (Docker Desktop, WSL2, and every modern
Linux distro) `isolate` cannot build its jails and every submission returns `Internal Error`. This
is not a bug in this project — it is why the Docker backend exists.

The README has a full runbook for getting a cgroup v1 host under WSL2, including the boot-ordering
trick that makes it work. Once you have one:

```bash
docker compose --env-file .env.judge0 --profile judge0 up -d
ENV_FILE=.env.judge0 bash scripts/e2e.sh
```

## Conventions

- **TypeScript strict**, no `any` where a real type will do.
- **Comments explain *why*, not *what*.** The existing code leans heavily on this — a comment that
  restates the line below it will get flagged in review. Comments that capture a non-obvious
  constraint, a race, or a decision you had to reason about are exactly what's wanted.
- **Never commit secrets.** `.env`, `.env.docker`, `.env.judge0`, and `deploy/judge0.conf` hold
  generated credentials and are gitignored. Edit the `*.example` / `*.template` files instead.
- Keep migrations additive where you can, and describe destructive ones in the migration file
  itself — `20260813000000_generic_execution_engine` is the model to follow.

## Reporting security issues

Please don't use the public issue tracker. See [SECURITY.md](./SECURITY.md).
