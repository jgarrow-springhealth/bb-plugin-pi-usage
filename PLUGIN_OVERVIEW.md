## What you get

Pi Usage adds a sidebar report and a `bb pi-usage` command for understanding the usage metadata in your local Pi sessions. See assistant-message totals, input/output/reasoning/cache token counts, and Pi's recorded cost estimates. Break results down by provider, model, day, or source (Pi terminal versus BB), and choose preset or inclusive custom date ranges.

The sidebar page includes summary cards, a model-stacked daily cost chart, provider and model tables, source filters, custom dates, and manual refresh. The CLI provides summary, model, daily, refresh, and JSON-output workflows.

Cost figures are estimates Pi recorded at list prices, not invoices or provider billing data. OAuth/subscription providers such as `openai-codex` and `github-copilot` are not billed per token even when Pi records an estimated cost.

## Typical workflow

Choose a time range and whether to include terminal sessions, BB sessions, or both. Start with the totals and daily chart, then use the provider and model tables to see what drove the result. Refresh after new sessions, or use JSON CLI output when you want to compare or archive a report.

## How it works

The plugin recursively reads Pi session JSONL files and incrementally indexes assistant-message usage fields in a plugin-scoped SQLite database. It scans on demand, when you refresh, and approximately every five minutes while running. Session files are read only and are never modified. The index stores paths and aggregate usage metadata, not message content.

Open **Pi Usage** from the BB sidebar, or run `bb pi-usage summary`, `bb pi-usage models`, `bb pi-usage daily`, or `bb pi-usage refresh`. Reports can filter by `today`, `7d`, `30d`, `90d`, `all`, or a custom date window and by `all`, `terminal`, or `bb` sources.

## Configuration

In **Settings → Plugins → Pi Usage**, choose the default reporting range (initially `30d`), default source (initially `all`), and whether to show the daily cost chart (initially on). You can also set absolute paths for Pi terminal sessions (initially `~/.pi/agent/sessions`) and BB Pi bridge sessions (initially `~/.bb/pi-bridge-sessions`). Changing a directory rebuilds that source's derived index and refreshes an open report, including for an empty or missing directory.

## Requirements

Requires BB 0.45 or newer and Plugin SDK 0.6.15 or newer, plus readable Pi session JSONL files in the configured directories. If you do not use Pi or have no session logs, there is no usage data to report. The plugin requires no API keys and contacts no external services. Node.js and npm are needed only for source installation or development.
