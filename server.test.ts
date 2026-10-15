import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { initializePiUsagePlugin } from "./server";
import type { UsageSummary } from "./server";

const temporaryDirectories: string[] = [];

async function temporarySessionDirectory(name: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-test-"));
  temporaryDirectories.push(root);
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  return directory;
}

function sessionLine(provider: string, cost: number) {
  const entry = {
    type: "message",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      provider,
      model: "test-model",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        cost: { total: cost },
      },
    },
  };
  return `${JSON.stringify(entry)}\n`;
}

async function writeSession(
  directory: string,
  provider: string,
  cost: number,
  filename = "session.jsonl",
) {
  await writeFile(join(directory, filename), sessionLine(provider, cost));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Pi Usage settings", () => {
  it("declares documented defaults and validates session directories", async () => {
    const terminalSessionsDir = await temporarySessionDirectory("terminal");
    const bbSessionsDir = await temporarySessionDirectory("bb");
    const host = createFakePluginHost({
      pluginId: "pi-usage",
      settings: { terminalSessionsDir, bbSessionsDir },
    });
    await plugin(host.bb);

    expect(host.harness.inspection.registrations.settingsDescriptors).toMatchObject({
      defaultRange: { type: "select", default: "30d" },
      defaultSource: { type: "select", default: "all" },
      showDailyChart: { type: "boolean", default: true },
      terminalSessionsDir: { type: "string" },
      bbSessionsDir: { type: "string" },
    });
    await expect(
      host.harness.behavior.setSettings({ terminalSessionsDir: "relative/path" }),
    ).rejects.toThrow("absolute path");
    await expect(
      host.harness.behavior.setSettings({ defaultRange: "custom" }),
    ).rejects.toThrow();

    await host.harness.lifecycle.dispose();
  });

  it("persists report defaults and applies source-directory changes", async () => {
    const terminalSessionsDir = await temporarySessionDirectory("terminal");
    const firstBbSessionsDir = await temporarySessionDirectory("bb-first");
    const nextBbSessionsDir = await temporarySessionDirectory("bb-next");
    await writeSession(terminalSessionsDir, "terminal-provider", 1);
    await writeSession(firstBbSessionsDir, "old-bb-provider", 2);
    await writeSession(nextBbSessionsDir, "next-bb-provider", 3);

    const host = createFakePluginHost({
      pluginId: "pi-usage",
      settings: {
        terminalSessionsDir,
        bbSessionsDir: firstBbSessionsDir,
        defaultRange: "all",
        defaultSource: "terminal",
      },
    });
    await plugin(host.bb);

    const terminalReport = await host.harness.behavior.runCli(["summary"]);
    expect(terminalReport.stdout).toContain("range all, source terminal");
    expect(terminalReport.stdout).toContain("terminal-provider");
    expect(terminalReport.stdout).not.toContain("old-bb-provider");

    await host.harness.behavior.setSettings({
      defaultSource: "bb",
      bbSessionsDir: nextBbSessionsDir,
    });
    const changed = (await host.harness.behavior.callRpc("usage_summary", {
      range: "all",
      source: "bb",
      refresh: true,
    })) as UsageSummary;
    expect(changed.byProvider.map((row) => row.provider)).toEqual([
      "next-bb-provider",
    ]);

    const reloaded = await host.harness.lifecycle.reload(plugin);
    const persistedReport = await reloaded.harness.behavior.runCli(["summary"]);
    expect(persistedReport.stdout).toContain("range all, source bb");
    expect(persistedReport.stdout).toContain("next-bb-provider");

    await reloaded.harness.lifecycle.dispose();
  });

  it("invalidates an open report when its directory changes to empty", async () => {
    const terminalSessionsDir = await temporarySessionDirectory("terminal");
    const populatedBbSessionsDir = await temporarySessionDirectory("bb-populated");
    const emptyBbSessionsDir = await temporarySessionDirectory("bb-empty");
    await writeSession(populatedBbSessionsDir, "old-bb-provider", 2);

    const host = createFakePluginHost({
      pluginId: "pi-usage",
      settings: {
        terminalSessionsDir,
        bbSessionsDir: populatedBbSessionsDir,
      },
    });
    await plugin(host.bb);
    const populated = (await host.harness.behavior.callRpc("usage_summary", {
      range: "all",
      source: "bb",
      refresh: true,
    })) as UsageSummary;
    expect(populated.byProvider.map((row) => row.provider)).toEqual([
      "old-bb-provider",
    ]);

    const signalsBeforeChange = host.harness.inspection.realtimeSignals.length;
    await host.harness.behavior.setSettings({
      bbSessionsDir: emptyBbSessionsDir,
    });
    expect(
      host.harness.inspection.realtimeSignals.slice(signalsBeforeChange),
    ).toContainEqual({
      channel: "usage-changed",
      payload: { reason: "session-directories-changed" },
    });

    // This is the same non-forced request the mounted page makes after its
    // useRealtime subscription receives the invalidation.
    const emptied = (await host.harness.behavior.callRpc("usage_summary", {
      range: "all",
      source: "bb",
      refresh: false,
    })) as UsageSummary;
    expect(emptied.totals.messages).toBe(0);
    expect(emptied.byProvider).toEqual([]);
    expect(emptied.scan.sources.find((source) => source.id === "bb")).toMatchObject({
      dir: emptyBbSessionsDir,
      exists: true,
    });

    await host.harness.lifecycle.dispose();
  });

  it("removes old-path rows when a concurrent path change is followed by an open failure", async () => {
    const terminalSessionsDir = await temporarySessionDirectory("terminal");
    const oldBbSessionsDir = await temporarySessionDirectory("bb-old");
    const emptyBbSessionsDir = await temporarySessionDirectory("bb-empty");
    await writeSession(oldBbSessionsDir, "old-a", 1, "a.jsonl");
    await writeSession(oldBbSessionsDir, "old-b", 1, "b.jsonl");

    let induceConcurrentFailure = false;
    let opensDuringFailure = 0;
    let host: ReturnType<typeof createFakePluginHost>;
    host = createFakePluginHost({
      pluginId: "pi-usage",
      settings: {
        terminalSessionsDir,
        bbSessionsDir: oldBbSessionsDir,
      },
    });
    await initializePiUsagePlugin(host.bb, {
      async openSessionFile(path) {
        if (induceConcurrentFailure) {
          opensDuringFailure += 1;
          if (opensDuringFailure === 2) {
            throw new Error("deterministic session open failure");
          }
        }
        const handle = await open(path, "r");
        return {
          async read(buffer, offset, length, position) {
            if (induceConcurrentFailure && opensDuringFailure === 1) {
              await host.harness.behavior.setSettings({
                bbSessionsDir: emptyBbSessionsDir,
              });
            }
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
    });

    await host.harness.behavior.callRpc("usage_summary", {
      range: "all",
      source: "bb",
      refresh: true,
    });
    await appendFile(join(oldBbSessionsDir, "a.jsonl"), sessionLine("old-a", 1));
    await appendFile(join(oldBbSessionsDir, "b.jsonl"), sessionLine("old-b", 1));
    induceConcurrentFailure = true;

    const result = (await host.harness.behavior.callRpc("usage_summary", {
      range: "all",
      source: "bb",
      refresh: true,
    })) as UsageSummary;
    expect(opensDuringFailure).toBe(2);
    expect(result.totals.messages).toBe(0);
    expect(result.byProvider).toEqual([]);
    expect(result.scan.sources.find((source) => source.id === "bb")).toMatchObject({
      dir: emptyBbSessionsDir,
      exists: true,
    });

    await host.harness.lifecycle.dispose();
  });
});
