/**
 * This function is materialized as the owned MV3 service worker. It has no
 * scripting permission, arbitrary page evaluate or model-facing DOM reader.
 * Its companion isolated adapter only routes a clicked anchor's destination.
 * Only the closed host command vocabulary below can reach chrome.debugger.
 */
export function visualExtensionWorker(config) {
  let socket, frame, pendingLink, manual = config.manual === true, tail = Promise.resolve();
  const attached = new Set();
  const httpFailures = new Map();
  const allowed = raw => {
    try {
      const u = new URL(raw);
      return !u.username && !u.password && (config.origins.includes(u.origin) || (u.protocol === 'https:' && !u.port && config.domains.some(d => u.hostname === d || u.hostname.endsWith('.' + d))));
    } catch { return false; }
  };
  const allowedNavigation = raw => {
    const u = new URL(raw);
    if (!allowed(raw) || /\.(?:js|mjs|css|json|map|xml|txt|pdf|wasm|zip|exe|dmg)$/iu.test(decodeURIComponent(u.pathname))) throw Error('navigation_blocked');
    return u.href;
  };
  const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Numeric main-document evidence only: no request/response headers or body,
  // and no URL path/query leaves this adapter. Transport errors have no status.
  chrome.webRequest.onBeforeRequest.addListener(details => { httpFailures.delete(details.tabId); }, { urls: config.matches, types: ['main_frame'] });
  chrome.webRequest.onHeadersReceived.addListener(details => {
    const url = new URL(details.url);
    if (url.protocol === 'https:' && allowed(details.url) && details.statusCode >= 400 && details.statusCode <= 599) httpFailures.set(details.tabId, { origin: url.origin, httpStatus: details.statusCode });
  }, { urls: config.matches, types: ['main_frame'] });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (manual || sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || message?.kind !== 'route_link_click' || !pendingLink || pendingLink.tabId !== sender.tab.id) return;
    const pending = pendingLink; pendingLink = undefined;
    try { if (message.download) throw Error('document_blocked'); pending.resolve(allowedNavigation(message.url)); }
    catch { pending.reject(Error('navigation_blocked')); }
  });
  const command = (tabId, method, args = {}) => chrome.debugger.sendCommand({ tabId }, method, args);
  chrome.debugger.onDetach.addListener(source => { attached.delete(source.tabId); if (frame?.tabId === source.tabId) frame = undefined; });
  async function attach(tabId) {
    if (attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    // Do not enable Runtime/Debugger/Network or inspect a page's source. The
    // only page reads are layout metrics, MIME type and raster screenshot.
    await command(tabId, 'Page.enable');
  }
  async function selected() {
    const tabs = (await chrome.tabs.query({ windowType: 'normal' })).filter(t => allowed(t.url));
    const tab = tabs.sort((a, b) => a.id - b.id).at(-1);
    if (!tab) throw Error('session_closed');
    allowedNavigation(tab.url);
    return tab;
  }
  async function capture() {
    frame = undefined;
    const tab = await selected();
    // Capture the selected renderer without selecting its browser tab: on
    // macOS even tabs.update({active:true}) can activate the containing app.
    await attach(tab.id);
    if (httpFailures.has(tab.id)) return { state: 'error', reason: 'http_document_failure', ...httpFailures.get(tab.id) };
    const tree = await command(tab.id, 'Page.getFrameTree');
    if (tree.frameTree.frame.mimeType !== 'text/html') throw Error('document_blocked');
    const metrics = await command(tab.id, 'Page.getLayoutMetrics');
    const viewport = metrics.cssLayoutViewport, content = metrics.cssContentSize;
    let scale = Math.min(1, 1440 / viewport.clientWidth);
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await command(tab.id, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale } });
      const header = Uint8Array.from(atob(result.data.slice(0, 48)), c => c.charCodeAt(0));
      const view = new DataView(header.buffer);
      const width = view.getUint32(16), height = view.getUint32(20);
      if (width <= 1920 && height <= 1440) {
        const frameId = crypto.randomUUID();
        frame = { frameId, tabId: tab.id, at: Date.now(), width, height, cssWidth: viewport.clientWidth, cssHeight: viewport.clientHeight };
        return { state: 'ready', frameId, width, height, scroll: { up: viewport.pageY > 1, down: viewport.pageY + viewport.clientHeight < content.y + content.height - 1, left: viewport.pageX > 1, right: viewport.pageX + viewport.clientWidth < content.x + content.width - 1 }, image: { mimeType: 'image/png', data: result.data } };
      }
      scale *= Math.min(1440 / width, 1000 / height);
    }
    throw Error('operation_failed');
  }
  async function execute(op, args) {
    // Cleanup remains available after the lease; it can only close this owned
    // profile's windows, never send new input or navigate an external page.
    if (Date.now() >= config.deadlineAt && op !== 'close-windows') throw Error('lease_expired');
    if (op === 'heartbeat') return { state: manual ? 'manual_input_required' : 'connected' };
    if (op === 'manual') {
      manual = true; frame = undefined;
      for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.clear();
      const tab = await selected();
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { state: 'manual_input_required' };
    }
    if (op === 'ready') { manual = false; frame = undefined; return { state: 'saved_unverified' }; }
    if (op === 'close-windows') {
      manual = true; frame = undefined;
      for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
      for (const w of await chrome.windows.getAll({ windowTypes: ['normal'] })) await chrome.windows.remove(w.id);
      return { state: 'closed' };
    }
    if (manual) throw Error('manual_control_active');
    if (op === 'navigate') {
      const url = allowedNavigation(args.url);
      frame = undefined;
      const tabs = (await chrome.tabs.query({ windowType: 'normal' })).filter(t => allowed(t.url));
      if (tabs.length) await chrome.tabs.update(tabs.at(-1).id, { url });
      else if ((await chrome.windows.getAll({ windowTypes: ['normal'] })).length) await chrome.tabs.create({ url, active: false });
      else await chrome.windows.create({ url, focused: false, width: 1440, height: 1000 });
      await pause(1000);
      return capture();
    }
    if (op === 'screenshot') return capture();
    const f = frame;
    if (!f || f.frameId !== args.frameId || Date.now() - f.at > 60_000) throw Error('stale_frame');
    const tab = await chrome.tabs.get(f.tabId); allowedNavigation(tab.url);
    frame = undefined; // consume before any input, including an unknown outcome
    const integer = (v, low, high) => Number.isInteger(v) && v >= low && v <= high;
    if (['click', 'scroll'].includes(op) && (!integer(args.x, 0, f.width - 1) || !integer(args.y, 0, f.height - 1))) throw Error('invalid_input');
    const x = args.x * f.cssWidth / f.width, y = args.y * f.cssHeight / f.height;
    if (op === 'click') {
      // Arm a fixed, isolated content adapter before this exact trusted click.
      // It prevents a target=_blank link's default new-tab activation and
      // privately supplies its destination for same-tab navigation. Ordinary
      // field/button clicks retain their unmodified browser semantics.
      await chrome.tabs.sendMessage(f.tabId, { kind: 'arm_link_click', x, y }, { frameId: 0 });
      let routed, routeFailure;
      pendingLink = { tabId: f.tabId, resolve: value => { routed = value; }, reject: error => { routeFailure = error; } };
      await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await pause(100); pendingLink = undefined;
      if (routeFailure) throw routeFailure;
      if (routed) await chrome.tabs.update(f.tabId, { url: routed });
    } else if (op === 'scroll') {
      if (!integer(args.deltaY, -1600, 1600) || !integer(args.deltaX ?? 0, -1600, 1600)) throw Error('invalid_input');
      await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaY: args.deltaY, deltaX: args.deltaX ?? 0 });
    } else if (op === 'type-text') {
      if (typeof args.text !== 'string' || !args.text.length || args.text.length > 4000) throw Error('invalid_input');
      await command(f.tabId, 'Input.insertText', { text: args.text });
    } else if (op === 'key') {
      const keys = { Enter: [13, 'Enter', 'Enter'], Tab: [9, 'Tab', 'Tab'], Escape: [27, 'Escape', 'Escape'], Backspace: [8, 'Backspace', 'Backspace'], Delete: [46, 'Delete', 'Delete'], ArrowUp: [38, 'ArrowUp', 'ArrowUp'], ArrowDown: [40, 'ArrowDown', 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft', 'ArrowLeft'], ArrowRight: [39, 'ArrowRight', 'ArrowRight'], Home: [36, 'Home', 'Home'], End: [35, 'End', 'End'], PageUp: [33, 'PageUp', 'PageUp'], PageDown: [34, 'PageDown', 'PageDown'], 'Control+A': [65, 'a', 'KeyA', 2], 'Meta+A': [65, 'a', 'KeyA', 4], 'Shift+Tab': [9, 'Tab', 'Tab', 8] };
      const spec = keys[args.key]; if (!spec) throw Error('invalid_input');
      await command(f.tabId, 'Input.dispatchKeyEvent', { type: args.key === 'Enter' ? 'keyDown' : 'rawKeyDown', windowsVirtualKeyCode: spec[0], key: spec[1], code: spec[2], modifiers: spec[3] || 0,
        ...(args.key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
        ...(['Meta+A', 'Control+A'].includes(args.key) ? { commands: ['selectAll'] } : {}),
      });
      await command(f.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: spec[0], key: spec[1], code: spec[2], modifiers: spec[3] || 0 });
    } else throw Error('invalid_input');
    await pause(500);
    return capture();
  }
  function connect() {
    if (Date.now() >= config.deadlineAt) return;
    socket = new WebSocket(config.endpoint, ['trelio-visual-v1', config.token]);
    socket.onopen = () => send({ kind: 'hello', version: 1 });
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.id !== 'string' || typeof message.operation !== 'string') return;
      const run = async () => {
        try { send({ kind: 'result', id: message.id, result: await execute(message.operation, message.args || {}) }); }
        catch (error) {
          const reason = ['invalid_input', 'stale_frame', 'navigation_blocked', 'document_blocked', 'manual_control_active', 'session_closed', 'lease_expired'].includes(error.message) ? error.message : 'operation_failed';
          send({ kind: 'result', id: message.id, result: { state: 'error', reason } });
        }
      };
      // A renderer input acknowledgement must not prevent transport keepalive
      // or bounded cleanup. These commands cannot dispatch external input.
      if (['heartbeat', 'close-windows'].includes(message.operation)) void run();
      else tail = tail.then(run);
    };
    // Reconnect only the transport. Never resend a previous action or infer
    // its outcome from a missing reply after worker/browser disconnect.
    socket.onclose = () => { frame = undefined; setTimeout(connect, 1000); };
  }
  chrome.windows.onRemoved.addListener(async () => {
    if (!(await chrome.windows.getAll({ windowTypes: ['normal'] })).length) send({ kind: 'windows_closed', manual });
  });
  // Bootstrap an inactive ordinary window from the extension rather than a
  // foreground startup URL. This does not require a debugging pipe/port and
  // avoids activating the OS app for each restored worker session.
  (async () => {
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Response-stage guards deny a document download before its body reaches
    // a file. They outrank origin allow rules, including a hidden attachment
    // behind a normal URL. No headers/body are exposed through the API.
    const rules = [
      { id: 1, priority: 1, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['main_frame'] } },
      { id: 2, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['main_frame', 'sub_frame'], responseHeaders: [{ header: 'content-disposition', values: ['*attachment*'] }] } },
      { id: 3, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['main_frame', 'sub_frame'], excludedResponseHeaders: [{ header: 'content-type', values: ['text/html*'] }] } },
    ];
    let ruleId = 4;
    for (const origin of config.origins) rules.push({ id: ruleId++, priority: 2, action: { type: 'allow' }, condition: { regexFilter: '^' + escape(origin) + '(?:/|$)', resourceTypes: ['main_frame'] } });
    for (const domain of config.domains) rules.push({ id: ruleId++, priority: 2, action: { type: 'allow' }, condition: { regexFilter: '^https://([a-zA-Z0-9-]+\\.)*' + escape(domain) + '/', resourceTypes: ['main_frame'] } });
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map(rule => rule.id), addRules: rules });
    if (!(await chrome.windows.getAll({ windowTypes: ['normal'] })).length) await chrome.windows.create({ url: config.initialUrl, focused: manual, width: 1440, height: 1000 });
    connect();
  })();
}
