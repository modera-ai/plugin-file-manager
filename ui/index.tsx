import { Tooltip } from "@modera/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { frontend, usePluginSnapshot } from "@modera/plugin-sdk/react";
import { FileTypeIcon } from "@modera/ui/files";

type Entry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  extension?: string;
};
type FileData = {
  path: string;
  content: string;
  version: string;
  size: number;
  external?: boolean;
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
  | ({ type: "file" } & FileData)
  | {
      type: "changed";
      path?: string;
      removed?: string;
      parent: string;
      entries: Entry[];
      version?: string;
    };
type Data = {
  rootName: string;
  rootEntries: Entry[];
  result?: Result;
  resourceFile?: FileData;
  openers?: { id: string; label: string }[];
};
type ContextMenu = { entry?: Entry; x: number; y: number };
type TreeDrag = {
  active: boolean;
  startX: number;
  x: number;
  target: "left" | "right";
  dockSpan: number;
};
type Modal = {
  type: "file" | "directory" | "rename" | "delete" | "discard";
  base?: string;
  entry?: Entry;
  value: string;
};

const language = (path: string): Extension => {
  const name = path.split("/").at(-1)?.toLowerCase() || "";
  const ext = name.split(".").pop();
  if (name === "dockerfile" || name.startsWith("dockerfile."))
    return StreamLanguage.define(shell);
  if ([".gitignore", ".ignore", ".gitattributes"].includes(name))
    return StreamLanguage.define(shell);
  if (["js", "jsx", "mjs", "cjs"].includes(ext || ""))
    return javascript({ jsx: true });
  if (["ts", "tsx", "mts", "cts"].includes(ext || ""))
    return javascript({ jsx: ext === "tsx", typescript: true });
  if (["json", "jsonc", "json5"].includes(ext || "")) return json();
  if (["md", "markdown", "mdx"].includes(ext || "")) return markdown();
  if (["css", "scss", "less"].includes(ext || "")) return css();
  if (["html", "htm", "vue", "svelte", "xml"].includes(ext || ""))
    return html();
  if (["py", "pyw"].includes(ext || "")) return python();
  if (["yaml", "yml"].includes(ext || "")) return yaml();
  if (ext === "toml") return StreamLanguage.define(toml);
  if (["sh", "bash", "zsh", "fish"].includes(ext || ""))
    return StreamLanguage.define(shell);
  if (["ps1", "psm1", "psd1"].includes(ext || ""))
    return StreamLanguage.define(powerShell);
  if (["sql", "sqlite"].includes(ext || "")) return sql();
  if (ext === "rs") return rust();
  if (ext === "go") return go();
  if (ext === "java") return java();
  if (["c", "h", "cc", "cpp", "cxx", "hpp"].includes(ext || "")) return cpp();
  if (["cs", "csx"].includes(ext || "")) return StreamLanguage.define(csharp);
  if (ext === "php") return php();
  if (ext === "rb") return StreamLanguage.define(ruby);
  if (ext === "lua") return StreamLanguage.define(lua);
  if (["diff", "patch"].includes(ext || "")) return StreamLanguage.define(diff);
  return [];
};
const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const formatSize = (size = 0) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 ** 2).toFixed(1)} MiB`;

function TypeIcon({ entry, open = false }: { entry: Entry; open?: boolean }) {
  return <FileTypeIcon path={entry.path || entry.name} kind={entry.kind} open={open} />;
}

function Editor({
  file,
  value,
  onChange,
}: {
  file: FileData;
  value: string;
  onChange(value: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language(file.path),
          ...(dark ? [oneDark] : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [file.path, file.version]);
  return <div ref={host} className="editor-host" />;
}

function App() {
  const { snapshot, error: snapshotError } = usePluginSnapshot();
  const data = snapshot?.view.data as Data | undefined;
  const zh = snapshot?.locale.startsWith("zh") ?? true;
  const [tree, setTree] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<FileData>();
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [preview, setPreview] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] =
    useState<Extract<Result, { type: "search" }>>();
  const [contextMenu, setContextMenu] = useState<ContextMenu>();
  const [modal, setModal] = useState<Modal>();
  const pendingAction = useRef<(() => void) | undefined>(undefined);
  const closeModal = () => {
    pendingAction.current = undefined;
    setModal(undefined);
  };
  const [treeSide, setTreeSide] = useState<"left" | "right">("left");
  const [treeWidth, setTreeWidth] = useState(260);
  const [treeDrag, setTreeDrag] = useState<TreeDrag>();
  const [treeSettling, setTreeSettling] = useState(false);
  const treeDragRef = useRef<TreeDrag | undefined>(undefined);
  const treeHoldTimer = useRef<number | undefined>(undefined);
  const [openMenu, setOpenMenu] = useState(false);
  const shellRef = useRef<HTMLElement>(null);
  const dirty = !!file && content !== saved;
  const beginTreeDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      !shellRef.current ||
      (event.target as HTMLElement).closest("button, input")
    )
      return;
    const header = event.currentTarget;
    const pointerId = event.pointerId;
    const bounds = shellRef.current.getBoundingClientRect();
    const initial: TreeDrag = {
      active: false,
      startX: event.clientX,
      x: event.clientX,
      target: treeSide,
      dockSpan: Math.max(0, bounds.width - treeWidth - 5),
    };
    treeDragRef.current = initial;
    header.setPointerCapture(pointerId);
    const activate = () => {
      const current = treeDragRef.current;
      if (!current || current.active) return;
      const active = { ...current, active: true };
      treeDragRef.current = active;
      setTreeDrag(active);
    };
    treeHoldTimer.current = window.setTimeout(activate, 180);
    const move = (next: PointerEvent) => {
      const current = treeDragRef.current;
      if (!current) return;
      if (!current.active && Math.abs(next.clientX - current.startX) > 6)
        activate();
      const updated = {
        ...(treeDragRef.current || current),
        x: next.clientX,
        target:
          next.clientX < bounds.left + bounds.width / 2
            ? ("left" as const)
            : ("right" as const),
      };
      treeDragRef.current = updated;
      if (updated.active) setTreeDrag(updated);
    };
    const end = () => {
      window.clearTimeout(treeHoldTimer.current);
      const current = treeDragRef.current;
      treeDragRef.current = undefined;
      setTreeDrag(undefined);
      if (header.hasPointerCapture(pointerId))
        header.releasePointerCapture(pointerId);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      if (current?.active && current.target !== treeSide) {
        setTreeSide(current.target);
        setTreeSettling(true);
        window.setTimeout(() => setTreeSettling(false), 320);
      }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end, { once: true });
    addEventListener("pointercancel", end, { once: true });
  };
  useEffect(() => {
    if (data?.rootEntries) setTree((old) => ({ ...old, "": data.rootEntries }));
  }, [data?.rootEntries]);
  useEffect(() => {
    if (!data?.resourceFile) return;
    setFile(data.resourceFile);
    setContent(data.resourceFile.content);
    setSaved(data.resourceFile.content);
    setPreview(isMarkdown(data.resourceFile.path));
  }, [data?.resourceFile?.path, data?.resourceFile?.version]);
  const run = async (id: string, value: Record<string, unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      const next = await frontend().action(id, JSON.stringify(value));
      const result = (next.view.data as Data).result;
      if (!result) return;
      if (result.type === "listing")
        setTree((old) => ({ ...old, [result.path]: result.entries }));
      if (result.type === "search") setSearchResult(result);
      if (result.type === "file") {
        setFile(result);
        setContent(result.content);
        setSaved(result.content);
        setPreview(false);
      }
      if (result.type === "changed") {
        setTree((old) => ({ ...old, [result.parent]: result.entries }));
        if (result.version && file) {
          setFile({
            ...file,
            version: result.version,
            size: new TextEncoder().encode(content).length,
          });
          setSaved(content);
          setMessage(zh ? "已保存" : "Saved");
        } else if (file && result.removed === file.path) {
          if (result.path) setFile({ ...file, path: result.path });
          else {
            setFile(undefined);
            setContent("");
            setSaved("");
          }
        }
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  const guarded = (action: () => void) => {
    if (!dirty) return action();
    pendingAction.current = action;
    setModal({ type: "discard", value: "" });
  };
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s")
        return;
      event.preventDefault();
      if (file && dirty && !busy)
        void run("save", {
          path: file.path,
          content,
          version: file.version,
        });
    };
    addEventListener("keydown", save);
    return () => removeEventListener("keydown", save);
  }, [file, content, dirty, busy]);
  const openFile = (entry: Entry) => {
    guarded(() => void run("read", { path: entry.path }));
  };
  const toggle = (entry: Entry) => {
    const next = new Set(expanded);
    if (next.has(entry.path)) next.delete(entry.path);
    else {
      next.add(entry.path);
      if (!tree[entry.path]) void run("list", { path: entry.path });
    }
    setExpanded(next);
  };
  const create = (base: string, kind: "file" | "directory") =>
    setModal({ type: kind, base, value: "" });
  const renameEntry = (entry: Entry) => {
    guarded(() => setModal({ type: "rename", entry, value: entry.name }));
  };
  const deleteEntry = (entry: Entry) => {
    guarded(() => setModal({ type: "delete", entry, value: entry.name }));
  };
  const submitModal = () => {
    if (!modal) return;
    const value = modal.value.trim();
    if (modal.type === "discard") {
      const action = pendingAction.current;
      pendingAction.current = undefined;
      setModal(undefined);
      action?.();
      return;
    } else if (modal.type === "delete" && modal.entry)
      void run("delete", { path: modal.entry.path });
    else if (modal.type === "rename" && modal.entry && value)
      void run("rename", {
        path: modal.entry.path,
        target: `${parentOf(modal.entry.path)}${parentOf(modal.entry.path) ? "/" : ""}${value}`,
      });
    else if ((modal.type === "file" || modal.type === "directory") && value)
      void run("create", {
        path: modal.base ? `${modal.base}/${value}` : value,
        kind: modal.type,
      });
    else return;
    setModal(undefined);
  };
  const showMenu = (event: React.MouseEvent, entry?: Entry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ entry, x: event.clientX, y: event.clientY });
  };
  useEffect(() => {
    if (!modal) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        pendingAction.current = undefined;
        closeModal();
      }
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [modal]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(undefined);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [contextMenu]);
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(false);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [openMenu]);
  const nodes = (path = "", depth = 0): React.ReactNode =>
    (tree[path] || []).map((entry) => {
      const open = expanded.has(entry.path),
        active = file?.path === entry.path;
      return (
        <div key={entry.path}>
          <div
            className={`tree-row${active ? " active" : ""}`}
            style={{ paddingLeft: 8 + depth * 15 }}
            onContextMenu={(event) => showMenu(event, entry)}
            onDoubleClick={() =>
              entry.kind === "directory" ? toggle(entry) : openFile(entry)
            }
          >
            <button
              className="disclosure"
              onClick={() => entry.kind === "directory" && toggle(entry)}
              aria-label="toggle"
            >
              {entry.kind === "directory" ? (
                open ? (
                  <ChevronDown />
                ) : (
                  <ChevronRight />
                )
              ) : null}
            </button>
            <button
              className="tree-main"
              onClick={() =>
                entry.kind === "directory" ? toggle(entry) : openFile(entry)
              }

            >
              <TypeIcon entry={entry} open={open} />
              <span>{entry.name}</span>
            </button>
            <Tooltip content={zh ? "更多" : "More"}><button
              className="row-menu"
              onClick={(event) => showMenu(event, entry)}

            >
              <MoreHorizontal />
            </button></Tooltip>
          </div>
          {entry.kind === "directory" && open && nodes(entry.path, depth + 1)}
        </div>
      );
    });
  const title =
    file?.path.split("/").at(-1) || (zh ? "选择一个文件" : "Select a file");
  return (
    <main
      ref={shellRef}
      className={`shell${collapsed ? " collapsed" : ""}${file?.external ? " external-only" : ""}${treeDrag?.active ? ` dragging-tree dock-${treeDrag.target}` : ""}${treeSettling ? " tree-settling" : ""}`}
    >
      <aside
        className="tree-panel"
        style={
          {
            width: treeWidth,
            order: treeSide === "left" ? 0 : 2,
            "--tree-drag-x": treeDrag?.active
              ? `${treeDrag.x - treeDrag.startX}px`
              : "0px",
            "--tree-dock-shift": treeDrag?.active
              ? `${
                  treeDrag.target === treeSide
                    ? 0
                    : treeSide === "left"
                      ? treeDrag.dockSpan
                      : -treeDrag.dockSpan
                }px`
              : "0px",
          } as React.CSSProperties
        }
      >
        <header
          className="tree-titlebar"
          onPointerDown={beginTreeDrag}

        >
          <FolderOpen />
          <strong>{data?.rootName || (zh ? "项目" : "Project")}</strong>
          <Tooltip content={zh ? "刷新" : "Refresh"}><button
            onClick={() => run("list", { path: "" })}

          >
            <RefreshCw />
          </button></Tooltip>
          <Tooltip content={zh ? "新建文件" : "New file"}><button
            onClick={() => create("", "file")}

          >
            <Plus />
          </button></Tooltip>
        </header>
        <form
          className="search-box"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) void run("search", { query: query.trim() });
          }}
        >
          <Search />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!event.target.value) setSearchResult(undefined);
            }}
            placeholder={zh ? "按文件名搜索" : "Search file names"}
            maxLength={200}
          />
          {query && (
            <Tooltip content={zh ? "清除" : "Clear"}><button
              type="button"
              onClick={() => {
                setQuery("");
                setSearchResult(undefined);
              }}

            >
              <X />
            </button></Tooltip>
          )}
        </form>
        <div className="tree" onContextMenu={(event) => showMenu(event)}>
          {searchResult ? (
            <div className="search-results">
              <small>
                {searchResult.entries.length} {zh ? "个结果" : "results"}
                {searchResult.truncated
                  ? zh
                    ? "（已截断）"
                    : " (limited)"
                  : ""}
              </small>
              {searchResult.entries.map((entry) => (
                <button key={entry.path}

                  onClick={() => openFile(entry)}

                >
                  <TypeIcon entry={entry} />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{parentOf(entry.path) || "/"}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            nodes()
          )}
        </div>
      </aside>
      <div
        className="tree-resize"
        style={{ order: 1 }}
        role="separator"
        aria-orientation="vertical"
        aria-label={zh ? "调整文件区宽度" : "Resize file area"}
        onPointerDown={(event) => {
          if (event.button !== 0 || !shellRef.current) return;
          event.preventDefault();
          const handle = event.currentTarget;
          const pointerId = event.pointerId;
          handle.setPointerCapture(pointerId);
          const bounds = shellRef.current.getBoundingClientRect();
          const move = (next: PointerEvent) => {
            const raw =
              treeSide === "left"
                ? next.clientX - bounds.left
                : bounds.right - next.clientX;
            setTreeWidth(
              Math.round(Math.min(bounds.width * 0.62, Math.max(170, raw))),
            );
          };
          const end = () => {
            if (handle.hasPointerCapture(pointerId))
              handle.releasePointerCapture(pointerId);
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", end);
          };
          addEventListener("pointermove", move);
          addEventListener("pointerup", end, { once: true });
        }}
      />
      <section
        className="workspace"
        style={{ order: treeSide === "left" ? 2 : 0 }}
      >
        <nav>
          {!file?.external && (
            <>
              <Tooltip content={zh ? "切换目录树" : "Toggle tree"}><button
                onClick={() => setCollapsed(!collapsed)}

              >
                {collapsed ? (
                  treeSide === "left" ? (
                    <PanelLeftOpen />
                  ) : (
                    <PanelRightOpen />
                  )
                ) : treeSide === "left" ? (
                  <PanelLeftClose />
                ) : (
                  <PanelRightClose />
                )}
              </button></Tooltip>
            </>
          )}
          <div className="file-title">
            <strong>{title}</strong>
            {file && (
              <span>
                {file.path} · {formatSize(file.size)}
                {dirty ? ` · ${zh ? "未保存" : "Modified"}` : ""}
              </span>
            )}
          </div>
          {file && (
            <div className="open-wrap">
              <button
                className="open-trigger"
                aria-haspopup="menu"
                aria-expanded={openMenu}
                onClick={() => setOpenMenu((value) => !value)}
              >
                <ExternalLink />
                {zh ? "打开" : "Open"}
                <ChevronDown />
              </button>
              {openMenu && (
                <>
                  <button
                    className="open-dismiss"
                    aria-label={zh ? "关闭菜单" : "Close menu"}
                    onClick={() => setOpenMenu(false)}
                  />
                  <div className="open-menu" role="menu">
                    {(data?.openers || []).map((opener) => (
                      <button
                        key={opener.id}
                        role="menuitem"
                        onClick={() => {
                          void run("open", {
                            path: file.path,
                            opener: opener.id,
                          });
                          setOpenMenu(false);
                        }}
                      >
                        <FileCode2 />
                        {opener.label}
                      </button>
                    ))}
                    <button
                      role="menuitem"
                      onClick={() => {
                        void run("open", {
                          path: file.path,
                          opener: "default",
                        });
                        setOpenMenu(false);
                      }}
                    >
                      <File />
                      {zh ? "默认应用" : "Default app"}
                    </button>
                    <hr />
                    <button
                      role="menuitem"
                      onClick={() => {
                        void run("open", { path: file.path, opener: "folder" });
                        setOpenMenu(false);
                      }}
                    >
                      <FolderOpen />
                      {zh ? "打开所在文件夹" : "Show in folder"}
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        void navigator.clipboard.writeText(file.path);
                        setOpenMenu(false);
                      }}
                    >
                      <Copy />
                      {zh ? "复制路径" : "Copy path"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {file && isMarkdown(file.path) && (
            <div className="segmented">
              <button
                className={!preview ? "selected" : ""}
                onClick={() => setPreview(false)}
              >
                <Code2 />
                {zh ? "编辑" : "Edit"}
              </button>
              <button
                className={preview ? "selected" : ""}
                onClick={() => setPreview(true)}
              >
                {zh ? "预览" : "Preview"}
              </button>
            </div>
          )}
          <button
            className="save"
            disabled={!dirty || busy || file?.external}
            onClick={() =>
              file &&
              run("save", { path: file.path, content, version: file.version })
            }
          >
            <Save />
            {file?.external
              ? zh
                ? "只读"
                : "Read only"
              : zh
                ? "保存"
                : "Save"}
          </button>
        </nav>
        <div className="content">
          {!file ? (
            <div className="empty">
              <FileText />
              <h2>{zh ? "从左侧选择文件" : "Choose a file from the tree"}</h2>
              <p>
                {zh
                  ? "支持代码高亮与 Markdown 预览"
                  : "Syntax highlighting and Markdown preview are ready"}
              </p>
            </div>
          ) : preview && isMarkdown(file.path) ? (
            <article className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </article>
          ) : (
            <Editor file={file} value={content} onChange={setContent} />
          )}
        </div>
        {(message || snapshotError) && (
          <div className="notice" role="status">
            {message || snapshotError}
          </div>
        )}
      </section>
      {contextMenu && (
        <div
          className="menu-layer"
          onPointerDown={() => setContextMenu(undefined)}
        >
          <div
            className="context-menu"
            style={{
              left: Math.min(contextMenu.x, innerWidth - 190),
              top: Math.min(contextMenu.y, innerHeight - 230),
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => {
                create(
                  contextMenu.entry?.kind === "directory"
                    ? contextMenu.entry.path
                    : parentOf(contextMenu.entry?.path || ""),
                  "file",
                );
                setContextMenu(undefined);
              }}
            >
              <Plus />
              {zh ? "新建文件" : "New file"}
            </button>
            <button
              onClick={() => {
                create(
                  contextMenu.entry?.kind === "directory"
                    ? contextMenu.entry.path
                    : parentOf(contextMenu.entry?.path || ""),
                  "directory",
                );
                setContextMenu(undefined);
              }}
            >
              <Folder />
              {zh ? "新建文件夹" : "New folder"}
            </button>
            {contextMenu.entry && (
              <>
                <hr />
                <button
                  onClick={() => {
                    renameEntry(contextMenu.entry!);
                    setContextMenu(undefined);
                  }}
                >
                  <Pencil />
                  {zh ? "重命名" : "Rename"}
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    deleteEntry(contextMenu.entry!);
                    setContextMenu(undefined);
                  }}
                >
                  <Trash2 />
                  {zh ? "删除" : "Delete"}
                </button>
              </>
            )}
            <hr />
            <button
              onClick={() => {
                const path =
                  contextMenu.entry?.kind === "directory"
                    ? contextMenu.entry.path
                    : parentOf(contextMenu.entry?.path || "");
                void run("list", { path });
                setContextMenu(undefined);
              }}
            >
              <RefreshCw />
              {zh ? "刷新" : "Refresh"}
            </button>
          </div>
        </div>
      )}
      {modal && (
        <div className="dialog-layer" onPointerDown={closeModal}>
          <form
            className="dialog"
            role="dialog"
            aria-modal="true"
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              submitModal();
            }}
          >
            <h3>
              {modal.type === "delete"
                ? zh
                  ? "确认删除"
                  : "Confirm deletion"
                : modal.type === "discard"
                  ? zh
                    ? "放弃修改"
                    : "Discard changes"
                  : modal.type === "rename"
                    ? zh
                      ? "重命名"
                      : "Rename"
                    : modal.type === "directory"
                      ? zh
                        ? "新建文件夹"
                        : "New folder"
                      : zh
                        ? "新建文件"
                        : "New file"}
            </h3>
            {modal.type === "delete" || modal.type === "discard" ? (
              <p>
                {modal.type === "delete"
                  ? zh
                    ? `确定删除“${modal.entry?.name}”吗？此操作无法撤销。`
                    : `Delete “${modal.entry?.name}”? This cannot be undone.`
                  : zh
                    ? "当前文件尚未保存，确定放弃修改吗？"
                    : "The current file has unsaved changes. Discard them?"}
              </p>
            ) : (
              <input
                autoFocus
                value={modal.value}
                onChange={(event) =>
                  setModal({ ...modal, value: event.target.value })
                }
                placeholder={zh ? "输入名称" : "Enter a name"}
              />
            )}
            <div className="dialog-actions">
              <button type="button" onClick={closeModal}>
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                type="submit"
                className={
                  modal.type === "delete" || modal.type === "discard"
                    ? "danger primary"
                    : "primary"
                }
              >
                {modal.type === "delete" || modal.type === "discard"
                  ? zh
                    ? "删除"
                    : "Delete"
                  : zh
                    ? "确定"
                    : "OK"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
