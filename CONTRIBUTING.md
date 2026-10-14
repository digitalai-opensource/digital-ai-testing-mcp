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
4. CI must pass before merging. CI runs lint, typecheck, build and the offline test project; the live API project (`npm run test:api`) only runs locally, so run it before a release
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
npm test                     # both projects below — needs a populated .env for the api project
npm run test:offline         # tests/*.test.ts — unit and handler suites against stub servers; no .env; this is what CI runs
npm run test:api             # tests/api/*.test.ts — integration suites against the live tenant (needs .env); a test that
                             #   finds no data to assert on reports as SKIPPED, never as a silent pass
npm run test:tools           # tool-layer guard/gate tests — in-memory transport, no credentials needed
npm run test:<suite>         # one suite (see the scripts in package.json)
npm run test:live            # live API-behaviour probes (tests/live) — not part of npm test; run before a release
npm run test:fidelity-score  # check the agent fidelity eval's scenarios and scorer (no model calls)
npm run test:fidelity        # agent fidelity eval — spends model tokens; see tests/fidelity/README.md
npm run remediation:digest   # summarise debug-mode remediation notes (see README "Debug mode")
```

See `.env.example` for required environment variables.

Text files are stored and checked out with LF line endings (`.gitattributes`); Windows script formats (`.ps1`, `.bat`, `.cmd`) keep CRLF.

## Adding a Tool

1. Put the API call in `src/api/<domain>.ts` (throw `Error` on failure) and register the tool in `src/tools/<domain>-tools.ts` (catch and return `isError: true`).
2. Add the name to `REGISTERED_TOOLS` in `src/tools/meta-tools.ts` — a test fails if the list and the registrations drift apart. A new tool module (a new `src/tools/*-tools.ts` file) must also be assigned to exactly one toolset in `TOOLSETS` (`src/utils/toolsets.ts`).
3. Destructive tools use `checkDestructiveGuard(confirmDeletion, …)` and never set `isError` on the guard response. Tools that read or write local files use `validateInputPath` / `validateOutputPath`, and build their descriptions with the deployment-mode helpers in `src/utils/locality.ts` (npm and Docker differ in whose filesystem the path is on). Add a handler-level case for any guard or gate to `tests/tools.test.ts`.
4. Never infer privilege from the access key's format. Role comes from the platform (`src/api/access-level.ts`); in tests, set it with `actAs(level)`.
5. Verify against the live API any parameter you send and any response field you map — don't assume the platform honours it. Add a probe to `tests/live/api-behavior.live.ts` (`npm run test:live`).
6. Add a row to `docs/tools.md`, and update the README if the change is user-visible. If you add a test file, add a `test:<suite>` script for it in `package.json`.
7. Put every test in the file for its functional area — never in a file named after a date, a UAT run or a batch of fixes (those grow without bound and nobody can find the test for a given tool). `tests/<area>.test.ts` hits the live API through `tests/helpers/test-client.ts`; `tests/<area>-tools.test.ts` (and the other offline suites) run handlers against a stub server via `tests/helpers/offline.ts` (`startStubApi` + `connectTools`) — use that harness instead of hand-rolling an `http.createServer` + `InMemoryTransport` setup. A regression found in UAT goes next to the tool it concerns, with the finding noted in the test name or a comment.
