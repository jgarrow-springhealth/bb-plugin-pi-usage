---
name: pi-usage
description: Report Pi token and cost usage by provider, model, or day with the `bb pi-usage` CLI. Use when the user asks how much they've spent or used in Pi, which models or API keys they use most, or for usage trends.
---

# Pi usage

The Pi Usage plugin indexes Pi session logs (`~/.pi/agent/sessions` for the
terminal, `~/.bb/pi-bridge-sessions` for BB threads) and reports usage. The
"Pi Usage" sidebar page shows the same data.

## Commands

| Command | Effect |
| --- | --- |
| `bb pi-usage summary` | Totals plus a per-provider table. |
| `bb pi-usage models [--limit N]` | Per provider/model usage, highest cost first. |
| `bb pi-usage daily` | Cost, messages, and tokens per day. |
| `bb pi-usage refresh` | Rescan session files now (otherwise automatic). |

Every reporting command accepts `--range today|7d|30d|90d|all|custom`,
`--source all|terminal|bb`, and `--json`. When omitted, range and source use the
values in Settings → Plugins → Pi Usage (initially `30d` and `all`). For an
inclusive custom date window, add
`--range custom --from YYYY-MM-DD --to YYYY-MM-DD`.

## Rules

- Costs are Pi's per-message estimates at list prices. Providers that use a
  subscription (OAuth), such as `openai-codex`, aren't billed per token, so say so
  when you report their cost.
- `openai` (API key) and `openai-codex` (ChatGPT subscription) are separate providers.
- The plugin only reads session files. It never sees API keys.
