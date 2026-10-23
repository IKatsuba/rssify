# Contributing

Read the [README](README.md#local-development) for local setup and [AGENTS.md](AGENTS.md) for repository rules. Install Bun and Docker, then:

```bash
bun install
bunx prisma generate
cp .env.example .env.local
docker compose up -d
bun --env-file=.env.local run prisma migrate dev
```

Configure local authentication as described in the README. Use local Postgres and synthetic fixtures; tests must not reach live services. Never commit credentials or copied live pages.

Generate route types on a fresh clone, then run the whole check before handing over your change:

```bash
bunx next typegen
bun run lint && bun run typecheck && bun run test
```

While editing, run the affected test file, for example `bun run test ./lib/auth.test.ts`. Tests use the local `rssify_test` database and truncate its tables, so avoid concurrent test runs. CI also runs `bun run build`.

Keep one change per pull request, on a branch of its own. Add tests for changed behavior and update affected docs. Use signed conventional commits such as `fix: handle an empty feed` or `docs: clarify local setup`, with no trailers. Describe the problem, the change, and the checks you ran in the PR.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
