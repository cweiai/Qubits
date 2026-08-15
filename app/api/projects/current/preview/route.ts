import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newProjectId, newRequestId, readProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/current/preview?conversationId=<id>
 * Serve the conversation's real built bundle (preview_bundle artifact) with a strict
 * CSP. The iframe loads with sandbox="allow-scripts" (no allow-same-origin), so the app
 * cannot read cookies/localStorage/parent/network.
 *
 * Persisted orchestrator artifacts are JSON (`{ html, bytes, builtAt }`); legacy
 * hand-written fixtures may store raw HTML. Either shape is served as the document.
 */

function previewHtmlFromArtifact(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { html?: unknown } | null;
      const html = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.html : null;
      return typeof html === "string" && html.trim().length > 0 ? html : null;
    } catch {
      // A raw HTML document starting with "{" is not a valid bundle shape.
      return null;
    }
  }
  return trimmed;
}

function ensurePreviewMountNodes(html: string): string {
  const hasQubitsRoot = /\bid=["']qubits-root["']/i.test(html);
  const hasRoot = /\bid=["']root["']/i.test(html);
  const missing = [
    hasQubitsRoot ? "" : '<div id="qubits-root"></div>',
    hasRoot ? "" : '<div id="root"></div>',
  ].join("");
  if (!missing) return html;
  const bodyOpen = html.match(/<body(?:\s[^>]*)?>/i);
  if (bodyOpen?.index != null) {
    const insertAt = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, insertAt) + missing + html.slice(insertAt);
  }
  const firstScript = html.search(/<script(?:\s[^>]*)?>/i);
  if (firstScript !== -1) return html.slice(0, firstScript) + missing + html.slice(firstScript);
  return missing + html;
}

/**
 * Safari/WebKit rejects `window.postMessage(message)` calls with a missing/invalid
 * targetOrigin (`SyntaxError: The string did not match the expected pattern.`).
 * This guard is injected into every served preview so even already-built bundles
 * get a normalized "*" targetOrigin. It patches the current Window prototype and
 * window.postMessage; the trusted SDK additionally wraps parent/top when the browser
 * permits it, while preserving the real WindowProxy for handshake source validation.
 */
const PREVIEW_POST_MESSAGE_GUARD =
  "<script>(function(){try{if(window.__QUBITS_POST_MESSAGE_GUARD__)return;window.__QUBITS_POST_MESSAGE_GUARD__=1;var n=function(t){if(t===\"*\")return\"*\";if(typeof t!==\"string\"||!t)return\"*\";try{var u=new URL(t);return u.origin===t?t:\"*\";}catch(e){return\"*\";}};var c=function(o,w,m,t,x){if(t&&typeof t===\"object\"){var a={};for(var k in t)a[k]=t[k];a.targetOrigin=n(a.targetOrigin);return o.call(w,m,a);}return x===undefined?o.call(w,m,n(t)):o.call(w,m,n(t),x);};var p=Object.getPrototypeOf(window),q=p&&p.postMessage;if(typeof q===\"function\"){var g=function(m,t,x){return c(q,this,m,t,x);};try{p.postMessage=g;}catch(e){try{Object.defineProperty(p,\"postMessage\",{configurable:true,writable:true,value:g});}catch(e){}}}var o=window.postMessage.bind(window);window.postMessage=function(m,t,x){return c(o,window,m,t,x);};}catch(e){}})();</script>";

function injectPostMessageGuard(html: string): string {
  if (html.includes("__QUBITS_POST_MESSAGE_GUARD__")) return html;
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + PREVIEW_POST_MESSAGE_GUARD + html.slice(headClose);
  }
  const bodyOpen = html.search(/<body(?:\s[^>]*)?>/i);
  if (bodyOpen !== -1) {
    const insertAt = html.indexOf(">", bodyOpen) + 1;
    return html.slice(0, insertAt) + PREVIEW_POST_MESSAGE_GUARD + html.slice(insertAt);
  }
  return PREVIEW_POST_MESSAGE_GUARD + html;
}

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const conversation = repo.getConversation(conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
    }
    const artifactId = conversation.previewBundleId;
    if (!artifactId) {
      throw new ApiError("PREVIEW_NOT_AVAILABLE", "该对话还没有可用的应用预览", 404);
    }
    const artifact = repo.getArtifact(artifactId);
    if (!artifact || artifact.projectId !== projectId || artifact.kind !== "preview_bundle") {
      throw new ApiError("PREVIEW_NOT_AVAILABLE", "预览产物不存在", 404);
    }
    const html = previewHtmlFromArtifact(artifact.content);
    if (!html) {
      throw new ApiError("PREVIEW_NOT_AVAILABLE", "预览产物内容缺失或已损坏，请重新生成", 404);
    }
    return new NextResponse(injectPostMessageGuard(ensurePreviewMountNodes(html)), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": PREVIEW_CSP,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}
