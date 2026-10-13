import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import { activate } from "../src/index";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function panel(root: string) {
  const ui = (await activate({} as never)).ui![0]!;
  const context = { workspacePath: root, projectId: "p", sessionId: "s", runId: "r", signal: new AbortController().signal };
  const request = { id: ui.id, sessionId: "s", locale: "zh-CN" };
  return { ui, context, request };
}
it("keeps the file manager view when the root is renamed and recovers on refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-panel-error-")); roots.push(root);
  const original = join(root, "project"); await mkdir(original);
  const { ui, context, request } = await panel(original);
  await rename(original, join(root, "moved"));
  const view = await ui.render(request, context);
  expect(view.title).toBe("文件管理器");
  expect(view.data).toMatchObject({ rootName: "project", rootEntries: [], rootError: expect.stringContaining("ENOENT") });
  await mkdir(original);
  await writeFile(join(original, "recovered.txt"), "hello");
  const next = await ui.render(request, context);
  expect((next.data as any).rootError).toBeUndefined();
  expect((next.data as any).rootEntries).toHaveLength(1);
});
it("keeps a working tree when the requested file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-file-error-")); roots.push(root);
  await writeFile(join(root, "existing.txt"), "hello");
  const { ui, context, request } = await panel(root);
  const view = await ui.render({ ...request, resource: JSON.stringify({ path: "missing.txt" }) }, context);
  expect((view.data as any).rootError).toBeUndefined();
  expect((view.data as any).resourceError).toContain("ENOENT");
  expect((view.data as any).rootEntries).toHaveLength(1);
  const bound = { ...request, resource: JSON.stringify({ path: "missing.txt" }) };
  await ui.act!({ id: "read", value: JSON.stringify({ path: "existing.txt" }) }, context, bound);
  expect((await ui.render(bound, context)).data).toMatchObject({ result: { path: "existing.txt", content: "hello" } });
});
it("returns a file manager view when the remote connection is refused", async () => {
  const stop = installRemoteWorkspaceTransport({ file: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1070"); }, spawn: () => { throw new Error("unused"); }, pty: async () => { throw new Error("unused"); } });
  try {
    const { ui, context, request } = await panel("ssh://profile/project");
    expect((await ui.render(request, context)).data).toMatchObject({ rootEntries: [], rootError: expect.stringContaining("ECONNREFUSED") });
  } finally { stop(); }
});
