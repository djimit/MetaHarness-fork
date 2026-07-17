# metaharness

Scaffold your own focused AI agent harness — like [ruflo](https://github.com/ruvnet/ruflo), uniquely yours.

> **Proven at the cost-Pareto frontier.** Same "evolve the harness" thesis, measured: the Darwin harness resolves
> real **SWE-bench Lite** issues at **34.0%** single-trajectory (~$0.005/inst) and **39.7%** Best-of-3
> (~$0.015/inst) — conformant, official harness. Live
> **[Cost–Performance leaderboard](https://ruvnet.github.io/agent-harness-generator/cost-pareto.html)** ·
> [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin).

> Published as **`metaharness`** (the `metaharness` and `harness` CLIs). Earlier versions were published as `create-agent-harness`.

## Quick start

```bash
npx metaharness my-bot
```

You'll be prompted for template, host, description. Out comes a complete npm package ready to `npm publish`.

## Non-interactive

```bash
npx metaharness my-legal-bot \
  --template vertical:legal \
  --host claude-code \
  --description "Contract redline + risk rating"
```

## Templates

| Template | Best for |
|---|---|
| `minimal` | Custom starter — kernel only |
| `vertical:devops` | Incident response, on-call workflows |
| `vertical:support` | Customer support, KB-RAG, escalation |
| `vertical:trading` | Quant trading (paper-default, circuit breakers) |
| `vertical:legal` | Contract review with citation checking |
| `vertical:research` | Multi-source dossier with evidence grading |

## Hosts

`--host` selects which host adapter ships with your harness:

| Host | What you get |
|---|---|
| `claude-code` | `.claude/settings.json` with MCP + hooks |
| `codex` | `~/.codex/config.toml` with `[mcp_servers.*]` |
| `pi-dev` | Pi extension (TypeScript, no MCP by design) |
| `hermes` | `cli-config.yaml` + `optional-mcps/*.yaml` |
| `openclaw` | `~/.openclaw/openclaw.json` + workspace SKILL.md + install runbook |
| `rvm` | RVM partition manifest + capability table + wasm-guest + install runbook (hardware-isolated) |

Multi-host: pass `--host` multiple times.

## Also ships the `harness` CLI

```bash
harness sign      # produce/update the witness manifest
harness verify    # check signature
harness doctor    # smoke-check a scaffolded harness
harness score     # runtime-readiness badges for a local repo
harness help
```

### `harness score` vs `metaharness score` — two different scorecards (#15)

The two CLIs both accept `score` but emit **different, purpose-specific JSON** — so check the schema
discriminator before parsing:

| Command | Purpose | JSON discriminator |
|---|---|---|
| `harness score <dir> --json` | Runtime-readiness **badges** (score + mcpRisk / releaseReady / testsDetected / sbom / witnessSigned) | `"schema": "harness-quickcheck-v1"` (string) |
| `metaharness score <dir> --json` | 5-dimension harness-fit **scorecard** (harnessFit / compileConfidence / …) | `"schema": 1` (number) |

They are **not interchangeable**. A consumer wiring one into a pipeline expecting the other should
branch on `schema` (`typeof out.schema === 'string'` ⇒ harness badges; `=== 1` ⇒ metaharness
scorecard) and refuse the wrong shape rather than silently defaulting missing fields to `0`.

## Optional Cognitum Meta-Proxy sidecar

Meta-Proxy is an optional local Rust sidecar, not an npm dependency and not part
of normal harness scaffolding. Install it only when you want a locally bound,
Claude-compatible routing endpoint with Meta-Proxy's own Cognitum OAuth flow:

```bash
npx metaharness proxy install --yes   # signed v0.3.0 download; checksum + Ed25519 verified
npx metaharness proxy login           # browser or headless Cognitum OAuth, owned by Meta-Proxy
npx metaharness proxy start
npx metaharness proxy status
```

`proxy install` downloads the platform archive from the public
[`meta-proxy-dist`](https://github.com/cognitum-one/meta-proxy-dist) release
channel only after explicit `--yes` consent. The CLI verifies the signed
`SHA256SUMS` manifest against a public key pinned in MetaHarness before it
extracts or replaces a binary. The sidecar is installed under
`~/.metaharness/meta-proxy/`; credentials remain in Meta-Proxy's own storage.

Other commands: `proxy stop`, `proxy path`, and `proxy logout`.

## Eject from ruflo

If you've been using ruflo and want your own focused harness from it:

```bash
npx metaharness --from-existing ./
```

Lifts agents/skills/commands, rewrites every `ruflo` / `claude-flow` reference, preserves attribution blocks marked with `<!-- ruflo-attribution-block -->`.

## Full walkthrough

See [USAGE.md](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/USAGE.md).

## License

MIT
