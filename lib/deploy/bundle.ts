/**
 * Deploy bundle pipeline: turns the persisted preview bundle (single self-contained
 * HTML with the strict sandbox CSP) into a publicly servable document.
 *
 * Transformations are deterministic and inject-only:
 *  1. The sandbox CSP (`connect-src 'none'`, no network) is swapped for the deploy
 *     CSP (network allowed against same-origin + https).
 *  2. The Safari postMessage guard is injected (shared with the preview route).
 *  3. An embedded host bridge is injected before the app script: it speaks the exact
 *     Qubits MessageChannel handshake protocol with the app's bundled SDK, then
 *     forwards every data request over plain fetch to the public deployment data API.
 *     This works with every existing bundle — the SDK never changes.
 *
 * The embedded bridge lives in the page itself (window.parent === window), so the SDK's
 * handshake reaches it with event.source === window and no code inside the bundle
 * needs to know it is deployed.
 */

import { injectPostMessageGuard } from "@/lib/workspace/postmessage-guard";

/**
 * Extract the HTML document from a persisted preview_bundle artifact. Persisted
 * orchestrator artifacts are JSON (`{ html, bytes, builtAt }`); legacy hand-written
 * fixtures may store raw HTML. Either shape yields the document text.
 */
export function extractBundleHtml(content: string): string | null {
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

export interface DeployBridgeConfig {
  deploymentId: string;
  sessionId: string;
  /** Absolute-path API endpoint on the public origin, e.g. "/api/deploy/data". */
  apiBase: string;
  appName: string;
  appVersion: number;
}

/**
 * Public deployment CSP: same inline-script policy as the preview, but the app may
 * talk to the deployment data API ('self') and public https APIs, load https images
 * and fonts, and submit forms to itself.
 */
export const DEPLOY_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src 'self' https:",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const CSP_META_PATTERN = /<meta\s[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/i;
const HEAD_OPEN_PATTERN = /<head(?:\s[^>]*)?>/i;
const BODY_OPEN_PATTERN = /<body(?:\s[^>]*)?>/i;

export function deployCspMeta(): string {
  return '<meta http-equiv="Content-Security-Policy" content="' + DEPLOY_CSP + '">';
}

/** Swap the document's CSP meta for the deploy CSP (insert one when absent). */
export function swapCspMeta(html: string): string {
  if (CSP_META_PATTERN.test(html)) {
    return html.replace(CSP_META_PATTERN, deployCspMeta());
  }
  const headOpen = html.match(HEAD_OPEN_PATTERN);
  if (headOpen?.index != null) {
    const insertAt = headOpen.index + headOpen[0].length;
    return html.slice(0, insertAt) + deployCspMeta() + html.slice(insertAt);
  }
  return deployCspMeta() + html;
}

/**
 * JSON.stringify with "<" escaped so hostile app names can never terminate the
 * surrounding <script> element (`</script>` inside a JS string is unsafe verbatim).
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The embedded host bridge, written in ES5 on purpose: it is injected verbatim into
 * the served document and is never transpiled.
 */
export function buildEmbeddedHostBridge(config: DeployBridgeConfig): string {
  const json = safeJson({
    deploymentId: config.deploymentId,
    sessionId: config.sessionId,
    apiBase: config.apiBase,
    appName: config.appName,
    appVersion: config.appVersion,
  });
  return (
    "<script>(function(){if(window.__QUBITS_DEPLOY_HOST__){return;}window.__QUBITS_DEPLOY_HOST__=1;" +
    "var CONFIG=" +
    json +
    ";" +
    "var TIMEOUT_MS=15000;var port=null;var nonce=\"\";" +
    "function sendPort(message){try{if(port){port.postMessage(message);}}catch(e){}}" +
    "function respond(requestId,ok,data,error){sendPort({type:\"QUBITS_DATA_RESPONSE\",nonce:nonce,requestId:requestId,ok:ok,data:data,error:error});}" +
    "function openChannel(){var channel=new MessageChannel();port=channel.port1;port.onmessage=onPortMessage;" +
    "try{window.postMessage({type:\"QUBITS_INIT\",nonce:nonce,appId:CONFIG.deploymentId,appVersion:CONFIG.appVersion},\"*\",[channel.port2]);}catch(e){port=null;}}" +
    "function forwardRequest(message){var requestId=message.requestId;var done=false;var timer=0;" +
    "var finish=function(ok,data,error){if(done){return;}done=true;window.clearTimeout(timer);respond(requestId,ok,data,error);};" +
    "timer=window.setTimeout(function(){finish(false,undefined,{code:\"TIMEOUT\",message:\"数据请求超时，请重试\",requestId:requestId});},TIMEOUT_MS);" +
    "var options={method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({deploymentId:CONFIG.deploymentId,sessionId:CONFIG.sessionId,operation:message.operation,collection:message.collection,id:message.id,query:message.query,input:message.input,patch:message.patch,requestId:requestId})};" +
    "fetch(CONFIG.apiBase,options).then(function(response){return response.json().catch(function(){return null;});}).then(function(payload){" +
    "var body=(payload&&typeof payload===\"object\")?payload:null;" +
    "if(body&&body.ok){finish(true,body.data,undefined);}else{finish(false,undefined,(body&&body.error)?body.error:{code:\"DB_ERROR\",message:\"数据服务暂时不可用，请稍后重试\",requestId:requestId});}" +
    "}).catch(function(){finish(false,undefined,{code:\"NETWORK_ERROR\",message:\"网络异常，请检查网络后重试\",requestId:requestId});});}" +
    "function onPortMessage(event){var message=(event&&event.data)?event.data:{};if(!message||message.nonce!==nonce){return;}" +
    "if(message.type===\"QUBITS_READY\"){sendPort({type:\"QUBITS_SPEC\",nonce:nonce,name:CONFIG.appName,sessionId:CONFIG.sessionId,collections:[]});return;}" +
    "if(message.type===\"QUBITS_DATA_REQUEST\"){forwardRequest(message);}}" +
    "function onWindowMessage(event){if(event.source!==window){return;}var data=(event&&event.data)?event.data:null;" +
    "if(!data||data.type!==\"QUBITS_HANDSHAKE\"){return;}if(port||nonce){return;}" +
    "nonce=\"dep-n\"+Math.random().toString(36).slice(2,12)+Math.random().toString(36).slice(2,8);openChannel();}" +
    "window.addEventListener(\"message\",onWindowMessage);})();</script>"
  );
}

/** Inject the guard + embedded bridge before the app's own scripts. Idempotent. */
export function injectDeployScripts(html: string, config: DeployBridgeConfig): string {
  if (html.includes("__QUBITS_DEPLOY_HOST__")) return html;
  const scripts = html.includes("__QUBITS_POST_MESSAGE_GUARD__")
    ? buildEmbeddedHostBridge(config)
    : injectPostMessageGuard("") + buildEmbeddedHostBridge(config);
  const headOpen = html.match(HEAD_OPEN_PATTERN);
  if (headOpen?.index != null) {
    const insertAt = headOpen.index + headOpen[0].length;
    return html.slice(0, insertAt) + scripts + html.slice(insertAt);
  }
  const bodyOpen = html.match(BODY_OPEN_PATTERN);
  if (bodyOpen?.index != null) {
    const insertAt = html.indexOf(">", bodyOpen.index) + 1;
    return html.slice(0, insertAt) + scripts + html.slice(insertAt);
  }
  return scripts + html;
}

/**
 * Full deploy document pipeline: CSP swap → guard + embedded bridge injection.
 * Pure and deterministic — the caller persists the returned HTML.
 */
export function buildDeployBundle(html: string, config: DeployBridgeConfig): string {
  const withCsp = swapCspMeta(html);
  return injectDeployScripts(withCsp, config);
}
