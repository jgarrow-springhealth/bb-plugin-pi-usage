// bb-plugin-pi-usage — sidebar page showing Pi token and cost usage.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsageSummary } from "./server";
import { resolveUsagePreferences } from "./preferences";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Range = UsageSummary["range"];
type Source = UsageSummary["source"];

const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];
const SOURCES: { id: Source; label: string }[] = [
  { id: "all", label: "All" },
  { id: "terminal", label: "Terminal" },
  { id: "bb", label: "BB" },
];
/** Providers authenticated with a subscription rather than per-token keys. */
const SUBSCRIPTION_PROVIDERS = new Set(["openai-codex", "github-copilot"]);
/** Theme-owned chart colors; repeated only when more than eight models appear. */
const CHART_COLORS = [
  "var(--timeline-accent, var(--primary))",
  "var(--success, var(--primary))",
  "var(--warning, var(--primary))",
  "var(--pr-merged, var(--primary))",
  "var(--destructive, var(--primary))",
  "var(--brand-discord, var(--primary))",
  "var(--attention, var(--primary))",
  "var(--primary)",
];
const modelKey = (provider: string, model: string) => `${provider}/${model}`;

const fmtTokens = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : String(Math.round(n));
const fmtCost = (n: number) =>
  n >= 1000
    ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : `$${n.toFixed(2)}`;
const inputDay = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return inputDay(date);
};

function useUsage(range: Range, source: Source, fromDay: string, toDay: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (refresh = false) => {
      setLoading(true);
      rpc
        .call("usage_summary", {
          range,
          source,
          refresh,
          ...(range === "custom" ? { fromDay, toDay } : {}),
        })
        .then(
          (result) => {
            setData(result);
            setError(null);
          },
          (cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setLoading(false));
    },
    [rpc, range, source, fromDay, toDay],
  );
  useEffect(() => load(), [load]);
  useRealtime("usage-changed", () => load());
  return { data, error, loading, refresh: () => load(true) };
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-border bg-card p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded px-2.5 py-1 text-xs transition-colors",
            option.id === value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  icon,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: string;
  color: string;
}) {
  return (
    <div
      className="rounded-lg border border-l-4 border-border px-3 py-2.5"
      style={{ borderLeftColor: color, backgroundColor: "var(--card)" }}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={icon} className="size-3.5" style={{ color }} />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function displayDay(day: string, withYear = false): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "2-digit" as const } : {}),
  }).format(new Date(`${day}T12:00:00`));
}

function chartLabels(days: UsageSummary["byDay"], range: Range) {
  if (days.length === 0) return [];
  const customSpan =
    range === "custom" && days.length > 1
      ? (new Date(`${days[days.length - 1]!.day}T12:00:00`).getTime() -
          new Date(`${days[0]!.day}T12:00:00`).getTime()) /
        86_400_000
      : null;
  if (range === "today" || range === "7d" || (customSpan !== null && customSpan <= 7)) {
    return days.map((day, index) => ({ index, label: displayDay(day.day) }));
  }
  const indexes = new Set<number>([0, days.length - 1]);
  if (range === "30d" || (customSpan !== null && customSpan <= 60)) {
    let last = new Date(`${days[0]!.day}T12:00:00`).getTime();
    days.forEach((day, index) => {
      const current = new Date(`${day.day}T12:00:00`).getTime();
      if (current - last >= 7 * 86_400_000) {
        indexes.add(index);
        last = current;
      }
    });
  } else {
    const monthStarts: number[] = [];
    let previous = "";
    days.forEach((day, index) => {
      const month = day.day.slice(0, 7);
      if (month !== previous) monthStarts.push(index);
      previous = month;
    });
    const stride = range === "90d" ? 1 : Math.max(1, Math.ceil(monthStarts.length / 10));
    monthStarts.forEach((index, monthIndex) => {
      if (monthIndex % stride === 0) indexes.add(index);
    });
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      label: displayDay(days[index]!.day, range === "all"),
    }));
}

