import { afterEach, expect, it, vi } from "vitest";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import { activate } from "../src/index";

afterEach(() => vi.useRealTimers());

it("keeps simultaneous folder results separate and does not reread an open resource after actions", async () => {
  const calls: string[] = [];
  const uninstall = installRemoteWorkspaceTransport({
    async file(operation, args) {
      calls.push(operation);
      if (operation === "realpath") return args[0];
      if (operation === "readFile") return "";
      if (operation === "readdir") return [];
      if (operation === "stat") return { isFile: () => true, size: 4 };
      if (operation === "readVersion")
        return {
          content: Buffer.from("text"),
          version: { exists: true, size: 4, sha256: "hash" },
        };
      throw new Error(`Unexpected remote request ${operation}`);
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
    const first = {
      workspacePath: "ssh://test/project",
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    };
    const second = { ...first };
    const request = {
      id: ui.id,
      sessionId: "s",
      locale: "zh-CN",
      resource: JSON.stringify({ path: "a.txt" }),
    };
    const secondRequest = { ...request };
    expect((await ui.render(request, first)).data).toMatchObject({
      resourceFile: { content: "text" },
    });
    calls.length = 0;
    await Promise.all([
      ui.act!(
        { id: "list", value: JSON.stringify({ path: "one" }) },
        first,
        request,
      ),
      ui.act!(
        { id: "list", value: JSON.stringify({ path: "two" }) },
        second,
        secondRequest,
      ),
    ]);
    const count = calls.length;
    expect((await ui.render(secondRequest, { ...second })).data).toMatchObject({
      result: { path: "two" },
    });
    expect((await ui.render(request, { ...first })).data).toMatchObject({
      result: { path: "one" },
    });
    expect(calls).toHaveLength(count);
    expect(calls).not.toContain("readVersion");
    expect(calls).not.toContain("stat");
  } finally {
    uninstall();
  }
});

it("opens in two transport-delay steps and expands a folder in three without rereading the root", async () => {
  vi.useFakeTimers();
  const calls: { operation: string; path: unknown }[] = [];
  const uninstall = installRemoteWorkspaceTransport({
    async file(operation, args) {
      calls.push({ operation, path: args[0] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (operation === "realpath") return args[0];
      if (operation === "readFile") return "hidden.txt";
      if (operation === "readdir")
        return ["visible.txt", "hidden.txt"].map((name) => ({
          name,
          size: 10,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }));
      throw new Error(`Unexpected remote request ${operation}`);
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
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    };
    const request = { id: ui.id, sessionId: "s", locale: "zh-CN" };
    const start = Date.now();
    const initial = ui.render(request, context);
    await vi.runAllTimersAsync();
    expect((await initial).data).toMatchObject({
      rootEntries: [{ name: "visible.txt" }],
    });
    expect(Date.now() - start).toBe(200);
    expect(calls).toHaveLength(4);
    calls.length = 0;
    const before = Date.now();
    const expand = (async () => {
      await ui.act!(
        { id: "list", value: JSON.stringify({ path: "folder" }) },
        context,
        request,
      );
      return ui.render(request, context);
    })();
    await vi.runAllTimersAsync();
    const view = await expand;
    expect(Date.now() - before).toBe(300);
    expect(calls).toHaveLength(5);
    expect(calls.filter((call) => call.operation === "readdir")).toEqual([
      { operation: "readdir", path: "ssh://test/project/folder" },
    ]);
    expect(view.data).toMatchObject({
      result: { path: "folder", entries: [{ name: "visible.txt" }] },
    });
    expect(view.data).not.toHaveProperty("rootEntries");
    const refresh = (async () => {
      await ui.act!(
        { id: "list", value: JSON.stringify({ path: "" }) },
        context,
        request,
      );
      return ui.render(request, context);
    })();
    await vi.runAllTimersAsync();
    expect((await refresh).data).toMatchObject({
      rootEntries: [{ name: "visible.txt" }],
    });
  } finally {
    uninstall();
  }
});
