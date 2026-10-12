import { it, expect } from "vitest";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import { activate } from "../src/index";

it("passes content versions and workspace boundaries to remote saves and uses exclusive rename", async () => {
  const calls: { operation: string; args: unknown[] }[] = [];
  const version = {
    exists: true,
    size: 5,
    mtimeMs: 1000,
    mode: 0o100644,
    sha256: "content-hash",
  };
  const uninstall = installRemoteWorkspaceTransport({
    async file(operation, args) {
      calls.push({ operation, args });
      if (operation === "realpath") return args[0];
      if (operation === "stat")
        return { isFile: () => true, size: 5, mtimeMs: 1000 };
      if (operation === "readdir") return [];
      if (operation === "readFile") return "";
      if (operation === "readVersion")
        return { content: Buffer.from("first"), version };
      if (operation === "writeVersion")
        return { version: { ...version, sha256: "new-hash" } };
      if (operation === "renameExclusive") return;
      throw new Error(`Unexpected operation: ${operation}`);
    },
    spawn() {
      throw new Error("unused");
    },
    async pty() {
      throw new Error("unused");
    },
  });
  try {
    const ui = (await activate({} as never)).ui![0]!;
    const context = {
      workspacePath: "ssh://test/project",
      sessionId: "remote-save",
      projectId: "p",
      runId: "r",
      signal: new AbortController().signal,
    };
    const request = {
      id: ui.id,
      sessionId: context.sessionId,
      locale: "zh-CN",
    };
    await ui.act!(
      { id: "read", value: JSON.stringify({ path: "a.txt" }) },
      context,
      request,
    );
    const view = await ui.render(request, context);
    expect(JSON.parse((view.data as any).result.version)).toEqual(version);
    await ui.act!(
      {
        id: "save",
        value: JSON.stringify({
          path: "a.txt",
          content: "saved",
          version: JSON.stringify(version),
        }),
      },
      context,
      request,
    );
    const save = calls.find((call) => call.operation === "writeVersion")!;
    expect(save.args[0]).toBe("ssh://test/project/a.txt");
    expect(save.args[1]).toMatchObject({
      expectedVersion: version,
      workspaceRoot: context.workspacePath,
      signal: context.signal,
    });
    await ui.act!(
      {
        id: "rename",
        value: JSON.stringify({ path: "a.txt", target: "b.txt" }),
      },
      context,
      request,
    );
    expect(calls.some((call) => call.operation === "renameExclusive")).toBe(
      true,
    );
    expect(
      calls.some(
        (call) => call.operation === "writeFile" || call.operation === "rename",
      ),
    ).toBe(false);
  } finally {
    uninstall();
  }
});
