# Connecting a model and an agent

## A model

A model is optional. Without one, EXAPT uses deterministic synthesis, and says so. Set these in the
environment that starts EXAPT.

```bash
EXAPT_MODEL=claude-cli EXAPT_MODEL_NAME=sonnet npm run demo
```

```bash
EXAPT_MODEL=ollama EXAPT_MODEL_NAME=qwen2.5-coder:14b npm run demo
```

```bash
EXAPT_MODEL=openai-compatible EXAPT_MODEL_BASE_URL=https://example.com/v1 EXAPT_MODEL_NAME=some-model EXAPT_MODEL_API_KEY_ENV=MY_KEY_VARIABLE npm run demo
```

`EXAPT_MODEL=codex-cli` also works. `EXAPT_MODEL_API_KEY_ENV` holds the *name* of a variable, so the key
itself is never written anywhere. Spending per run is bounded by `EXAPT_MAX_MODEL_CALLS`,
`EXAPT_MAX_TOKENS` and `EXAPT_MAX_COST_USD`.

Small local models may not manage this. In testing, `qwen2.5-coder:7b` produced nothing that survived,
and EXAPT reported that as not established.

## An MCP agent

Claude Code, in `.mcp.json`:

```json
{
  "mcpServers": {
    "exapt": {
      "command": "node",
      "args": ["/absolute/path/to/exapt/apps/cli/exapt.ts", "mcp"],
      "env": {
        "EXAPT_HOME": "/absolute/path/to/exapt/.exapt",
        "EXAPT_PROGRAMS": "/absolute/path/to/your/programs",
        "EXAPT_DATA_ROOTS": "/absolute/path/agents/may/use"
      }
    }
  }
}
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.exapt]
command = "node"
args = ["/absolute/path/to/exapt/apps/cli/exapt.ts", "mcp"]
startup_timeout_sec = 120
tool_timeout_sec = 300

[mcp_servers.exapt.env]
EXAPT_HOME = "/absolute/path/to/exapt/.exapt"
EXAPT_PROGRAMS = "/absolute/path/to/your/programs"
EXAPT_DATA_ROOTS = "/absolute/path/agents/may/use"
```

Both were exercised in the [dogfood run](experiments/dogfood/README.md). An HTTP client can use
`POST /mcp` on the local service.

The agent sees thirteen tools, however many capabilities exist. A typical reuse is `exapt_memory`, then
`exapt_explain`, then `exapt_use`.

`EXAPT_PROGRAMS` and `EXAPT_DATA_ROOTS` are the operator's decisions. No tool call can change them.
