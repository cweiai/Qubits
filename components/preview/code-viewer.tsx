"use client";

import { useCallback, useEffect, useState } from "react";
import { FileCode2, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { api, type CodeFile } from "@/lib/workspace/api";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { cn } from "@/lib/utils";

/**
 * Code tab: read-only file tree + source viewer of the CURRENT promoted snapshot
 * (the immutable version — never the in-flight workspace).
 */

interface Tree {
  name: string;
  path: string;
  children: Tree[];
}

function buildTree(files: CodeFile[]): Tree[] {
  const root: Tree = { name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? prefix + "/" + part : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: prefix, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  return root.children;
}

export function CodeViewer({ refreshTick }: { refreshTick: number }) {
  const { state } = useWorkspace();
  const conversationId = state.currentConversationId ?? "";
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [tree, setTree] = useState<Tree[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getCodeFiles(conversationId);
      setFiles(result.files);
      setVersion(result.version);
      setTree(buildTree(result.files));
      if (!result.files.length) setContent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载代码文件");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load, refreshTick, conversationId]);

  const openFile = useCallback(async (path: string) => {
    setSelected(path);
    setError(null);
    try {
      const result = await api.getCodeFile(conversationId, path);
      setContent(result.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取文件");
      setContent(null);
    }
  }, [conversationId]);

  return (
    <div className="flex h-full min-h-[320px] flex-col" data-testid="code-viewer">
      <div className="flex items-center gap-2 border-b bg-zinc-50 px-3 py-1.5 text-[11px] text-muted-foreground">
        <FileCode2 className="h-3.5 w-3.5 shrink-0" />
        <span>当前版本代码快照{version != null ? "（v" + version + "）" : ""} · 只读</span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto flex items-center gap-1 rounded border bg-white px-2 py-0.5 hover:bg-zinc-100"
          data-testid="code-refresh"
        >
          <RefreshCw className="h-3 w-3" />
          刷新
        </button>
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载代码快照…
        </div>
      ) : error && files.length === 0 ? (
        <div className="m-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700" data-testid="code-empty">
          {error}
          <p className="mt-1 text-amber-600/80">应用构建成功并完成运行后，代码快照会出现在这里。</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-48 shrink-0 overflow-auto border-r bg-white p-2" data-testid="code-tree">
            {tree.map((node) => (
              <TreeNode key={node.path} node={node} depth={0} selected={selected} onSelect={(path) => void openFile(path)} />
            ))}
          </div>
          <div className="qubits-scroll min-w-0 flex-1 overflow-auto bg-zinc-950 p-3" data-testid="code-content">
            {selected == null ? (
              <p className="text-xs text-zinc-500">从左侧文件树选择文件查看源码</p>
            ) : error ? (
              <p className="text-xs text-red-400">{error}</p>
            ) : (
              <pre className="text-[11px] leading-relaxed text-zinc-200 whitespace-pre-wrap break-all">{content ?? ""}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: Tree;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const isDir = node.children.length > 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={cn(
          "flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-zinc-100",
          selected === node.path && "bg-sky-100 text-sky-800"
        )}
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        {isDir ? <FolderOpen className="h-3 w-3 shrink-0 text-amber-500" /> : <FileCode2 className="h-3 w-3 shrink-0 text-zinc-400" />}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir
        ? node.children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))
        : null}
    </div>
  );
}
