import { randomUUID } from "node:crypto";
import { spawn } from "@modera/plugin-sdk/workspace-process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "@modera/plugin-sdk/workspace-fs";
import {
  basename,
  isRemotePath,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@modera/plugin-sdk/workspace-path";
import type { PluginModule, ToolContext } from "@modera/plugin-sdk";
import createIgnore, { type Ignore } from "ignore";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_SEARCHED = 200_000;
const MAX_RESULTS = 200;
const openerCandidates =
  process.platform === "win32"
    ? [
        {
          id: "cursor",
          label: "Cursor",
          paths: [
            process.env.LOCALAPPDATA &&
              join(
                process.env.LOCALAPPDATA,
                "Programs",
                "cursor",
                "Cursor.exe",
              ),
            process.env.ProgramFiles &&
              join(process.env.ProgramFiles, "Cursor", "Cursor.exe"),
          ],
        },
        {
          id: "zed",
          label: "Zed",
          paths: [
            process.env.LOCALAPPDATA &&
              join(process.env.LOCALAPPDATA, "Programs", "Zed", "Zed.exe"),
          ],
        },
      ]
    : [];
async function availableOpeners() {
  const found: { id: string; label: string; executable: string }[] = [];
  for (const candidate of openerCandidates)
    for (const executable of candidate.paths) {
      if (!executable) continue;
      if (
        await access(executable).then(
          () => true,
          () => false,
        )
      ) {
        found.push({ id: candidate.id, label: candidate.label, executable });
        break;
      }
    }
  return found;
}
async function launchFile(target: string, opener: unknown) {
  if (isRemotePath(target)) throw new Error("远程文件请在 Modera 中查看或编辑");
  const id = text(opener, "opener");
  let executable: string;
  let args: string[];
  if (id === "folder") {
    executable =
      process.platform === "win32"
        ? "explorer.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    args =
      process.platform === "win32" ? [`/select,${target}`] : [dirname(target)];
  } else if (id === "default") {
    executable =
      process.platform === "win32"
        ? "rundll32.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", target]
        : [target];
  } else {
    const selected = (await availableOpeners()).find((item) => item.id === id);
    if (!selected) throw new Error("所选编辑器不可用");
    executable = selected.executable;
    args = [target];
  }
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(executable, args, {
      detached: true,
      env,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
type Entry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  extension?: string;
};
type Result =
  | { type: "listing"; path: string; entries: Entry[] }
  | {
      type: "search";
      query: string;
      entries: Entry[];
      scanned: number;
      truncated: boolean;
    }
  | {
      type: "file";
      path: string;
      content: string;
      version: string;
      size: number;
      external?: boolean;
      imageSource?: string;
    }
  | {
      type: "changed";
      path?: string;
      removed?: string;
      parent: string;
      entries: Entry[];
      version?: string;
    };

const outputs = new Map<string, Result>();
async function ignoreRules(root: string): Promise<Ignore> {
  const rules = createIgnore();
  for (const name of [".gitignore", ".ignore"]) {
    const content = await readFile(join(root, name), "utf8").catch(() => "");
    if (content) rules.add(content);
  }
  return rules;
}
const ignored = (rules: Ignore, path: string, directory: boolean) =>
  !!path && rules.ignores(directory ? `${path}/` : path);
const parse = (value?: string): Record<string, unknown> => {
  if (!value || value.length > MAX_TEXT_BYTES + 10_000)
    throw new Error("无效或过大的请求");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("无效请求");
  return parsed as Record<string, unknown>;
};
const text = (value: unknown, key: string, allowEmpty = false) => {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${key} 无效`);
  return value;
};
const rootOf = async (context: ToolContext) => {
  if (!context.workspacePath) throw new Error("请先打开一个项目");
  return realpath(context.workspacePath);
};
const cleanRelative = (value: unknown) => {
  const raw = text(value ?? "", "path", true)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (isAbsolute(raw) || raw.split("/").some((part) => part === ".."))
    throw new Error("路径超出项目范围");
  if (raw.split("/").includes(".git")) throw new Error("不允许访问 .git");
  return raw.replace(/^\/+|\/+$/g, "");
};
const inside = (root: string, target: string, allowRoot = false) => {
  const rel = relative(root, target);
  return (
    (allowRoot && !rel) ||
    (!!rel &&
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..\\`) &&
      !rel.startsWith("../"))
  );
};
async function existing(root: string, value: unknown, allowRoot = false) {
  const rel = cleanRelative(value);
  const target = await realpath(resolve(root, rel));
  if (!inside(root, target, allowRoot))
    throw new Error("路径超出项目范围或指向符号链接");
  return { rel, target };
}
async function destination(root: string, value: unknown) {
  const rel = cleanRelative(value);
  if (!rel) throw new Error("不能修改项目根目录");
  const target = resolve(root, rel);
  const parent = await realpath(dirname(target));
  if (!inside(root, parent, true)) throw new Error("目标路径超出项目范围");
  return { rel, target };
}
async function list(root: string, value: unknown): Promise<Entry[]> {
  const { rel, target } = await existing(root, value, true);
  const rules = await ignoreRules(root);
  const items = await readdir(target, { withFileTypes: true });
  if (items.length > MAX_ENTRIES)
    throw new Error(`目录项目超过 ${MAX_ENTRIES} 项`);
  const entries = await Promise.all(
    items
      .filter((item) => {
        const path = rel ? `${rel}/${item.name}` : item.name;
        return (
          !item.isSymbolicLink() &&
          item.name !== ".git" &&
          !ignored(rules, path, item.isDirectory())
        );
      })
      .map(async (item) => {
        const path = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory())
          return { name: item.name, path, kind: "directory" as const };
        const info = await stat(join(target, item.name));
        return {
          name: item.name,
          path,
          kind: "file" as const,
          size: info.size,
          extension: extname(item.name).toLowerCase(),
        };
      }),
  );
  return entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.kind === "directory"
        ? -1
        : 1,
  );
}
async function search(root: string, value: unknown): Promise<Result> {
  const query = text(value, "query").trim();
  if (query.length > 200) throw new Error("搜索词过长");
  const needle = query.toLocaleLowerCase();
  const rules = await ignoreRules(root);
  const queue = [{ path: "", target: root }];
  const entries: Entry[] = [];
  let scanned = 0;
  while (
    queue.length &&
    scanned < MAX_SEARCHED &&
    entries.length < MAX_RESULTS
  ) {
    const current = queue.shift()!;
    const items = await readdir(current.target, { withFileTypes: true }).catch(
      () => [],
    );
    for (const item of items) {
      if (++scanned > MAX_SEARCHED) break;
      const path = current.path ? `${current.path}/${item.name}` : item.name;
      if (
        item.name === ".git" ||
        item.isSymbolicLink() ||
        ignored(rules, path, item.isDirectory())
      )
        continue;
      if (item.isDirectory())
        queue.push({ path, target: join(current.target, item.name) });
      else if (item.name.toLocaleLowerCase().includes(needle)) {
        const info = await stat(join(current.target, item.name));
        entries.push({
          name: item.name,
          path,
          kind: "file",
          size: info.size,
          extension: extname(item.name).toLowerCase(),
        });
        if (entries.length >= MAX_RESULTS) break;
      }
    }
  }
  return {
    type: "search",
    query,
    entries,
    scanned,
    truncated: queue.length > 0 || scanned >= MAX_SEARCHED,
  };
}
async function read(root: string, value: unknown): Promise<Result> {
  const { rel, target } = await existing(root, value);
  return readTarget(target, rel);
}
async function readTarget(
  target: string,
  displayPath: string,
  external = false,
): Promise<Result> {
  const info = await stat(target);
  const image = /\.(png|jpe?g|webp|gif|bmp)$/i.test(displayPath);
  if (!info.isFile() || info.size > (image ? 25 * 1024 * 1024 : MAX_TEXT_BYTES))
    throw new Error(image ? "图片超过 25 MiB" : "只支持 2 MiB 以内的文本文件");
  const bytes = await readFile(target);
  if (image) {
    const ext = extname(displayPath).slice(1).toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    return { type: "file", path: displayPath, content: "", version: `${info.mtimeMs}:${info.size}`, size: info.size,
      imageSource: `data:${mime};base64,${bytes.toString("base64")}`, ...(external ? { external: true } : {}) };
  }
  if (bytes.includes(0)) throw new Error("二进制文件暂不支持编辑");
  return {
    type: "file",
    path: displayPath,
    content: bytes.toString("utf8"),
    version: `${info.mtimeMs}:${info.size}`,
    size: info.size,
    ...(external ? { external: true } : {}),
  };
}
async function resourceFile(
  root: string,
  resource?: string,
): Promise<Extract<Result, { type: "file" }> | undefined> {
  if (!resource) return undefined;
  let requested = text(parse(resource).path, "path");
  if (requested.startsWith("file://")) {
    const url = new URL(requested);
    requested = decodeURIComponent(url.pathname).replace(
      /^\/([a-zA-Z]:\/)/,
      "$1",
    );
  }
  const target = await realpath(
    isRemotePath(root) ? resolve(root, requested) : isAbsolute(requested) ? requested : resolve(root, cleanRelative(requested)),
  );
  if (inside(root, target)) {
    const rel = relative(root, target).replace(/\\/g, "/");
    return (await readTarget(target, rel)) as Extract<Result, { type: "file" }>;
  }
  const parts = target.toLowerCase().split(/[\\/]/);
  if (
    parts.some((part) => [".ssh", ".aws", ".gnupg", ".git"].includes(part)) ||
    parts.some((part) => part === ".env" || part.startsWith(".env.")) ||
    [".pem", ".key", ".p12", ".pfx"].includes(extname(target).toLowerCase())
  )
    throw new Error("不允许预览敏感凭据文件");
  return (await readTarget(target, target, true)) as Extract<
    Result,
    { type: "file" }
  >;
}
async function changed(
  root: string,
  path: string,
  version?: string,
  removed?: string,
): Promise<Result> {
  const parent = dirname(path).replace(/\\/g, "/").replace(/^\.$/, "");
  return {
    type: "changed",
    path,
    parent,
    entries: await list(root, parent),
    ...(version ? { version } : {}),
    ...(removed ? { removed } : {}),
  };
}