function DailyChart({
  days,
  models,
  range,
}: {
  days: UsageSummary["byDay"];
  models: UsageSummary["byDayModel"];
  range: Range;
}) {
  const max = Math.max(...days.map((d) => d.cost), 0.0001);
  const { byDay, colorByModel, rankedModels } = useMemo(() => {
    const grouped = new Map<string, UsageSummary["byDayModel"]>();
    const modelTotals = new Map<string, number>();
    for (const row of models) {
      const key = modelKey(row.provider, row.model);
      grouped.set(row.day, [...(grouped.get(row.day) ?? []), row]);
      modelTotals.set(key, (modelTotals.get(key) ?? 0) + row.cost);
    }
    const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]);
    return {
      byDay: grouped,
      rankedModels: ranked,
      colorByModel: new Map(
        ranked.map(([key], index) => [key, CHART_COLORS[index % CHART_COLORS.length]!]),
      ),
    };
  }, [models]);
  const labels = useMemo(() => chartLabels(days, range), [days, range]);
  if (days.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {rankedModels.slice(0, 6).map(([key]) => (
          <span key={key} className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: colorByModel.get(key) }}
            />
            <span className="max-w-44 truncate" title={key}>{key}</span>
          </span>
        ))}
        {rankedModels.length > 6 ? (
          <span className="text-[11px] text-muted-foreground">+{rankedModels.length - 6} more</span>
        ) : null}
      </div>
      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2">
        <div className="relative h-36 text-[10px] tabular-nums text-muted-foreground">
          <span className="absolute right-0 top-0 -translate-y-1/2">{fmtCost(max)}</span>
          <span className="absolute right-0 top-1/2 -translate-y-1/2">{fmtCost(max / 2)}</span>
          <span className="absolute bottom-0 right-0 translate-y-1/2">$0</span>
        </div>
        <div className="relative h-36">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            <span className="border-t border-border" />
            <span className="border-t border-dashed border-border" />
            <span className="border-t border-border" />
          </div>
          <div className="relative flex h-full items-end gap-px">
            {days.map((day, index) => {
              const breakdown = byDay.get(day.day) ?? [];
              const tooltipPosition =
                index < days.length / 3
                  ? "left-0"
                  : index > (days.length * 2) / 3
                    ? "right-0"
                    : "left-1/2 -translate-x-1/2";
              return (
                <button
                  key={day.day}
                  type="button"
                  aria-label={`${day.day}: ${fmtCost(day.cost)}, ${day.messages} messages. Focus to show model breakdown.`}
                  className="group relative flex h-full min-w-[3px] flex-1 items-end focus-visible:z-20 focus-visible:outline-none"
                >
                  <span
                    className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm opacity-80 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    style={{
                      height: `${Math.max((day.cost / max) * 100, day.cost > 0 ? 2 : 0)}%`,
                    }}
                  >
                    {breakdown.map((row) => (
                      <span
                        key={modelKey(row.provider, row.model)}
                        className="block w-full"
                        style={{
                          backgroundColor: colorByModel.get(modelKey(row.provider, row.model)),
                          height: `${day.cost > 0 ? (row.cost / day.cost) * 100 : 0}%`,
                        }}
                      />
                    ))}
                  </span>
                  <span
                    role="tooltip"
                    className={cn(
                      "pointer-events-none absolute bottom-[calc(100%+0.5rem)] z-30 hidden w-72 rounded-md border border-border bg-popover p-3 text-left text-popover-foreground shadow-lg group-hover:block group-focus-visible:block",
                      tooltipPosition,
                    )}
                  >
                    <span className="mb-2 flex items-baseline justify-between gap-3 border-b border-border pb-2">
                      <span className="text-xs font-medium">{displayDay(day.day, true)}</span>
                      <span className="text-xs font-semibold tabular-nums">{fmtCost(day.cost)}</span>
                    </span>
                    <span className="flex flex-col gap-1.5">
                      {breakdown.map((row) => (
                        <span
                          key={modelKey(row.provider, row.model)}
                          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs"
                        >
                          <span
                            className="size-2 rounded-sm"
                            style={{ backgroundColor: colorByModel.get(modelKey(row.provider, row.model)) }}
                          />
                          <span className="truncate">
                            <span className="text-muted-foreground">{row.provider}/</span>
                            {row.model}
                          </span>
                          <span className="tabular-nums">{fmtCost(row.cost)}</span>
                        </span>
                      ))}
                    </span>
                    <span className="mt-2 block border-t border-border pt-2 text-[10px] text-muted-foreground">
                      {day.messages.toLocaleString()} messages · {fmtTokens(day.tokens)} tokens
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div />
        <div className="relative h-5 text-[10px] text-muted-foreground">
          {labels.map(({ index, label }) => (
            <span
              key={`${index}-${label}`}
              className={cn(
                "absolute top-0 whitespace-nowrap",
                index === 0
                  ? "translate-x-0"
                  : index === days.length - 1
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
              style={{ left: `${days.length === 1 ? 0 : (index / (days.length - 1)) * 100}%` }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-1 text-center text-[10px] text-muted-foreground">
        Hover or focus a bar for its model breakdown
      </p>
    </div>
  );
}

function ShareBar({ share, color }: { share: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full opacity-80"
        style={{ backgroundColor: color, width: `${Math.min(share * 100, 100)}%` }}
      />
    </div>
  );
}

const th = "px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const thR = cn(th, "text-right");
const td = "px-3 py-2";
const tdR = cn(td, "text-right tabular-nums");

function ProviderBadge({ provider }: { provider: string }) {
  return SUBSCRIPTION_PROVIDERS.has(provider) ? (
    <span
      className="ml-1.5 rounded border border-border px-1 py-px text-[10px] text-muted-foreground"
      title="Authenticated with a subscription (OAuth). Cost is Pi's list-price estimate, not a bill."
    >
      subscription
    </span>
  ) : null;
}

function UsagePage() {
  const settings = useSettings();
  if (settings.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading Pi Usage settings…
      </div>
    );
  }
  return <UsagePageContent preferences={resolveUsagePreferences(settings.values)} />;
}

function UsagePageContent({
  preferences,
}: {
  preferences: ReturnType<typeof resolveUsagePreferences>;
}) {
  const [range, setRange] = useState<Range>(preferences.defaultRange);
  const [source, setSource] = useState<Source>(preferences.defaultSource);
  const [fromDay, setFromDay] = useState(() => daysAgo(29));
  const [toDay, setToDay] = useState(() => daysAgo(0));
  const { data, error, loading, refresh } = useUsage(range, source, fromDay, toDay);
  const totalCost = data?.totals.cost ?? 0;
  const apiCost = useMemo(
    () =>
      data?.byProvider
        .filter((p) => !SUBSCRIPTION_PROVIDERS.has(p.provider))
        .reduce((sum, p) => sum + p.cost, 0) ?? 0,
    [data],
  );
  const missing = data?.scan.sources.filter((s) => !s.exists) ?? [];

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <span
              className="flex size-9 items-center justify-center rounded-lg"
              style={{
                color: "var(--timeline-accent)",
                backgroundColor: "color-mix(in oklch, var(--timeline-accent) 15%, transparent)",
              }}
            >
              <Icon name="ChartColumn" className="size-5" />
            </span>
            <div>
              <h1 className="font-semibold">Pi Usage</h1>
              <p className="text-xs text-muted-foreground">Cost and tokens across every provider and model</p>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Segmented label="Range" options={RANGES} value={range} onChange={setRange} />
          <Segmented label="Source" options={SOURCES} value={source} onChange={setSource} />
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <Icon name="RefreshCw" className={cn("size-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
        {range === "custom" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <Icon name="CalendarRange" className="size-4 text-[var(--timeline-accent)]" />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              From
              <Input
                type="date"
                value={fromDay}
                max={toDay}
                onChange={(event) => setFromDay(event.target.value)}
                className="h-8 w-36 text-foreground"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Through
              <Input
                type="date"
                value={toDay}
                min={fromDay}
                onChange={(event) => setToDay(event.target.value)}
                className="h-8 w-36 text-foreground"
              />
            </label>
            <span className="text-[11px] text-muted-foreground">Inclusive</span>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {missing.length > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Not found: {missing.map((s) => <code key={s.id} className="mr-2">{s.dir}</code>)}
            (change in Settings → Plugins → Pi Usage)
          </p>
        ) : null}

        {data === null ? (
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {loading ? "Indexing Pi sessions… the first scan can take a moment." : "No data yet."}
          </div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat
                label="Estimated cost"
                value={fmtCost(totalCost)}
                hint={apiCost !== totalCost ? `${fmtCost(apiCost)} on API keys` : undefined}
                icon="DollarSign"
                color={CHART_COLORS[0]!}
              />
              <Stat
                label="Assistant messages"
                value={data.totals.messages.toLocaleString()}
                icon="MessageSquare"
                color={CHART_COLORS[1]!}
              />
              <Stat
                label="Input / output"
                value={`${fmtTokens(data.totals.input)} / ${fmtTokens(data.totals.output)}`}
                hint={`${fmtTokens(data.totals.reasoning)} reasoning`}
                icon="ArrowLeftRight"
                color={CHART_COLORS[3]!}
              />
              <Stat
                label="Cache read / write"
                value={`${fmtTokens(data.totals.cacheRead)} / ${fmtTokens(data.totals.cacheWrite)}`}
                icon="Database"
                color={CHART_COLORS[2]!}
              />
            </div>

            {preferences.showDailyChart && data.byDay.length > 1 ? (
              <Section title="Cost per day">
                <DailyChart days={data.byDay} models={data.byDayModel} range={range} />
              </Section>
            ) : null}

            <Section title="By provider">
              {data.byProvider.length === 0 ? (
                <p className="text-sm text-muted-foreground">No usage in this range.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border">
                      <tr>
                        <th className={th}>Provider</th>
                        <th className={cn(th, "w-1/4")}>Share</th>
                        <th className={thR}>Cost</th>
                        <th className={thR}>Msgs</th>
                        <th className={thR}>Input</th>
                        <th className={thR}>Output</th>
                        <th className={thR}>Cache read</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.byProvider.map((p, index) => (
                        <tr key={p.provider} className="transition-colors hover:bg-muted/40">
                          <td className={td}>
                            <span
                              className="mr-2 inline-block size-2.5 rounded-sm"
                              style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                            />
                            {p.provider}
                            <ProviderBadge provider={p.provider} />
                          </td>
                          <td className={td}>
                            <ShareBar
                              share={totalCost > 0 ? p.cost / totalCost : 0}
                              color={CHART_COLORS[index % CHART_COLORS.length]!}
                            />
                          </td>
                          <td className={tdR}>{fmtCost(p.cost)}</td>
                          <td className={tdR}>{p.messages.toLocaleString()}</td>
                          <td className={tdR}>{fmtTokens(p.input)}</td>
                          <td className={tdR}>{fmtTokens(p.output)}</td>
                          <td className={tdR}>{fmtTokens(p.cacheRead)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {data.byModel.length > 0 ? (
              <Section title="By model">
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border">
                      <tr>
                        <th className={th}>Model</th>
                        <th className={thR}>Cost</th>
                        <th className={thR}>Msgs</th>
                        <th className={thR}>Input</th>
                        <th className={thR}>Output</th>
                        <th className={thR}>Last used</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.byModel.map((m, index) => (
                        <tr key={`${m.provider}/${m.model}`} className="transition-colors hover:bg-muted/40">
                          <td className={td}>
                            <span
                              className="mr-2 inline-block size-2.5 rounded-sm"
                              style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                            />
                            <span className="text-muted-foreground">{m.provider}/</span>
                            {m.model}
                          </td>
                          <td className={tdR}>{fmtCost(m.cost)}</td>
                          <td className={tdR}>{m.messages.toLocaleString()}</td>
                          <td className={tdR}>{fmtTokens(m.input)}</td>
                          <td className={tdR}>{fmtTokens(m.output)}</td>
                          <td className={cn(tdR, "text-muted-foreground")}>{m.lastUsed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            ) : null}

            <p className="mt-4 text-xs text-muted-foreground">
              Costs are Pi's estimates at list prices, recorded per message. Subscription
              providers aren't billed per token. {data.scan.files} session files indexed
              {data.scan.scannedAt
                ? ` · last scan ${new Date(data.scan.scannedAt).toLocaleTimeString()}`
                : ""}
              .
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Pi Usage",
    icon: "ChartColumn",
    path: "usage",
    component: UsagePage,
  });
});
