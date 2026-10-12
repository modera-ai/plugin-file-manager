import { MenuAction, MenuPanel, PopoverMorph } from "@modera/ui";
import { Folder, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

export function FileActionsMenu({
  anchor,
  zh,
  hasEntry,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onRefresh,
}: {
  anchor: HTMLElement | { x: number; y: number };
  zh: boolean;
  hasEntry: boolean;
  onClose(): void;
  onCreate(kind: "file" | "directory"): void;
  onRename(): void;
  onDelete(): void;
  onRefresh(): void;
}) {
  const select = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <PopoverMorph
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      anchor={anchor}
      className={`mu-menu-popover mu-menu-${anchor instanceof HTMLElement ? "dropdown" : "context"}`}
    >
      <MenuPanel label={zh ? "文件操作" : "File actions"}>
        <MenuAction
          icon={<Plus size={16} />}
          onSelect={select(() => onCreate("file"))}
        >
          {zh ? "新建文件" : "New file"}
        </MenuAction>
        <MenuAction
          icon={<Folder size={16} />}
          onSelect={select(() => onCreate("directory"))}
        >
          {zh ? "新建文件夹" : "New folder"}
        </MenuAction>
        {hasEntry && (
          <>
            <div className="mu-menu-separator" role="separator" />
            <MenuAction icon={<Pencil size={16} />} onSelect={select(onRename)}>
              {zh ? "重命名" : "Rename"}
            </MenuAction>
            <MenuAction
              icon={<Trash2 size={16} />}
              danger
              onSelect={select(onDelete)}
            >
              {zh ? "删除" : "Delete"}
            </MenuAction>
          </>
        )}
        <div className="mu-menu-separator" role="separator" />
        <MenuAction icon={<RefreshCw size={16} />} onSelect={select(onRefresh)}>
          {zh ? "刷新" : "Refresh"}
        </MenuAction>
      </MenuPanel>
    </PopoverMorph>
  );
}