export const activate: PluginModule["activate"] = async () => ({
  ui: [
    {
      id: "modera.file-manager.panel",
      slot: "panel",
      accepts: "file",
      frontend: "manager",
      launcher: {
        title: "File Manager",
        icon: "file",
        locales: { "zh-CN": { title: "文件管理器" } },
      },
      requiredPermissions: [
        "workspace.read",
        "workspace.write",
        "process.spawn",
      ],
      actions: [
        "list",
        "search",
        "read",
        "save",
        "create",
        "rename",
        "delete",
        "open",
      ],
      async act(action, context, request) {
        const root = await rootOf(context);
        const input = parse(action.value);
        const opened = await resourceFile(root, request.resource);
        if (opened?.external && !["read", "open"].includes(action.id))
          throw new Error("项目外文件仅支持只读预览");
        let result: Result;
        if (action.id === "open") {
          const target = opened?.external
            ? opened.path
            : (await existing(root, input.path)).target;
          await launchFile(target, input.opener);
          return;
        } else if (action.id === "list") {
          const path = cleanRelative(input.path);
          result = { type: "listing", path, entries: await list(root, path) };
        } else if (action.id === "search")
          result = await search(root, input.query);
        else if (action.id === "read") result = await read(root, input.path);
        else if (action.id === "save") {
          const { rel, target } = await existing(root, input.path);
          if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(rel)) throw new Error("图片仅支持预览");
          const content = text(input.content, "content", true);
          if (Buffer.byteLength(content) > MAX_TEXT_BYTES)
            throw new Error("文件超过 2 MiB");
          const info = await stat(target);
          if (`${info.mtimeMs}:${info.size}` !== text(input.version, "version"))
            throw new Error("文件已被其他程序修改，请重新打开后再保存");
          const temporary = join(
            dirname(target),
            `.${basename(target)}.${randomUUID()}.tmp`,
          );
          try {
            await writeFile(temporary, content, { mode: info.mode });
            await rename(temporary, target);
          } catch (error) {
            await unlink(temporary).catch(() => {});
            throw error;
          }
          const next = await stat(target);
          result = await changed(root, rel, `${next.mtimeMs}:${next.size}`);
        } else if (action.id === "create") {
          const { rel, target } = await destination(root, input.path);
          if (input.kind === "directory") await mkdir(target);
          else await writeFile(target, "", { flag: "wx" });
          result = await changed(root, rel);
        } else if (action.id === "rename") {
          const source = await existing(root, input.path);
          const target = await destination(root, input.target);
          await rename(source.target, target.target);
          result = await changed(root, target.rel, undefined, source.rel);
        } else if (action.id === "delete") {
          const source = await existing(root, input.path);
          const info = await lstat(source.target);
          await rm(source.target, {
            recursive: info.isDirectory(),
            force: false,
          });
          const parent = dirname(source.rel)
            .replace(/\\/g, "/")
            .replace(/^\.$/, "");
          result = {
            type: "changed",
            parent,
            entries: await list(root, parent),
            removed: source.rel,
          };
        } else throw new Error("未知文件操作");
        outputs.set(context.sessionId, result);
      },
      async render(request, context) {
        const root = await rootOf(context);
        const result = outputs.get(context.sessionId);
        outputs.delete(context.sessionId);
        const opened = await resourceFile(root, request.resource);
        return {
          title: request.locale.startsWith("zh")
            ? "文件管理器"
            : "File Manager",
          data: {
            rootName: basename(root),
              canOpenExternally: !isRemotePath(opened?.external ? opened.path : root),
            rootEntries: opened?.external ? [] : await list(root, ""),
            result,
            ...(opened ? { resourceFile: opened } : {}),
            openers: (isRemotePath(root) ? [] : await availableOpeners()).map(({ id, label }) => ({
              id,
              label,
            })),
          },
          children: [],
        };
      },
    },
  ],
});
