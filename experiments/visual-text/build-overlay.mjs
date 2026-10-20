import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTextObserver } from './observer.mjs';
import { createBrowserRequestPacing } from './request-pacing.mjs';

/** This deliberately builds an UNSIGNED maintainer overlay in an owned temp
 * directory. It never edits host-runtime, an installed signed cache or policy.
 * Exact single anchors fail closed when upstream changes; no fuzzy rewrites.
 * Keeping the prototype outside host-runtime also excludes it from packages.
 */
export async function buildTextOverlay() {
  const source = fileURLToPath(new URL('../../host-runtime/scripts/', import.meta.url));
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-text-experiment-')));
  await fs.chmod(directory, 0o700);
  const replace = (text, before, after) => {
    if (text.split(before).length !== 2) throw new Error('EXPERIMENTAL_SOURCE_CHANGED');
    return text.replace(before, after);
  };
  try {
    await fs.cp(source, directory, { recursive: true, filter: entry => path.basename(entry) !== 'node_modules' });
    await fs.copyFile(fileURLToPath(new URL('./result.mjs', import.meta.url)), path.join(directory, 'experimental-text-result.mjs'));
    let browser = await fs.readFile(path.join(directory, 'trelio-visual-extension-browser.mjs'), 'utf8');
    browser = "import { validateTextResult, TEXT_KIND } from './experimental-text-result.mjs';\n" + browser;
    browser = replace(browser, "screenshot: [], setup:", "screenshot: [], 'read-text': ['query', 'offset', 'includeControls'], setup:");
    browser = replace(browser, "'read-text': ['query', 'offset', 'includeControls'],", "'read-text': ['query', 'offset', 'includeControls'], submit: ['action', 'frameId', 'x', 'y', 'key', 'url'], 'request-ready': ['frameId'],");
    browser = replace(browser, "    if (!validArguments(operation, args))", "    if (operation === 'submit') {\n      const { action, ...input } = args || {};\n      if (!['navigate', 'click', 'key'].includes(action) || (action === 'key' && input.key !== 'Enter') || !validArguments(action, input)) return Promise.resolve(visualStatus('error', 'invalid_input'));\n    }\n    if (!validArguments(operation, args))");
    browser = replace(browser, "js: ['link-router.js']", "js: ['link-router.js', 'text-observer.js']");
    browser = replace(browser, "const executable = await ensureVisualChromium", `await fs.writeFile(path.join(extension, 'text-observer.js'), ${JSON.stringify(`(${installTextObserver.toString()})();`)}, { mode: 0o600 });\n    const executable = await ensureVisualChromium`);
    browser = replace(browser, "return normalizeBrowserVisualResult({ kind: VISUAL_RESULT_KIND, sessionId: this.sessionId, reason: 'none', ...value });", "const response = { kind: value.kind || VISUAL_RESULT_KIND, sessionId: this.sessionId, reason: 'none', ...value };\n      return value.kind === TEXT_KIND ? validateTextResult(response) : normalizeBrowserVisualResult(response);");
    // The maximum random remainder is 15s. Preserve bounded time for the UI
    // action and document capture without granting a fresh absolute lease.
    browser = replace(browser, "}, 20_000);", "}, 40_000);");
    await fs.writeFile(path.join(directory, 'trelio-visual-extension-browser.mjs'), browser);
    let worker = await fs.readFile(path.join(directory, 'trelio-visual-extension-worker.mjs'), 'utf8');
    worker = replace(worker, "  let socket, frame, pendingLink,", `  const requestPacing = (${createBrowserRequestPacing.toString()})();\n  let observedFrameId;\n  let socket, frame, pendingLink,`);
    worker = replace(worker, "  async function capture() {", "  async function captureImageValue() {");
    worker = replace(worker, "  async function execute(op, args) {", `  async function captureText(args = {}) {
    return observeFrame(() => captureTextValue(args));
  }
  async function capture() { return observeFrame(() => captureImageValue()); }
  async function observeFrame(read) {
    observedFrameId = undefined;
    const value = await requestPacing.observe(read);
    if (value.state === 'ready') observedFrameId = value.frameId;
    return value;
  }
  async function captureTextValue(args = {}) {
    frame = undefined;
    let tab = await selected();
    // Wait only for existing browser load metadata; no DOM/selector polling.
    // SPA updates can still return a partial/empty observation, like an image.
    const until = Math.min(Date.now() + 8000, config.deadlineAt);
    while (tab.status === 'loading' && Date.now() < until) { await pause(100); tab = await chrome.tabs.get(tab.id); }
    allowedNavigation(tab.url);
    if (httpFailures.has(tab.id)) return { state: 'error', reason: 'http_document_failure', ...httpFailures.get(tab.id) };
    await attach(tab.id);
    const tree = await command(tab.id, 'Page.getFrameTree');
    if (tree.frameTree.frame.mimeType !== 'text/html') throw Error('document_blocked');
    const metrics = await command(tab.id, 'Page.getLayoutMetrics');
    const viewport = metrics.cssLayoutViewport, content = metrics.cssContentSize;
    const observation = await chrome.tabs.sendMessage(tab.id, { kind: 'experimental_read_text', ...args }, { frameId: 0 });
    if (observation?.error) throw Error(['invalid_input', 'manual_control_active'].includes(observation.error) ? observation.error : 'operation_failed');
    // A navigation during extraction cannot mint a token for the old document.
    const after = await command(tab.id, 'Page.getFrameTree');
    if (after.frameTree.frame.loaderId !== tree.frameTree.frame.loaderId) throw Error('stale_frame');
    const frameId = crypto.randomUUID(), width = viewport.clientWidth, height = viewport.clientHeight;
    frame = { frameId, tabId: tab.id, mainFrameId: tree.frameTree.frame.id, at: Date.now(), width, height, cssWidth: width, cssHeight: height };
    return { kind: 'trelio.experimental-browser-text/v1', state: 'ready', frameId, width, height,
      scroll: { up: viewport.pageY > 1, down: viewport.pageY + height < content.y + content.height - 1, left: viewport.pageX > 1, right: viewport.pageX + width < content.x + content.width - 1 }, ...observation };
  }
  async function execute(op, args) {`);
    worker = replace(worker, "    if (op === 'screenshot') return capture();", "    if (op === 'screenshot') return capture();\n    if (op === 'read-text') return captureText(args);");
    worker = replace(worker, "    if (op === 'read-text') return captureText(args);", `    if (op === 'read-text') return captureText(args);
    if (op === 'request-ready') {
      // Semantic completion is acknowledged against the exact latest fresh
      // observation, not an old result. Review itself dispatches no site input;
      // the 60s input TTL is still enforced before the eventual next action.
      if (!frame || args.frameId !== frame.frameId || args.frameId !== observedFrameId) throw Error('stale_frame');
      requestPacing.resultsReady();
      return captureText();
    }
    if (op === 'submit') {
      const { action, ...input } = args;
      if (!['navigate', 'click', 'key'].includes(action) || (action === 'key' && input.key !== 'Enter')) throw Error('invalid_input');
      // Re-enter the normal input path AFTER the remaining wait. Its frame,
      // manual gate, origin and original lease must still be valid then.
      return requestPacing.submit(() => execute(action, input));
    }`);
    worker = replace(worker, "    await pause(500);\n    return capture();", "    await pause(500);\n    return captureText();");
    worker = replace(worker, "const reason = ['invalid_input', 'stale_frame', 'navigation_blocked', 'document_blocked', 'manual_control_active', 'session_closed', 'lease_expired'].includes(error.message) ? error.message : 'operation_failed';", "const pacingReason = { BROWSER_REQUEST_PREVIOUS_RESULT_NOT_REVIEWED: 'request_not_reviewed', BROWSER_REQUEST_NO_RESULT_TO_REVIEW: 'request_not_ready' }[error.message];\n          const reason = pacingReason || (['invalid_input', 'stale_frame', 'navigation_blocked', 'document_blocked', 'manual_control_active', 'session_closed', 'lease_expired'].includes(error.message) ? error.message : 'operation_failed');");
    await fs.writeFile(path.join(directory, 'trelio-visual-extension-worker.mjs'), worker);
    let result = await fs.readFile(path.join(directory, 'trelio-visual-result.mjs'), 'utf8');
    result = "import { validateTextResult, TEXT_KIND } from './experimental-text-result.mjs';\n" + result;
    result = replace(result, "export function validateVisualResult(value) { return validateResult(value, false); }", "export function validateVisualResult(value) { return value?.kind === TEXT_KIND ? validateTextResult(value) : validateResult(value, false); }");
    result = replace(result, "'invalid_input', 'http_document_failure'", "'invalid_input', 'http_document_failure', 'request_not_reviewed', 'request_not_ready'");
    await fs.writeFile(path.join(directory, 'trelio-visual-result.mjs'), result);
    let session = await fs.readFile(path.join(directory, 'trelio-visual-session.mjs'), 'utf8');
    session = replace(session, 'AbortSignal.timeout(35_000)', 'AbortSignal.timeout(50_000)');
    await fs.writeFile(path.join(directory, 'trelio-visual-session.mjs'), session);
    let detached = await fs.readFile(path.join(directory, 'trelio-visual-worker.mjs'), 'utf8');
    detached = replace(detached, 'server.requestTimeout = 40_000;', 'server.requestTimeout = 55_000;');
    await fs.writeFile(path.join(directory, 'trelio-visual-worker.mjs'), detached);
    return directory;
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}
