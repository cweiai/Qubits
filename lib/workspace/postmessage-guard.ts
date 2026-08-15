/**
 * Safari/WebKit rejects `window.postMessage(message)` calls with a missing/invalid
 * targetOrigin (`SyntaxError: The string did not match the expected pattern.`).
 * This guard is injected into every served preview / public deployment so even
 * already-built bundles get a normalized "*" targetOrigin. It patches the current
 * Window prototype and window.postMessage; the trusted SDK additionally wraps
 * parent/top when the browser permits it, while preserving the real WindowProxy
 * for handshake source validation.
 *
 * Shared by the preview route and the one-click deploy bundle pipeline.
 */

export const POST_MESSAGE_GUARD_SCRIPT =
  "<script>(function(){try{if(window.__QUBITS_POST_MESSAGE_GUARD__)return;window.__QUBITS_POST_MESSAGE_GUARD__=1;var n=function(t){if(t===\"*\")return\"*\";if(typeof t!==\"string\"||!t)return\"*\";try{var u=new URL(t);return u.origin===t?t:\"*\";}catch(e){return\"*\";}};var c=function(o,w,m,t,x){if(t&&typeof t===\"object\"){var a={};for(var k in t)a[k]=t[k];a.targetOrigin=n(a.targetOrigin);return o.call(w,m,a);}return x===undefined?o.call(w,m,n(t)):o.call(w,m,n(t),x);};var p=Object.getPrototypeOf(window),q=p&&p.postMessage;if(typeof q===\"function\"){var g=function(m,t,x){return c(q,this,m,t,x);};try{p.postMessage=g;}catch(e){try{Object.defineProperty(p,\"postMessage\",{configurable:true,writable:true,value:g});}catch(e){}}}var o=window.postMessage.bind(window);window.postMessage=function(m,t,x){return c(o,window,m,t,x);};}catch(e){}})();</script>";

/** Inject the guard into an HTML document unless it is already present. */
export function injectPostMessageGuard(html: string): string {
  if (html.includes("__QUBITS_POST_MESSAGE_GUARD__")) return html;
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + POST_MESSAGE_GUARD_SCRIPT + html.slice(headClose);
  }
  const bodyOpen = html.search(/<body(?:\s[^>]*)?>/i);
  if (bodyOpen !== -1) {
    const insertAt = html.indexOf(">", bodyOpen) + 1;
    return html.slice(0, insertAt) + POST_MESSAGE_GUARD_SCRIPT + html.slice(insertAt);
  }
  return POST_MESSAGE_GUARD_SCRIPT + html;
}
