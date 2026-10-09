import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activate } from "../src/index";

const context = (workspacePath: string) => ({
  workspacePath,
  projectId: "project",
  sessionId: "session",
  runId: "run",
  signal: new AbortController().signal,
});
async function panel(workspacePath: string) {
  const contributions = await activate({} as never);
  const ui = contributions.ui?.[0];
  if (!ui?.act) throw new Error("file manager panel missing");
  const ctx = context(workspacePath);
  const request = { id: ui.id, sessionId: "session", locale: "zh-CN" };
  return { ui, ctx, request };
}

describe("file manager panel", () => {
  it("lists folders first, reads text and saves with a version check", async () => {
    const root = await mkdtemp(join(tmpdir(), "modera-files-"));
    await writeFile(join(root, "z.txt"), "before");
    await mkdir(join(root, "folder"));
    const { ui, ctx, request } = await panel(root);
    const initial = await ui.render(request, ctx);
    expect(
      (initial.data as { rootEntries: { name: string }[] }).rootEntries.map(
        (entry) => entry.name,
      ),
    ).toEqual(["folder", "z.txt"]);
    await ui.act!(
      { id: "read", value: JSON.stringify({ path: "z.txt" }) },
      ctx,
      request,
    );
    const opened = (await ui.render(request, ctx)).data as {
      result: { version: string };
    };
    await ui.act!(
      {
        id: "save",
        value: JSON.stringify({
          path: "z.txt",
          content: "after",
          version: opened.result.version,
        }),
      },
      ctx,
      request,
    );
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("after");
  });

  it("rejects traversal, project root deletion and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "modera-files-"));
    const outside = await mkdtemp(join(tmpdir(), "modera-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"), "junction");
    const { ui, ctx, request } = await panel(root);
    await expect(
      ui.act!(
        { id: "read", value: JSON.stringify({ path: "../secret.txt" }) },
        ctx,
        request,
      ),
    ).rejects.toThrow("项目范围");
    await expect(
      ui.act!(
        { id: "delete", value: JSON.stringify({ path: "" }) },
        ctx,
        request,
      ),
    ).rejects.toThrow();
    await expect(
      ui.act!(
        { id: "read", value: JSON.stringify({ path: "escape/secret.txt" }) },
        ctx,
        request,
      ),
    ).rejects.toThrow("符号链接");
    await expect(stat(root)).resolves.toBeTruthy();
  });

  it("applies gitignore rules to directory listings and filename search", async () => {
    const root = await mkdtemp(join(tmpdir(), "modera-files-"));
    await writeFile(join(root, ".gitignore"), "ignored.txt\nbuild/\n");
    await writeFile(join(root, "visible-result.ts"), "export {};");
    await writeFile(join(root, "ignored.txt"), "hidden");
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build", "hidden-result.ts"), "hidden");
    const { ui, ctx, request } = await panel(root);
    const initial = await ui.render(request, ctx);
    expect(
      (initial.data as { rootEntries: { name: string }[] }).rootEntries.map(
        (entry) => entry.name,
      ),
    ).toEqual([".gitignore", "visible-result.ts"]);
    await ui.act!(
      { id: "search", value: JSON.stringify({ query: "result" }) },
      ctx,
      request,
    );
    const searched = (await ui.render(request, ctx)).data as {
      result: { entries: { path: string }[] };
    };
    expect(searched.result.entries.map((entry) => entry.path)).toEqual([
      "visible-result.ts",
    ]);
  });

  it("opens project resources normally and external resources as preview-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "modera-files-"));
    const outside = await mkdtemp(join(tmpdir(), "modera-outside-"));
    await writeFile(join(root, "inside.md"), "# Inside");
    const external = join(outside, "outside.md");
    await writeFile(external, "# Outside");
    const { ui, ctx, request } = await panel(root);
    const inside = await ui.render(
      { ...request, resource: JSON.stringify({ path: "inside.md" }) },
      ctx,
    );
    expect(inside.data).toMatchObject({ resourceFile: { path: "inside.md" } });
    expect(
      (inside.data as { resourceFile: { external?: boolean } }).resourceFile
        .external,
    ).toBeUndefined();
    const externalRequest = {
      ...request,
      resource: JSON.stringify({ path: external }),
    };
    const preview = await ui.render(externalRequest, ctx);
    expect(preview.data).toMatchObject({
      rootEntries: [],
      resourceFile: { external: true, content: "# Outside" },
    });
    await expect(
      ui.act!(
        {
          id: "save",
          value: JSON.stringify({
            path: external,
            content: "changed",
            version: "old",
          }),
        },
        ctx,
        externalRequest,
      ),
    ).rejects.toThrow("只读预览");
  });
});

it("previews image bytes in the file panel and prevents text overwrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-file-image-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=", "base64");
  await writeFile(join(root, "picture.png"), png);
  const { ui, ctx, request } = await panel(root);
  await ui.act!({ id: "read", value: JSON.stringify({ path: "picture.png" }) }, ctx, request);
  const opened = (await ui.render(request, ctx)).data as { result: { imageSource: string; version: string } };
  expect(opened.result.imageSource).toBe(`data:image/png;base64,${png.toString("base64")}`);
  await expect(ui.act!({ id: "save", value: JSON.stringify({ path: "picture.png", content: "oops", version: opened.result.version }) }, ctx, request)).rejects.toThrow("图片仅支持预览");
  expect(await readFile(join(root, "picture.png"))).toEqual(png);
});
