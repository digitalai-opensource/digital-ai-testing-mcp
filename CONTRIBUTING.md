# Contributing to digital-ai-testing-mcp

## Commit Messages

This repo follows the [Conventional Commits](https://www.conventionalcommits.org/) specification.

**Format:** `type(optional-scope): short description`

| Type | When to use |
|------|-------------|
| `feat` | New tool or feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `ci` | CI/CD workflow changes |
| `chore` | Maintenance, dependency updates |
| `refactor` | Code restructure, no behavior change |
| `test` | Adding or updating tests |
| `perf` | Performance improvement |

**Breaking changes:** add `!` after the type and a `BREAKING CHANGE: <what changed>` footer — e.g. `feat!: rename list_devices tool`. (Releases are cut when the `version` in `package.json` changes; commit types don't set the version.)

## Pull Request Process

1. Branch off `main` — `git checkout -b type/short-description`
2. Commit using Conventional Commits format above
3. Push and open a PR targeting `main`
4. CI must pass before merging. CI runs lint, typecheck and build only, so run the tests locally too (see below)
5. At least 1 approval required (use admin bypass for solo work)
6. Delete the branch after merging

## Local Development

Requires Node.js 22 or later.

```bash
npm install
npm run dev                  # live reload (tsx watch)
npm run build                # compile TypeScript — must pass before committing
npm run lint                 # ESLint — must pass before committing
npm run typecheck            # TypeScript check only
npm test                     # every tests/**/*.test.ts — API suites need a populated .env; unit suites run offline
npm run test:tools           # tool-layer guard/gate tests — in-memory transport, no credentials needed
npm run test:<suite>         # one suite (see the scripts in package.json)
npm run test:live            # live API-behaviour probes (tests/live) — not part of npm test; run before a release
npm run test:fidelity-score  # check the agent fidelity eval's scenarios and scorer (no model calls)
npm run test:fidelity        # agent fidelity eval — spends model tokens; see tests/fidelity/README.md
npm run remediation:digest   # summarise debug-mode remediation notes (see README "Debug mode")
```

See `.env.example` for required environment variables.

## Adding a Tool

1. Put the API call in `src/api/<domain>.ts` (throw `Error` on failure) and register the tool in `src/tools/<domain>-tools.ts` (catch and return `isError: true`).
2. Add the name to `REGISTERED_TOOLS` in `src/tools/meta-tools.ts` — a test fails if the list and the registrations drift apart.
3. Destructive tools use `checkDestructiveGuard(confirmDeletion, …)`; tools that read or write local files use `validateInputPath` / `validateOutputPath`. Add a handler-level case for any guard or gate to `tests/tools.test.ts`.
4. Verify against the live API any parameter you send and any response field you map — don't assume the platform honours it.
5. Add a row to `docs/tools.md`, and update the README if the change is user-visible.
