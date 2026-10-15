import { describe, expect, it } from "vitest";
import {
  DEFAULT_USAGE_PREFERENCES,
  resolveUsagePreferences,
} from "./preferences";

describe("resolveUsagePreferences", () => {
  it("preserves the current defaults when settings are absent", () => {
    expect(resolveUsagePreferences(undefined)).toEqual(
      DEFAULT_USAGE_PREFERENCES,
    );
  });

  it("accepts supported choices and rejects untrusted values", () => {
    expect(
      resolveUsagePreferences({
        defaultRange: "7d",
        defaultSource: "terminal",
        showDailyChart: false,
      }),
    ).toEqual({
      defaultRange: "7d",
      defaultSource: "terminal",
      showDailyChart: false,
    });

    expect(
      resolveUsagePreferences({
        defaultRange: "custom",
        defaultSource: "elsewhere",
        showDailyChart: "no",
      }),
    ).toEqual(DEFAULT_USAGE_PREFERENCES);
  });
});
