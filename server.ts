// bb-plugin-pi-usage — token and cost usage from Pi session logs.
//
// Pi writes one JSONL file per session. Every assistant message carries
// `provider`, `model`, and `usage` ({ input, output, cacheRead, cacheWrite,
// reasoning, cost: { total } }). This plugin indexes those files into its own
// SQLite database (incrementally — session files are append-only, so only
// new bytes are parsed) and serves aggregates to the sidebar page and the
// `bb pi-usage` CLI.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_USAGE_PREFERENCES,
  REPORT_RANGES,
  REPORT_SOURCES,
  resolveUsagePreferences,
} from "./preferences";

const rangeSchema = z.enum([...REPORT_RANGES, "custom"]);
const sourceSchema = z.enum(REPORT_SOURCES);
const sessionDirectorySchema = z
  .string()
  .min(1, "Session directory is required")
  .max(4096, "Session directory must be at most 4096 characters")
  .refine(isAbsolute, "Session directory must be an absolute path");
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const usageQuerySchema = z
  .object({
    range: rangeSchema,
    source: sourceSchema,
    fromDay: daySchema.optional(),
    toDay: daySchema.optional(),
    refresh: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.range !== "custom") return;
    if (value.fromDay === undefined || value.toDay === undefined) {
      context.addIssue({
        code: "custom",
        message: "Custom ranges require both fromDay and toDay",
      });
    } else if (value.fromDay > value.toDay) {
      context.addIssue({
        code: "custom",
        message: "fromDay must be on or before toDay",
      });
    }
  });
type Range = z.infer<typeof rangeSchema>;
type SourceFilter = z.infer<typeof sourceSchema>;

const totalsSchema = z.object({
  messages: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
});
const modelRowSchema = totalsSchema.extend({
  provider: z.string(),
  model: z.string(),
  lastUsed: z.string(),
});
const providerRowSchema = totalsSchema.extend({ provider: z.string() });
const dayRowSchema = z.object({
  day: z.string(),
  cost: z.number(),
  messages: z.number(),
  tokens: z.number(),
});
const dayModelRowSchema = dayRowSchema.extend({
  provider: z.string(),
  model: z.string(),
});
const summarySchema = z.object({
  range: rangeSchema,
  source: sourceSchema,
  totals: totalsSchema,
  byProvider: z.array(providerRowSchema),
  byModel: z.array(modelRowSchema),
  byDay: z.array(dayRowSchema),
  byDayModel: z.array(dayModelRowSchema),
  scan: z.object({
    scannedAt: z.string().nullable(),
    files: z.number(),
    sources: z.array(
      z.object({ id: z.string(), dir: z.string(), exists: z.boolean() }),
    ),
  }),
});
export type UsageSummary = z.infer<typeof summarySchema>;
export type UsageTotals = z.infer<typeof totalsSchema>;

export const rpcContract = defineRpcContract({
  usage_summary: {
    input: usageQuerySchema,
    output: summarySchema,
  },
});

/** Realtime channel: published after a scan indexes new data. */
export const USAGE_CHANGED = "usage-changed";

type SessionSource = { id: "terminal" | "bb"; dir: string };

type SessionFileHandle = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<unknown>;
  close(): Promise<void>;
};

type PiUsageDependencies = {
  openSessionFile(path: string): Promise<SessionFileHandle>;
};

