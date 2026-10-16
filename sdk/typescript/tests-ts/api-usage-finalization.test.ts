import { hash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { copyCompletedScan } from "./plugin-root.js";
import { mockWorkbench, TestClient } from "./support/api-client.js";
import {
  codexFactory,
  completedEvents,
  scanRuntimeDependencies,
} from "./support/api-events.js";
import { createApiTestFixtures } from "./support/temporary-directories.js";

const { cleanup, temporaryDirectory } = createApiTestFixtures();
afterEach(cleanup);

test.each(["pending", "finalized", "unavailable", "standard"] as const)(
  "finalizes saved completion-turn usage when accounting is %s",
  async (scenario) => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    const scanDir = join(root, "scan");
    await Promise.all(
      [repository, codexHome, scanDir].map((path) => mkdir(path)),
    );
    const commands: Array<readonly string[]> = [];
    const warnings: string[] = [];
    const observerErrors: string[] = [];
    const accountingFailure = "Synthetic usage storage failure: token=fixture";
    const completionWarning = "Synthetic saved scan warning";
    let turnFinished = false;
    const client = TestClient.withDependencies({
      ...scanRuntimeDependencies(codexHome, scanDir),
      canRunDirectDeepScan: () => false,
      runWorkbench: async (_options, args, input) => {
        commands.push(args);
        if (args[0] === "complete-scan") {
          return {
            scan: {
              warnings: [completionWarning],
              ...(scenario === "standard"
                ? {}
                : {
                    usage: {
                      completion: {
                        threadId: "completion-thread",
                        turnId: "completion-turn",
                        finalized: scenario === "finalized",
                      },
                    },
                  }),
            },
          };
        }
        if (args[0] === "finalize-scan-usage") {
          expect(turnFinished).toBe(true);
          if (scenario === "unavailable") throw new Error(accountingFailure);
          return {};
        }
        return mockWorkbench(args, input);
      },
      createCodex: codexFactory(async () => {
        await copyCompletedScan(root);
        if (scenario !== "standard") {
          const coveragePath = join(scanDir, "coverage.json");
          const coverage = JSON.parse(await readFile(coveragePath, "utf8"));
          coverage.mode = "deep_repository";
          const coverageBytes = `${JSON.stringify(coverage)}\n`;
          await writeFile(coveragePath, coverageBytes);
          const manifestPath = join(scanDir, "scan-manifest.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          manifest.scan.artifacts.find(
            (artifact: { path: string }) => artifact.path === "coverage.json",
          ).sha256 = hash("sha256", coverageBytes);
          await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
        }
        async function* events() {
          yield* completedEvents();
          turnFinished = true;
        }
        return { events: events() };
      }),
    });
    try {
      const result = await client.run(repository, {
        mode: scenario === "standard" ? "standard" : "deep",
        onWarning: (warning) => {
          warnings.push(warning);
          if (warning.includes(accountingFailure))
            throw new Error("Synthetic warning observer failure");
        },
        onObserverError: (observer) => observerErrors.push(observer),
      });
      expect(result).toMatchObject({ scanDir, threadId: "thread-1" });
      const finalization = commands.filter(
        (args) => args[0] === "finalize-scan-usage",
      );
      if (scenario === "pending" || scenario === "unavailable") {
        expect(finalization).toEqual([
          [
            "finalize-scan-usage",
            "--scan-id",
            "scan_example_001",
            "--thread-id",
            "completion-thread",
            "--turn-id",
            "completion-turn",
            "--turn-status",
            "completed",
          ],
        ]);
        expect(commands.indexOf(finalization[0]!)).toBeGreaterThan(
          commands.findIndex((args) => args[0] === "complete-scan"),
        );
      } else {
        expect(finalization).toEqual([]);
      }
      expect(warnings).toEqual([
        ...(scenario === "unavailable"
          ? [`Could not finalize scan token usage: ${accountingFailure}`]
          : []),
        completionWarning,
      ]);
      expect(observerErrors).toEqual(
        scenario === "unavailable" ? ["onWarning"] : [],
      );
      expect(commands.some((args) => args[0] === "fail-scan")).toBe(false);
    } finally {
      await client.close();
    }
  },
);
