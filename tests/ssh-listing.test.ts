import { it, expect } from "vitest";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import { activate } from "../src/index";
it("uses SFTP listing metadata for file sizes without per-file stat requests", async () => {
  const operations: string[] = [];
  const uninstall = installRemoteWorkspaceTransport({
    async file(operation, args) {
      operations.push(operation);
      if (operation === "realpath") return args[0];
      if (operation === "open")
        throw Object.assign(new Error("missing ignore file"), {
          code: "ENOENT",
        });
      if (operation === "readFile")
        throw Object.assign(new Error("missing ignore file"), {
          code: "ENOENT",
        });
      if (operation === "readdir")
        return Array.from({ length: 100 }, (_, index) => ({
          name: `a${index}.txt`,
          size: index,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }));
      throw new Error(`Unexpected remote request: ${operation}`);
    },
    spawn() {
      throw new Error("unused");
    },
    async pty() {
      throw new Error("unused");
    },
  });
  try {
    const contribution = await activate({} as never);
    const ui = contribution.ui![0]!;
    const context = {
      workspacePath: "ssh://test/project",
      projectId: "p",
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    };
    const view = await ui.render(
      { id: ui.id, sessionId: "s", locale: "zh-CN" },
      context,
    );
    const entries = (view.data as any).rootEntries;
    expect(entries).toHaveLength(100);
    expect(entries.find((entry: any) => entry.name === "a99.txt").size).toBe(
      99,
    );
    expect(
      operations.filter((operation) => operation === "readdir"),
    ).toHaveLength(1);
    expect(operations).not.toContain("stat");
    expect(operations).not.toContain("statIdentity");
  } finally {
    uninstall();
  }
});
