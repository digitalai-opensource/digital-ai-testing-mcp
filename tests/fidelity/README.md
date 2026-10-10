# Fidelity eval

Checks that an AI agent uses this MCP **correctly from a plain user goal**: right tools, right order, no fabricated
selectors, no unconfirmed destructive or public actions. It also checks that this still holds when `MCP_TOOLSETS`
trims the tool list.

It complements the scripted UAT (`docs/uat-test-suite.md`). The UAT names every tool and parameter, so it tests that
tools *behave* correctly. This eval never names a tool, so it tests whether the agent *chooses* correctly — which is
where tool descriptions and server instructions do their work.

## Run

```bash
npm run test:fidelity                                  # every scenario, modes "all" and "core"
npm run test:fidelity -- --only login-test-no-source   # one scenario
npm run test:fidelity -- --modes all,reporting --runs 3 --model sonnet
npm run test:fidelity -- --rescore fidelity-results/<timestamp>   # re-score saved transcripts, no model calls
```

| Option | Default | Meaning |
|---|---|---|
| `--modes` | `all,core` | `all` = `MCP_TOOLSETS` unset (full descriptions). Any other value is passed as `MCP_TOOLSETS` (`core` = only the always-loaded core in full; every other tool is a one-line placeholder) |
| `--only` | every scenario | Comma-separated scenario ids (see `scenarios.ts`) |
| `--runs` | `1` | Repeats per scenario × mode. Agents are not deterministic — use 3+ before drawing conclusions |
| `--model` | the CLI's default | Model for the agent (`FIDELITY_MODEL` also works) |
| `--concurrency` | `3` | Parallel sessions |
| `--rescore <dir>` | — | Re-score the saved transcripts in `fidelity-results/<timestamp>/` with the current scenarios and scorer. No model calls, no cost; writes `report-rescored.md` there |

Requires a logged-in Claude Code CLI (`claude`) and a populated `.env`. `FIDELITY_CLAUDE_BIN` overrides the CLI path.
**It spends real model tokens**: roughly 18 scenarios × 2 modes per run (36 sessions), and each report shows the total cost.

## How a run is isolated

Each scenario × mode is a fresh `claude -p` session:
- an empty temp working directory, so no project `CLAUDE.md` and no auto-memory;
- `--setting-sources local`, so no user skills or plugins;
- `--strict-mcp-config` with only this server (`dist/index.js`), started with the variables from `.env` plus
  `MCP_DEPLOYMENT_MODE=local`, `MCP_DEBUG_MODE=false` and, unless the mode is `all`, `MCP_TOOLSETS=<mode>`;
- `--tools ""`, so the agent cannot write files or run a shell.

**Nothing on the tenant changes.** Tools whose names start with a read-only prefix (`list_`, `get_`, `find_`,
`check_`, `summarize_`, …; see `safety.ts`) plus `enable_toolset` and `switch_environment` are allowed. `get_*_command`
tools only generate text; the access key in their output is redacted in transcripts. Every side-effecting tool — deletes,
creates, updates, inspection sessions, test runs, public sharing, installs, downloads — is denied by the CLI. A denied
call is still recorded as the agent's choice and scored, so "tried to confirm a deletion on its own" fails the
scenario without deleting anything.

## Output

`fidelity-results/<timestamp>/` (git-ignored):
- `report.md` — a scenario × mode table, then every run's tool trajectory and check results
- `results.json` — the same, machine-readable
- `transcripts/` — the raw stream-json per run, with access keys redacted
- `report-rescored.md` — written by `--rescore`

## Adding a scenario

Add an entry to `scenarios.ts`: a plain-language `prompt` (never a tool name — a unit test enforces this), what it
`guards` against, and `checks` (`calledAny`, `notCalled`, `firstMeaningfulOneOf`, `calledBefore`, `noCallWhere`,
`calledWhere`, `textMatches`, `textNotMatches`, `noFabricatedCode`, `askedUser`). Checks marked `soft` are reported but
do not fail the scenario. `npm run test:fidelity-score` validates the scenario definitions without calling a model.

## When to run it

- after any change to tool descriptions, server instructions or toolsets (this is the safety net for trimming
  descriptions — see "Shrinking tool descriptions" in the development backlog)
- before a release, alongside the UAT
- compare `all` vs a restricted mode to see whether `MCP_TOOLSETS` costs fidelity for your workflows
