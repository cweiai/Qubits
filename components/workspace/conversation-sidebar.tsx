"use client";

import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Conversation sidebar: a 280px list when expanded, a 56px rail when collapsed.
 * Presentation and user actions only; data/switch/mutations go through useWorkspace.
 */

function formatRelative(timestamp: number | null): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return minutes + " 分钟前";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " 小时前";
  const days = Math.floor(hours / 24);
  return days < 30 ? days + " 天前" : new Date(timestamp).toLocaleDateString("zh-CN");
}

export function ConversationSidebar({
  collapsed,
  onToggle,
  onNavigate,
  className,
}: {
  collapsed: boolean;
  onToggle(): void;
  onNavigate?(): void;
  className?: string;
}) {
  const workspace = useWorkspace();
  const { state, switchConversation, createConversation } = workspace;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const activeConversations = state.conversations.filter((c) => c.status === "active");
  const archivedConversations = state.conversations.filter((c) => c.status === "archived");
  const current = state.conversations.find((c) => c.id === state.currentConversationId);
  const currentTaskRunning = current?.lastTask?.status === "running" || current?.lastTask?.status === "pending";
  const currentTaskFailed = current?.lastTask?.status === "failed";

  const handleNew = async () => {
    setCreating(true);
    try {
      await createConversation();
      onNavigate?.();
    } finally {
      setCreating(false);
    }
  };

  if (collapsed) {
    return (
      <div className={cn("flex h-full w-full flex-col items-center gap-2 py-3", className)} aria-label="对话侧栏（折叠）">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="展开对话侧栏"
          aria-expanded={false}
          aria-controls="conversation-sidebar"
          title="展开对话侧栏"
          onClick={onToggle}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="新建对话"
          title="新建对话"
          disabled={creating}
          onClick={() => void handleNew()}
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
        {current ? (
          <button
            type="button"
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md border text-xs font-semibold",
              "border-sky-200 bg-sky-50 text-sky-700"
            )}
            aria-label={"当前对话：" + current.title}
            aria-current="true"
            title={current.title}
            onClick={() => void switchConversation(current.id)}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        ) : null}
        {currentTaskRunning ? <Loader2 className="h-4 w-4 animate-spin text-amber-600" aria-label="生成中" /> : null}
        {currentTaskFailed ? <TriangleAlert className="h-4 w-4 text-red-600" aria-label="生成失败" /> : null}
      </div>
    );
  }

  return (
    <div id="conversation-sidebar" className={cn("flex h-full w-full flex-col", className)}>
      <div className="flex items-center gap-1.5 border-b p-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="折叠对话侧栏"
          aria-expanded={true}
          aria-controls="conversation-sidebar"
          title="折叠对话侧栏"
          onClick={onToggle}
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">对话</p>
        <Button
          size="sm"
          className="h-8 shrink-0 gap-1.5"
          disabled={creating}
          onClick={() => void handleNew()}
          data-testid="new-conversation"
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          新建
        </Button>
      </div>
      <div className="qubits-scroll min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="conversation-list">
        {state.phase !== "ready" ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">正在加载对话…</p>
        ) : state.conversations.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground" data-testid="conversation-empty">
            还没有对话，点击“新建”开始
          </p>
        ) : (
          <>
            {activeConversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                current={conversation.id === state.currentConversationId}
                menuOpen={menuFor === conversation.id}
                onToggleMenu={() => setMenuFor(menuFor === conversation.id ? null : conversation.id)}
                onSelect={() => {
                  setMenuFor(null);
                  switchConversation(conversation.id);
                  onNavigate?.();
                }}
                onRename={() => {
                  setMenuFor(null);
                  setRenameValue(conversation.title);
                  setRenameTarget(conversation.id);
                }}
                onArchive={() => {
                  setMenuFor(null);
                  setArchiveTarget(conversation.id);
                }}
                onRestore={() => void workspace.setConversationStatus(conversation.id, "active")}
                onDelete={() => {
                  setMenuFor(null);
                  setDeleteTarget(conversation.id);
                }}
              />
            ))}
            {archivedConversations.length > 0 ? (
              <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">已归档</p>
            ) : null}
            {archivedConversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                current={conversation.id === state.currentConversationId}
                menuOpen={menuFor === conversation.id}
                onToggleMenu={() => setMenuFor(menuFor === conversation.id ? null : conversation.id)}
                onSelect={() => {
                  setMenuFor(null);
                  switchConversation(conversation.id);
                  onNavigate?.();
                }}
                onRename={() => {
                  setMenuFor(null);
                  setRenameValue(conversation.title);
                  setRenameTarget(conversation.id);
                }}
                onArchive={() => {
                  setMenuFor(null);
                  setArchiveTarget(conversation.id);
                }}
                onRestore={() => void workspace.setConversationStatus(conversation.id, "active")}
                onDelete={() => {
                  setMenuFor(null);
                  setDeleteTarget(conversation.id);
                }}
              />
            ))}
          </>
        )}
      </div>

      <RenameDialog
        open={renameTarget !== null}
        value={renameValue}
        onChange={setRenameValue}
        onClose={() => setRenameTarget(null)}
        onConfirm={() => {
          if (renameTarget && renameValue.trim()) {
            void workspace.renameConversation(renameTarget, renameValue.trim());
          }
          setRenameTarget(null);
        }}
      />
      <ArchiveDialog
        target={archiveTarget}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => {
          if (archiveTarget) {
            const target = state.conversations.find((c) => c.id === archiveTarget);
            void workspace.setConversationStatus(
              archiveTarget,
              target?.status === "archived" ? "active" : "archived"
            );
          }
          setArchiveTarget(null);
        }}
      />
      <DeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void workspace.deleteConversation(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function ConversationItem({
  conversation,
  current,
  menuOpen,
  onToggleMenu,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: {
  conversation: {
    id: string;
    title: string;
    status: "active" | "archived";
    lastMessageAt: number | null;
    lastTask?: { status?: string } | null;
  };
  current: boolean;
  menuOpen: boolean;
  onToggleMenu(): void;
  onSelect(): void;
  onRename(): void;
  onArchive(): void;
  onRestore(): void;
  onDelete(): void;
}) {
  const running = conversation.lastTask?.status === "running" || conversation.lastTask?.status === "pending";
  const failed = conversation.lastTask?.status === "failed";
  return (
    <div
      className={cn(
        "group relative flex items-center gap-1 rounded-md border border-transparent px-2 py-1.5",
        current ? "border-sky-200 bg-sky-50" : "hover:bg-zinc-100"
      )}
      data-testid="conversation-item"
      data-conversation-id={conversation.id}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={current ? "true" : undefined}
        className={cn(
          "flex h-9 min-w-0 flex-1 flex-col items-start justify-center rounded-md text-left",
          conversation.status === "archived" ? "opacity-60" : ""
        )}
      >
        <span className="flex w-full items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={conversation.title}>
            {conversation.title}
          </span>
          {running ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-600" aria-label="生成中" /> : null}
          {failed ? <TriangleAlert className="h-3 w-3 shrink-0 text-red-600" aria-label="生成失败" /> : null}
          {conversation.status === "archived" ? <Archive className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="已归档" /> : null}
        </span>
        <span className="text-[11px] text-muted-foreground">{formatRelative(conversation.lastMessageAt)}</span>
      </button>
      <div className="relative">
        <button
          type="button"
          aria-label={"对话操作：" + conversation.title}
          title="更多操作"
          onClick={onToggleMenu}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-200 hover:text-foreground",
            menuOpen && "bg-zinc-200 text-foreground"
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-8 z-20 w-36 rounded-md border bg-white py-1 shadow-md" role="menu">
            <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} label="重命名" onClick={onRename} />
            {conversation.status === "active" ? (
              <MenuItem icon={<Archive className="h-3.5 w-3.5" />} label="归档" onClick={onArchive} />
            ) : (
              <MenuItem
                icon={<ArchiveRestore className="h-3.5 w-3.5" />}
                label="恢复"
                onClick={() => {
                  onRestore();
                  onToggleMenu();
                }}
              />
            )}
            <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label="删除" danger onClick={onDelete} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-100",
        danger ? "text-red-600" : "text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function RenameDialog({
  open,
  value,
  onChange,
  onClose,
  onConfirm,
}: {
  open: boolean;
  value: string;
  onChange(value: string): void;
  onClose(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>重命名对话</DialogTitle>
          <DialogDescription>手动重命名后，自动标题不会再覆盖。</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          maxLength={60}
          autoFocus
          data-testid="rename-input"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onConfirm();
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onConfirm} disabled={!value.trim()} data-testid="rename-confirm">
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  const conversation = useWorkspace().state.conversations.find((c) => c.id === target);
  const restoring = conversation?.status === "archived";
  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{restoring ? "恢复对话？" : "归档对话？"}</DialogTitle>
          <DialogDescription>
            {restoring
              ? "恢复后可以继续在该对话中发送消息。"
              : "归档后该对话不能再发送消息，可随时恢复；消息内容不会丢失。"}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onConfirm} data-testid="archive-confirm">
            {restoring ? "恢复" : "归档"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>删除对话？</DialogTitle>
          <DialogDescription>将删除该对话及其全部消息与构建记录，且无法恢复。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm} data-testid="delete-confirm">
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
