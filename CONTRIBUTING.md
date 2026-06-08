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

**Breaking changes:** add `!` after the type — e.g. `feat!: rename list_devices tool`

## Pull Request Process

1. Branch off `main` — `git checkout -b type/short-description`
2. Commit using Conventional Commits format above
3. Push and open a PR targeting `main`
4. CI must pass before merging
5. At least 1 approval required (use admin bypass for solo work)
6. Delete the branch after merging

## Local Development

```bash
npm install
npm run dev        # live reload
npm run build      # compile TypeScript
npm run lint       # ESLint
npm run typecheck  # TypeScript check only
npm run test       # all tests (requires live .env credentials)
```

See `.env.example` for required environment variables.