const defaultDependencies: PiUsageDependencies = {
  async openSessionFile(path) {
    const handle = await open(path, "r");
    return {
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
};

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Local calendar day (YYYY-MM-DD) for an ISO timestamp or epoch ms. */
function localDay(value: unknown): string | null {
  const date =
    typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : null;
  if (date === null || Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rangeStartDay(range: Range): string | null {
  if (range === "all" || range === "custom") return null;
  const days = { today: 0, "7d": 6, "30d": 29, "90d": 89 }[range];
  const start = new Date();
  start.setDate(start.getDate() - days);
  return localDay(start.getTime());
}

async function listJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      // `parentPath` (Node 20+) — fall back to `path` on older runtimes.
      const parent =
        (entry as { parentPath?: string }).parentPath ??
        (entry as { path?: string }).path ??
        dir;
      out.push(join(parent, entry.name));
    }
  }
  return out;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function initializePiUsagePlugin(
  bb: BbPluginApi,
  dependencies: PiUsageDependencies = defaultDependencies,
) {
  const settings = bb.settings.define({
    defaultRange: {
      type: "select",
      label: "Default reporting range",
      description: "Range selected when the Pi Usage page opens and when a CLI report omits --range.",
      options: [...REPORT_RANGES],
      experimental_schema: z.enum(REPORT_RANGES),
      default: DEFAULT_USAGE_PREFERENCES.defaultRange,
    },
    defaultSource: {
      type: "select",
      label: "Default session source",
      description: "Session source selected when the page opens and when a CLI report omits --source.",
      options: [...REPORT_SOURCES],
      experimental_schema: z.enum(REPORT_SOURCES),
      default: DEFAULT_USAGE_PREFERENCES.defaultSource,
    },
    showDailyChart: {
      type: "boolean",
      label: "Show daily cost chart",
      description: "Show the model-stacked cost chart when the selected range contains more than one day.",
      default: DEFAULT_USAGE_PREFERENCES.showDailyChart,
    },
    terminalSessionsDir: {
      type: "string",
      label: "Pi terminal sessions directory",
      description: "Absolute path containing Pi terminal session JSONL files. Changing it rebuilds that source's index.",
      experimental_schema: sessionDirectorySchema,
      default: join(homedir(), ".pi", "agent", "sessions"),
    },
    bbSessionsDir: {
      type: "string",
      label: "BB Pi sessions directory",
      description: "Absolute path containing BB Pi bridge session JSONL files. Changing it rebuilds that source's index.",
      experimental_schema: sessionDirectorySchema,
      default: join(homedir(), ".bb", "pi-bridge-sessions"),
    },
  });
  let config = await settings.get();
  let sources: SessionSource[] = [
    { id: "terminal", dir: config.terminalSessionsDir },
    { id: "bb", dir: config.bbSessionsDir },
  ];

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE files (
       path TEXT PRIMARY KEY,
       source TEXT NOT NULL,
       size INTEGER NOT NULL,
       mtime_ms REAL NOT NULL,
       offset INTEGER NOT NULL
     )`,
    `CREATE TABLE usage (
       path TEXT NOT NULL,
       source TEXT NOT NULL,
       day TEXT NOT NULL,
       provider TEXT NOT NULL,
       model TEXT NOT NULL,
       messages INTEGER NOT NULL,
       input INTEGER NOT NULL,
       output INTEGER NOT NULL,
       cache_read INTEGER NOT NULL,
       cache_write INTEGER NOT NULL,
       reasoning INTEGER NOT NULL,
       cost REAL NOT NULL,
       PRIMARY KEY (path, day, provider, model)
     )`,
    `CREATE INDEX usage_day ON usage (day)`,
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ]);

  const getFile = db.prepare(
    `SELECT size, mtime_ms AS mtimeMs, offset FROM files WHERE path = ?`,
  );
  const putFile = db.prepare(
    `INSERT INTO files (path, source, size, mtime_ms, offset)
     VALUES (@path, @source, @size, @mtimeMs, @offset)
     ON CONFLICT(path) DO UPDATE SET
       source = excluded.source, size = excluded.size,
       mtime_ms = excluded.mtime_ms, offset = excluded.offset`,
  );
  const clearFileUsage = db.prepare(`DELETE FROM usage WHERE path = ?`);
  const addUsage = db.prepare(
    `INSERT INTO usage (path, source, day, provider, model, messages, input,
       output, cache_read, cache_write, reasoning, cost)
     VALUES (@path, @source, @day, @provider, @model, @messages, @input,
       @output, @cacheRead, @cacheWrite, @reasoning, @cost)
     ON CONFLICT(path, day, provider, model) DO UPDATE SET
       messages = messages + excluded.messages,
       input = input + excluded.input,
       output = output + excluded.output,
       cache_read = cache_read + excluded.cache_read,
       cache_write = cache_write + excluded.cache_write,
       reasoning = reasoning + excluded.reasoning,
       cost = cost + excluded.cost`,
  );
  const putMeta = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const getMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`);
  const clearSource = db.transaction((source: SessionSource["id"]) => {
    db.prepare(`DELETE FROM usage WHERE source = ?`).run(source);
    db.prepare(`DELETE FROM files WHERE source = ?`).run(source);
  });
  const clearAllSources = db.transaction(() => {
    db.prepare(`DELETE FROM usage`).run();
    db.prepare(`DELETE FROM files`).run();
  });
  for (const source of sources) {
    const key = `sourceDir:${source.id}`;
    const indexedDirectory = (getMeta.get(key) as { value: string } | undefined)
      ?.value;
    if (indexedDirectory !== undefined && indexedDirectory !== source.dir) {
      clearSource(source.id);
    }
    putMeta.run(key, source.dir);
  }

  type Bucket = {
    path: string;
    source: string;
    day: string;
    provider: string;
    model: string;
    messages: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    cost: number;
  };

  /** Parse complete lines in `text`, folding usage into day/model buckets. */
  function parseChunk(
    text: string,
    path: string,
    source: string,
    buckets: Map<string, Bucket>,
  ) {
    for (const line of text.split("\n")) {
      // Cheap prefilter: most lines are user/tool messages without usage.
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry?.message;
      if (entry?.type !== "message" || message?.role !== "assistant") continue;
      const usage = message.usage;
      if (usage === null || typeof usage !== "object") continue;
      const day = localDay(entry.timestamp ?? message.timestamp);
      if (day === null) continue;
      const provider = String(message.provider ?? "unknown");
      const model = String(message.model ?? "unknown");
      const key = `${day}\u0000${provider}\u0000${model}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          path,
          source,
          day,
          provider,
          model,
          messages: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          cost: 0,
        };
        buckets.set(key, bucket);
      }
      bucket.messages += 1;
      bucket.input += num(usage.input);
      bucket.output += num(usage.output);
      bucket.cacheRead += num(usage.cacheRead);
      bucket.cacheWrite += num(usage.cacheWrite);
      bucket.reasoning += num(usage.reasoning);
      bucket.cost += num(usage.cost?.total);
    }
  }

  async function indexFile(path: string, source: string): Promise<boolean> {
    let info;
    try {
      info = await stat(path);
    } catch {
      return false;
    }
    const known = getFile.get(path) as
      | { size: number; mtimeMs: number; offset: number }
      | undefined;
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) {
      return false;
    }
    // Append-only files resume from the last complete line; anything that
    // shrank (rewritten/truncated) is reindexed from the start.
    const resume = known !== undefined && info.size >= known.offset;
    const start = resume ? known.offset : 0;
    const length = info.size - start;
    const buckets = new Map<string, Bucket>();
    let consumed = 0;
    if (length > 0) {
      const handle = await dependencies.openSessionFile(path);
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline >= 0) {
          consumed = lastNewline + 1;
          parseChunk(
            buffer.subarray(0, consumed).toString("utf8"),
            path,
            source,
            buckets,
          );
        }
      } finally {
        await handle.close();
      }
    }
    db.transaction(() => {
      if (!resume) clearFileUsage.run(path);
      for (const bucket of buckets.values()) addUsage.run(bucket);
      putFile.run({
        path,
        source,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: start + consumed,
      });
    })();
    return buckets.size > 0 || !resume;
  }

  let scanning: Promise<void> | null = null;
  let lastScanAt = 0;
  let sourceConfigurationVersion = 0;

  async function scan(): Promise<void> {
    if (scanning) return scanning;
    scanning = (async () => {
      while (true) {
        const started = Date.now();
        const configurationVersion = sourceConfigurationVersion;
        const scanSources = sources;
        let changed = 0;
        let files = 0;
        try {
          for (const { id, dir } of scanSources) {
            for (const path of await listJsonl(dir)) {
              files += 1;
              if (await indexFile(path, id)) changed += 1;
            }
          }
        } catch (error) {
          if (configurationVersion === sourceConfigurationVersion) throw error;
          // Old-path rows may have been written after onChange cleared them.
          // A concurrent I/O failure must not bypass cleanup and leave those
          // rows visible, so discard derived work and retry the current paths.
          clearAllSources();
          continue;
        }
        if (configurationVersion !== sourceConfigurationVersion) {
          // A settings save can happen while file I/O is in flight. Discard
          // that derived work and restart against the newly configured paths.
          clearAllSources();
          continue;
        }
        lastScanAt = Date.now();
        putMeta.run("scannedAt", new Date(lastScanAt).toISOString());
        putMeta.run("files", String(files));
        if (changed > 0) {
          bb.log.info(
            `indexed ${changed} changed of ${files} session files in ${lastScanAt - started}ms`,
          );
          bb.realtime.publish(USAGE_CHANGED, { changed });
        }
        return;
      }
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  /** Rescan when asked, or when the index is older than 30 seconds. */
  async function ensureFresh(force: boolean) {
    if (force || Date.now() - lastScanAt > 30_000) await scan();
  }

  settings.onChange((next, previous) => {
    config = next;
    const terminalDirectoryChanged =
      next.terminalSessionsDir !== previous.terminalSessionsDir;
    const bbDirectoryChanged = next.bbSessionsDir !== previous.bbSessionsDir;
    sources = [
      { id: "terminal", dir: next.terminalSessionsDir },
      { id: "bb", dir: next.bbSessionsDir },
    ];
    if (terminalDirectoryChanged || bbDirectoryChanged) {
      sourceConfigurationVersion += 1;
    }
    if (terminalDirectoryChanged) {
      clearSource("terminal");
      putMeta.run("sourceDir:terminal", next.terminalSessionsDir);
    }
    if (bbDirectoryChanged) {
      clearSource("bb");
      putMeta.run("sourceDir:bb", next.bbSessionsDir);
    }
    lastScanAt = 0;
    if (terminalDirectoryChanged || bbDirectoryChanged) {
      // Open reports subscribe to this channel and immediately request a fresh
      // summary, including when the replacement directory has no files.
      bb.realtime.publish(USAGE_CHANGED, { reason: "session-directories-changed" });
    }
  });

  const totalsSql = `
    COALESCE(SUM(messages), 0) AS messages,
    COALESCE(SUM(input), 0) AS input,
    COALESCE(SUM(output), 0) AS output,
    COALESCE(SUM(cache_read), 0) AS cacheRead,
    COALESCE(SUM(cache_write), 0) AS cacheWrite,
    COALESCE(SUM(reasoning), 0) AS reasoning,
    COALESCE(SUM(cost), 0) AS cost`;

  async function summary(
    range: Range,
    source: SourceFilter,
    refresh: boolean,
    fromDay?: string,
    toDay?: string,
  ): Promise<UsageSummary> {
    await ensureFresh(refresh);
    const where: string[] = [];
    const params: Record<string, string> = {};
    const startDay = range === "custom" ? fromDay ?? null : rangeStartDay(range);
    const endDay = range === "custom" ? toDay ?? null : null;
    if (startDay !== null) {
      where.push("day >= @startDay");
      params.startDay = startDay;
    }
    if (endDay !== null) {
      where.push("day <= @endDay");
      params.endDay = endDay;
    }
    if (source !== "all") {
      where.push("source = @source");
      params.source = source;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const totals = db
      .prepare(`SELECT ${totalsSql} FROM usage ${whereSql}`)
      .get(params) as UsageTotals;
    const byProvider = db
      .prepare(
        `SELECT provider, ${totalsSql} FROM usage ${whereSql}
         GROUP BY provider ORDER BY cost DESC, messages DESC`,
      )
      .all(params) as UsageSummary["byProvider"];
    const byModel = db
      .prepare(
        `SELECT provider, model, MAX(day) AS lastUsed, ${totalsSql}
         FROM usage ${whereSql}
         GROUP BY provider, model ORDER BY cost DESC, messages DESC`,
      )
      .all(params) as UsageSummary["byModel"];
    const byDay = db
      .prepare(
        `SELECT day, COALESCE(SUM(cost), 0) AS cost,
           COALESCE(SUM(messages), 0) AS messages,
           COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens
         FROM usage ${whereSql} GROUP BY day ORDER BY day`,
      )
      .all(params) as UsageSummary["byDay"];
    const byDayModel = db
      .prepare(
        `SELECT day, provider, model, COALESCE(SUM(cost), 0) AS cost,
           COALESCE(SUM(messages), 0) AS messages,
           COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens
         FROM usage ${whereSql}
         GROUP BY day, provider, model ORDER BY day, cost DESC`,
      )
      .all(params) as UsageSummary["byDayModel"];
    const meta = (key: string) =>
      (getMeta.get(key) as { value: string } | undefined)?.value ?? null;
    return {
      range,
      source,
      totals,
      byProvider,
      byModel,
      byDay,
      byDayModel,
      scan: {
        scannedAt: meta("scannedAt"),
        files: Number(meta("files") ?? 0),
        sources: await Promise.all(
          sources.map(async ({ id, dir }) => ({
            id,
            dir,
            exists: await dirExists(dir),
          })),
        ),
      },
    };
  }

  bb.rpc.register(rpcContract, {
    usage_summary: ({ range, source, refresh, fromDay, toDay }) =>
      summary(range, source, refresh === true, fromDay, toDay),
  });

  // ── CLI ────────────────────────────────────────────────────────────────
  const fmtTokens = (n: number) =>
    n >= 1e9
      ? `${(n / 1e9).toFixed(2)}B`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(2)}M`
        : n >= 1e3
          ? `${(n / 1e3).toFixed(1)}K`
          : String(Math.round(n));
  const fmtCost = (n: number) => `$${n.toFixed(2)}`;
  const pad = (s: string, w: number) => s.padEnd(w);
  const padL = (s: string, w: number) => s.padStart(w);

  const usageText = [
    "Usage:",
    "  bb pi-usage summary [--range today|7d|30d|90d|all|custom] [--from YYYY-MM-DD --to YYYY-MM-DD] [--source all|terminal|bb] [--json]",
    "  bb pi-usage models  [--range ...] [--source ...] [--limit N] [--json]",
    "  bb pi-usage daily   [--range ...] [--source ...] [--json]",
    "  bb pi-usage refresh",
    "",
    "Defaults come from Settings → Plugins → Pi Usage (initially --range 30d --source all).",
    "Costs are Pi's estimates at list prices; subscription (OAuth) providers such as",
    "openai-codex are not billed per token.",
  ].join("\n");

  function parseFlags(args: string[]) {
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg.startsWith("--")) {
        const [name, inline] = arg.slice(2).split("=", 2);
        if (inline !== undefined) flags[name!] = inline;
        else if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) {
          flags[name!] = args[i + 1]!;
          i += 1;
        } else flags[name!] = "true";
      }
    }
    return flags;
  }

  bb.cli.register({
    name: "pi-usage",
    summary: "Show token and cost usage from Pi sessions",
    commands: [
      {
        name: "summary",
        summary: "Totals and per-provider usage",
        usage:
          "bb pi-usage summary [--range today|7d|30d|90d|all|custom] [--from YYYY-MM-DD --to YYYY-MM-DD] [--source all|terminal|bb] [--json]",
      },
      {
        name: "models",
        summary: "Usage per provider/model",
        usage: "bb pi-usage models [--range ...] [--source ...] [--limit N] [--json]",
      },
      {
        name: "daily",
        summary: "Cost and tokens per day",
        usage: "bb pi-usage daily [--range ...] [--source ...] [--json]",
      },
      {
        name: "refresh",
        summary: "Rescan Pi session files now",
        usage: "bb pi-usage refresh",
      },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usageText };
      }
      const flags = parseFlags(rest);
      const preferences = resolveUsagePreferences(config);
      const range = rangeSchema.safeParse(flags.range ?? preferences.defaultRange);
      const source = sourceSchema.safeParse(flags.source ?? preferences.defaultSource);
      if (!range.success || !source.success) {
        return { exitCode: 1, stderr: usageText };
      }
      const json = flags.json === "true";
      const customDays =
        range.success && range.data === "custom"
          ? daySchema.safeParse(flags.from).success && daySchema.safeParse(flags.to).success && flags.from! <= flags.to!
            ? { from: flags.from!, to: flags.to! }
            : null
          : undefined;
      if (customDays === null) {
        return { exitCode: 1, stderr: `Custom ranges require --from and --to in YYYY-MM-DD order.\n\n${usageText}` };
      }
      if (command === "refresh") {
        await scan();
        const s = await summary("all", "all", false);
        return {
          exitCode: 0,
          stdout: `Indexed ${s.scan.files} session files (${s.totals.messages} assistant messages).`,
        };
      }
      const s = await summary(
        range.data,
        source.data,
        false,
        customDays?.from,
        customDays?.to,
      );
      const rangeLabel = customDays ? `${customDays.from}…${customDays.to}` : s.range;
      const header = `Pi usage — range ${rangeLabel}, source ${s.source}`;
      if (command === "summary") {
        if (json) return { exitCode: 0, stdout: JSON.stringify({ totals: s.totals, byProvider: s.byProvider }) };
        const t = s.totals;
        const lines = [
          header,
          `Cost ${fmtCost(t.cost)} · ${t.messages} messages · in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache read ${fmtTokens(t.cacheRead)} · cache write ${fmtTokens(t.cacheWrite)}`,
          "",
          `${pad("Provider", 18)}${padL("Cost", 11)}${padL("Msgs", 8)}${padL("Input", 9)}${padL("Output", 9)}${padL("CacheR", 9)}`,
          ...s.byProvider.map(
            (p) =>
              `${pad(p.provider, 18)}${padL(fmtCost(p.cost), 11)}${padL(String(p.messages), 8)}${padL(fmtTokens(p.input), 9)}${padL(fmtTokens(p.output), 9)}${padL(fmtTokens(p.cacheRead), 9)}`,
          ),
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "models") {
        const limit = Math.max(1, Math.min(200, Number(flags.limit ?? 25) || 25));
        const rows = s.byModel.slice(0, limit);
        if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
        const lines = [
          header,
          `${pad("Provider/model", 40)}${padL("Cost", 11)}${padL("Msgs", 8)}${padL("Input", 9)}${padL("Output", 9)}  Last used`,
          ...rows.map(
            (m) =>
              `${pad(`${m.provider}/${m.model}`.slice(0, 39), 40)}${padL(fmtCost(m.cost), 11)}${padL(String(m.messages), 8)}${padL(fmtTokens(m.input), 9)}${padL(fmtTokens(m.output), 9)}  ${m.lastUsed}`,
          ),
        ];
        if (s.byModel.length > rows.length) lines.push(`… ${s.byModel.length - rows.length} more (use --limit)`);
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "daily") {
        const rows = s.byDay.slice(-120);
        if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
        const lines = [
          header,
          `${pad("Day", 12)}${padL("Cost", 11)}${padL("Msgs", 8)}${padL("Tokens", 10)}`,
          ...rows.map(
            (d) =>
              `${pad(d.day, 12)}${padL(fmtCost(d.cost), 11)}${padL(String(d.messages), 8)}${padL(fmtTokens(d.tokens), 10)}`,
          ),
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      return { exitCode: 1, stderr: usageText };
    },
  });

  // Keep the index warm so the page opens instantly: scan on load, then
  // every 5 minutes. The sleep wakes on abort so reloads stop promptly.
  bb.background.service("indexer", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await scan();
        } catch (error) {
          bb.log.warn(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5 * 60_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });
}

export default function plugin(bb: BbPluginApi) {
  return initializePiUsagePlugin(bb);
}
