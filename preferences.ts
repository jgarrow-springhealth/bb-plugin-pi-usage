export const REPORT_RANGES = ["today", "7d", "30d", "90d", "all"] as const;
export type DefaultRange = (typeof REPORT_RANGES)[number];

export const REPORT_SOURCES = ["all", "terminal", "bb"] as const;
export type DefaultSource = (typeof REPORT_SOURCES)[number];

export type UsagePreferences = {
  defaultRange: DefaultRange;
  defaultSource: DefaultSource;
  showDailyChart: boolean;
};

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = {
  defaultRange: "30d",
  defaultSource: "all",
  showDailyChart: true,
};

/** Validate the non-secret values exposed to the app before using them. */
export function resolveUsagePreferences(
  values: Record<string, string | number | boolean> | undefined,
): UsagePreferences {
  const defaultRange = REPORT_RANGES.find(
    (range) => range === values?.defaultRange,
  );
  const defaultSource = REPORT_SOURCES.find(
    (source) => source === values?.defaultSource,
  );
  return {
    defaultRange: defaultRange ?? DEFAULT_USAGE_PREFERENCES.defaultRange,
    defaultSource: defaultSource ?? DEFAULT_USAGE_PREFERENCES.defaultSource,
    showDailyChart:
      typeof values?.showDailyChart === "boolean"
        ? values.showDailyChart
        : DEFAULT_USAGE_PREFERENCES.showDailyChart,
  };
}
