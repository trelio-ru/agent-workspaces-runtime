/**
 * These functions are materialized as the owned MV3 service worker. It has no
 * scripting permission, arbitrary page evaluate or DOM-tree projection.
 * Fixed isolated adapters route links and, only on signed opt-in, read rendered text.
 * Only the closed host command vocabulary below can reach chrome.debugger.
 */
export function visualDocumentResponsePolicy(status, headers) {
  // Response metadata stays inside the trusted adapter. A redirect is not a
  // document: valid 301/302/303/307/308 responses may omit Content-Type entirely.
  // A Location on a 200 must NOT exempt a binary/download response from checks.
  if (!Number.isInteger(status) || status < 200 || status > 599 || !Array.isArray(headers) || headers.length > 256) return 'block';
  let bytes = 0;
  const fields = new Map();
  for (const header of headers) {
    if (typeof header?.name !== 'string' || typeof header.value !== 'string' || (bytes += header.name.length + header.value.length) > 65536) return 'block';
    const name = header.name.toLowerCase();
    if (['content-type', 'location', 'content-disposition'].includes(name)) {
      if (fields.has(name)) return 'block';
      fields.set(name, header.value);
    }
  }
  if (/\battachment\b/i.test(fields.get('content-disposition') || '')) return 'block';
  if ([301, 302, 303, 307, 308].includes(status) && fields.get('location')?.trim()) return 'redirect';
  return (fields.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() === 'text/html' ? 'html' : 'block';
}

export function visualExtensionWorker(config, cookieState, createPacing, createTabBudget, documentPolicy) {
  const requestPacing = createPacing();
  const tabBudget = createTabBudget();
  let observedFrameId, navigationGeneration = 0;
  let socket, frame, pendingLink, manual = config.manual === true, tail = Promise.resolve();
  let authenticating = false;
  let bootstrapState = 'pending', bootstrapStage = 'policy', stopping = false;
  let authReady, authStarted = false, authRestored = false, authInitialising = false, authFrozen = false, authTimer;
  const authJar = new Map(), authChanges = [];
  const ownedWindows = new Set(), windowChanges = [];
  let windowInventoryReady = false;
  const attached = new Set();
  const guardedTabs = new Set(), documentFailures = new Set();
  let guardUpdate = Promise.resolve(), guardFailed = false;
  let pendingAttachment, pendingFileLink;
  let tabCleanup = Promise.resolve(), tabCleanupFailed = false;
  const admitTab = tab => {
    if (tabBudget.admit(tab.id)) return;
    // Native tabs.onCreated is necessarily post-creation. Close overflow
    // promptly; serialize removals and fail closed if Chrome refuses cleanup.
    // We never activate or restore another app to disguise popup focus.
    tabCleanup = tabCleanup.then(() => chrome.tabs.remove(tab.id)).catch(() => { tabCleanupFailed = true; });
  };
  chrome.tabs.onCreated.addListener(admitTab);
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
  const activeStartup = () => { if (stopping || Date.now() >= config.deadlineAt) throw Error('lease_expired'); };
  const privateAuthSnapshot = () => cookieState.validate([...authJar.values()]);
  const publishAuth = () => { clearTimeout(authTimer); send({ kind: 'session_auth', cookies: privateAuthSnapshot() }); };
  const authFailure = () => { clearTimeout(authTimer); send({ kind: 'auth_state_failed' }); };
  const applyAuthChange = change => { const id = cookieState.key(change.cookie); if (change.removed) authJar.delete(id); else authJar.set(id, change.cookie); };
  const flushAuthChanges = () => { for (const change of authChanges.splice(0)) applyAuthChange(change); };
  async function allSessionCookies() {
    // An omitted partitionKey selects only ordinary cookies. An empty key in
    // getAll selects all CHIPS partitions; merge by the full private identity.
    const batches = await Promise.all([chrome.cookies.getAll({ session: true, storeId: '0' }), chrome.cookies.getAll({ session: true, storeId: '0', partitionKey: {} })]);
    const values = new Map();
    for (const batch of batches) for (const value of batch) { const cookie = cookieState.fromChrome(value); if (cookie) values.set(cookieState.key(cookie), cookie); }
    return cookieState.validate([...values.values()]);
  }
  async function refreshAuth() {
    if (authFrozen) return privateAuthSnapshot();
    authInitialising = true;
    try {
      const values = await allSessionCookies();
      if (authFrozen) { authInitialising = false; authChanges.length = 0; publishAuth(); return privateAuthSnapshot(); }
      authJar.clear();
      for (const cookie of values) authJar.set(cookieState.key(cookie), cookie);
      authInitialising = false;
      flushAuthChanges();
      publishAuth(); return privateAuthSnapshot();
    } catch (error) { authInitialising = false; authFailure(); throw error; }
  }
  chrome.cookies.onChanged.addListener(change => {
    if (!authRestored || authFrozen) return;
    try {
      const cookie = cookieState.fromChrome(change.cookie); if (!cookie) return;
      if (authInitialising) {
        if (authChanges.length >= 1024) throw Error('storage_unavailable');
        authChanges.push({ removed: change.removed === true, cookie }); return;
      }
      applyAuthChange({ removed: change.removed === true, cookie }); privateAuthSnapshot();
      // Changes are applied immediately; only private transport publication is
      // coalesced. Startup/window-close/cleanup explicitly flush the final jar.
      clearTimeout(authTimer); authTimer = setTimeout(() => { try { publishAuth(); } catch { authFailure(); } }, 50);
    } catch { authFailure(); }
  });
  function windowClosing(windowId, earlyTabEvent = false) {
    if (!authRestored || authFrozen) return;
    // Cookie changes already delivered before the tab-close event belong to
    // the user session (including logout). Later profile-cleanup removals do
    // not. The later window-removed notification must not flush those again.
    if (earlyTabEvent) { try { flushAuthChanges(); privateAuthSnapshot(); } catch { authFailure(); } }
    if (windowInventoryReady && ![...ownedWindows].some(id => id !== windowId)) {
      // Do not await a windows.getAll() after the final close: Chromium can
      // tear down the profile before that API callback is dispatched. Track
      // native create/remove events instead, and synchronously freeze/send
      // before session cleanup. Popups count as owned windows too.
      authFrozen = true; authChanges.length = 0;
      try { publishAuth(); } catch { authFailure(); }
    }
  }
  chrome.windows.onCreated.addListener(window => {
    if (!['normal', 'popup'].includes(window.type)) return;
    if (windowInventoryReady) ownedWindows.add(window.id); else windowChanges.push({ id: window.id, removed: false });
  });
  chrome.tabs.onRemoved.addListener((_tabId, info) => { tabBudget.removed(_tabId); httpFailures.delete(_tabId); if (info.isWindowClosing) windowClosing(info.windowId, true); });
  // Numeric main-document evidence only: no request/response headers or body,
  // and no URL path/query leaves this adapter. Transport errors have no status.
  chrome.webRequest.onBeforeRequest.addListener(details => { httpFailures.delete(details.tabId); documentFailures.delete(details.tabId); }, { urls: config.matches, types: ['main_frame'] });
  chrome.webRequest.onHeadersReceived.addListener(details => {
    const url = new URL(details.url);
    if (url.protocol === 'https:' && allowed(details.url) && details.statusCode >= 400 && details.statusCode <= 599) httpFailures.set(details.tabId, { origin: url.origin, httpStatus: details.statusCode });
  }, { urls: config.matches, types: ['main_frame'] });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (manual || sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return;
    if (message?.kind === 'route_attachment_open' && pendingFileLink?.tabId === sender.tab.id && pendingFileLink.nonce === message.nonce) {
      pendingFileLink.resolve(message.url); return;
    }
    if (message?.kind !== 'route_link_click' || !pendingLink || pendingLink.tabId !== sender.tab.id) return;
    const pending = pendingLink; pendingLink = undefined;
    try { if (message.download) throw Error('document_blocked'); pending.resolve(allowedNavigation(message.url)); }
    catch { pending.reject(Error('navigation_blocked')); }
  });
  const command = (tabId, method, args = {}) => chrome.debugger.sendCommand({ tabId }, method, args);
  chrome.debugger.onDetach.addListener(source => {
    attached.delete(source.tabId); guardedTabs.delete(source.tabId);
    if (frame?.tabId === source.tabId) frame = undefined;
    if (pendingAttachment?.tabId === source.tabId) pendingAttachment.reject(Error('operation_failed'));
    // Revoke the response-rule exception after unexpected native detach. No
    // further observation/input runs while that policy write is unresolved.
    guardUpdate = guardUpdate.then(() => installRules()).catch(() => { guardFailed = true; });
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Fetch.requestPaused') {
      // Fixed response-stage Document interception only; never request a body,
      // evaluate site code or return headers/URLs through the pixels/text API.
      // DNR still bounds every main-frame destination and blocks attachments.
      void (async () => {
        const download = pendingAttachment;
        if (download && source.tabId === download.tabId && params.frameId === download.mainFrameId && params.resourceType === 'Document') {
          try {
            if (!allowed(params.request?.url)) throw Error('navigation_blocked');
            if (documentPolicy(params.responseStatusCode, params.responseHeaders) === 'redirect') {
              await command(source.tabId, 'Fetch.continueRequest', { requestId: params.requestId }); return;
            }
            await receiveAttachment(download, params);
          } catch (error) {
            await command(source.tabId, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }).catch(() => {});
            download.reject(error);
          }
          return;
        }
        const decision = params.resourceType === 'Document' ? documentPolicy(params.responseStatusCode, params.responseHeaders) : 'block';
        if (decision !== 'block') {
          await command(source.tabId, 'Fetch.continueRequest', { requestId: params.requestId });
        } else {
          frame = undefined; documentFailures.add(source.tabId);
          await command(source.tabId, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
        }
      })().catch(() => { guardFailed = true; frame = undefined; });
      return;
    }
    // An allowed navigation still replaces the pictured document. Retire its
    // token without reading/forwarding event URLs, frame trees or page data.
    if ((method === 'Page.frameNavigated' && !params.frame?.parentId) || method === 'Page.navigatedWithinDocument') navigationGeneration++;
    if (source.tabId === frame?.tabId && ((method === 'Page.frameNavigated' && !params.frame?.parentId)
      || (method === 'Page.navigatedWithinDocument' && params.frameId === frame.mainFrameId))) frame = undefined;
  });
  async function receiveAttachment(download, params) {
    // The only body-reading path belongs to one explicit coordinate-selected
    // incoming attachment. It cannot read an HTML page/source, take a URL from
    // the model, intercept XHR/subresources, or continue into native Save As.
    const maximum = 20 * 1024 * 1024, headers = new Map();
    if (params.responseStatusCode !== 200 || !Array.isArray(params.responseHeaders) || params.responseHeaders.length > 256) throw Error('attachment_unsupported');
    let headerBytes = 0;
    for (const header of params.responseHeaders) {
      if (typeof header.name !== 'string' || typeof header.value !== 'string' || (headerBytes += header.name.length + header.value.length) > 65536) throw Error('attachment_unsupported');
      const name = header.name.toLowerCase();
      if (['content-type', 'content-length', 'content-disposition', 'content-encoding'].includes(name)) { if (headers.has(name)) throw Error('attachment_unsupported'); headers.set(name, header.value); }
    }
    const mimeType = (headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    const types = /^(?:image\/(?:png|jpeg|gif|webp|tiff|bmp)|text\/(?:plain|csv|rtf)|application\/(?:octet-stream|pdf|rtf|zip|x-zip-compressed|msword|vnd\.ms-(?:excel|powerpoint)|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.oasis\.opendocument\.(?:text|spreadsheet|presentation)))$/u;
    if (!types.test(mimeType)) throw Error('attachment_unsupported');
    const length = headers.get('content-length');
    if (length !== undefined && (!/^\d{1,10}$/u.test(length) || Number(length) > maximum)) throw Error('attachment_too_large');
    const check = () => { if (pendingAttachment !== download || Date.now() >= download.until || Date.now() >= config.deadlineAt) throw Error('operation_failed'); };
    check();
    const { stream } = await command(download.tabId, 'Fetch.takeResponseBodyAsStream', { requestId: params.requestId });
    let total = 0; const chunks = [];
    try {
      for (;;) {
        check();
        let timer;
        const item = await Promise.race([command(download.tabId, 'IO.read', { handle: stream, size: 65536 }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('operation_failed')), Math.max(1, download.until - Date.now())); })]).finally(() => clearTimeout(timer));
        check();
        if (typeof item.data !== 'string' || item.data.length > 131072) throw Error('attachment_too_large');
        const chunk = item.base64Encoded ? Uint8Array.from(atob(item.data), c => c.charCodeAt(0)) : new TextEncoder().encode(item.data);
        if ((total += chunk.length) > maximum) throw Error('attachment_too_large');
        chunks.push(chunk);
        if (item.eof) break;
        if (!chunk.length) throw Error('operation_failed');
      }
      check();
      // Content-Length may describe the encoded transfer; IO reads decoded
      // bytes. Enforce the hard decoded budget independently, and compare the
      // declared size only for an identity/no-encoding response.
      if (!total || (length !== undefined && (!headers.get('content-encoding') || headers.get('content-encoding') === 'identity') && Number(length) !== total)) throw Error('attachment_unsupported');
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; chunk.fill(0); }
      let dataBase64 = '';
      try {
        // Each nonfinal segment is a multiple of three bytes, so concatenation
        // preserves canonical base64 without an unbounded spread/call stack.
        for (let i = 0; i < total; i += 49152) dataBase64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 49152)));
      } finally { bytes.fill(0); }
      check();
      // 204 cancels document replacement while preserving the current chat.
      // Browser-native downloads never receive the original attachment body.
      await command(download.tabId, 'Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 204, responseHeaders: [], body: '' });
      check();
      download.resolve({ state: 'ready', file: { mimeType, dataBase64 } });
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      await command(download.tabId, 'IO.close', { handle: stream }).catch(() => {});
    }
  }
  async function attach(tabId) {
    if (attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    // Do not enable Runtime/Debugger/Network or inspect a page's source. The
    // only page reads are layout metrics, MIME type and raster screenshot.
    await command(tabId, 'Page.enable');
    // Enable the final-document guard BEFORE exempting this exact owned tab
    // from DNR's MIME-only rule. Unattached popups keep the strict default;
    // their mere creation never opens an unguarded download/navigation gap.
    await command(tabId, 'Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
    guardedTabs.add(tabId);
    guardUpdate = guardUpdate.then(() => installRules());
    try { await guardUpdate; } catch (error) { guardFailed = true; throw error; }
  }
  // Input belongs to the browser's already-selected tab. Merely choosing the
  // newest background popup can capture its pixels but lose keyboard input;
  // choosing an existing active target needs no per-action focus activation.
  const preferredTab = tabs => tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || b.id - a.id)[0];
  async function selected() {
    await guardUpdate;
    if (guardFailed) throw Error('document_blocked');
    await tabCleanup;
    if (tabCleanupFailed) throw Error('tab_limit_reached');
    const tabs = (await chrome.tabs.query({ windowType: 'normal' })).filter(t => tabBudget.contains(t.id) && allowed(t.url));
    const tab = preferredTab(tabs);
    if (!tab) throw Error('session_closed');
    allowedNavigation(tab.url);
    return tab;
  }
  async function credentialGuard(tabId) {
    const value = await chrome.tabs.sendMessage(tabId, { kind: 'authentication-guard' }, { frameId: 0 });
    if (value?.blocked !== false) throw Error('manual_control_active');
  }
  async function captureImageValue() {
    frame = undefined;
    let tab = await selected();
    // Window creation is not document readiness, especially on a cold native
    // Windows launch. Wait only for browser navigation metadata, never page
    // JS/DOM or a site-specific selector. SPA loading can still be visible in
    // the resulting picture and requires ordinary visual review.
    const until = Math.min(Date.now() + 8000, config.deadlineAt);
    while (tab.status === 'loading' && Date.now() < until) { await pause(100); tab = await chrome.tabs.get(tab.id); }
    allowedNavigation(tab.url);
    // Capture the selected renderer without selecting its browser tab: on
    // macOS even tabs.update({active:true}) can activate the containing app.
    await attach(tab.id);
    if (documentFailures.has(tab.id)) throw Error('document_blocked');
    if (httpFailures.has(tab.id)) return { state: 'error', reason: 'http_document_failure', ...httpFailures.get(tab.id) };
    const tree = await command(tab.id, 'Page.getFrameTree');
    if (tree.frameTree.frame.url?.startsWith('chrome-error://')) throw Error('document_blocked');
    if (tree.frameTree.frame.mimeType !== 'text/html') throw Error('document_blocked');
    await credentialGuard(tab.id);
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
        await credentialGuard(tab.id);
        const frameId = crypto.randomUUID();
        frame = { frameId, tabId: tab.id, mainFrameId: tree.frameTree.frame.id, at: Date.now(), width, height, cssWidth: viewport.clientWidth, cssHeight: viewport.clientHeight };
        return { state: 'ready', frameId, width, height, scroll: { up: viewport.pageY > 1, down: viewport.pageY + viewport.clientHeight < content.y + content.height - 1, left: viewport.pageX > 1, right: viewport.pageX + viewport.clientWidth < content.x + content.width - 1 }, image: { mimeType: 'image/png', data: result.data } };
      }
      scale *= Math.min(1440 / width, 1000 / height);
    }
    throw Error('operation_failed');
  }
  async function captureDefault() { return config.observationMode === 'text' ? captureText() : capture(); }
  async function captureText(args = {}) {
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
    if (documentFailures.has(tab.id)) throw Error('document_blocked');
    const tree = await command(tab.id, 'Page.getFrameTree');
    if (tree.frameTree.frame.url?.startsWith('chrome-error://')) throw Error('document_blocked');
    if (tree.frameTree.frame.mimeType !== 'text/html') throw Error('document_blocked');
    const metrics = await command(tab.id, 'Page.getLayoutMetrics');
    const viewport = metrics.cssLayoutViewport, content = metrics.cssContentSize;
    const generation = navigationGeneration;
    const observation = await chrome.tabs.sendMessage(tab.id, { kind: 'read_rendered_text', ...args }, { frameId: 0 });
    if (observation?.error) throw Error(['invalid_input', 'manual_control_active'].includes(observation.error) ? observation.error : 'operation_failed');
    // A navigation during extraction cannot mint a token for the old document.
    const after = await command(tab.id, 'Page.getFrameTree');
    if (generation !== navigationGeneration || after.frameTree.frame.loaderId !== tree.frameTree.frame.loaderId) throw Error('stale_frame');
    const frameId = crypto.randomUUID(), width = viewport.clientWidth, height = viewport.clientHeight;
    frame = { frameId, tabId: tab.id, mainFrameId: tree.frameTree.frame.id, at: Date.now(), width, height, cssWidth: width, cssHeight: height };
    return { kind: 'trelio.browser-text/v1', state: 'ready', frameId, width, height,
      scroll: { up: viewport.pageY > 1, down: viewport.pageY + height < content.y + content.height - 1, left: viewport.pageX > 1, right: viewport.pageX + width < content.x + content.width - 1 }, ...observation };
  }
  async function execute(op, args) {
    // Cleanup remains available after the lease; it can only close this owned
    // profile's windows, never send new input or navigate an external page.
    if (Date.now() >= config.deadlineAt && !['close-windows', 'snapshot-session-auth'].includes(op)) throw Error('lease_expired');
    if (op === 'restore-session-auth') {
      if (!authReady || authStarted || bootstrapStage !== 'auth' || typeof args.replace !== 'boolean') throw Error('invalid_input');
      authStarted = true;
      try {
        activeStartup();
        if (args.replace) {
          // An explicitly empty saved jar represents logout. Remove stale
          // native session rows before restoring it, without touching persistent
          // cookies or visiting a provider URL. Legacy snapshots have no overlay
          // and retain their native session data during the first migration.
          for (const cookie of await allSessionCookies()) {
            activeStartup();
            const details = cookieState.forChrome(cookie);
            await chrome.cookies.remove({ url: details.url, name: details.name, storeId: '0', ...(details.partitionKey ? { partitionKey: details.partitionKey } : {}) });
          }
        }
        for (const cookie of cookieState.validate(args.cookies)) { activeStartup(); if (!await chrome.cookies.set(cookieState.forChrome(cookie))) throw Error('storage_unavailable'); }
        activeStartup(); authRestored = true; await refreshAuth(); activeStartup(); authReady.resolve(); return { state: 'saved_unverified' };
      } catch (error) { authReady.reject(error); throw error; }
    }
    if (op === 'fixture-tab-budget' && config.fixtureOnly) {
      // Only the localhost native fixture may deliberately bypass host creation
      // preflight to exercise real Chromium onCreated overflow/cleanup events.
      // No caller URL, tab IDs, site content or general browser command is used.
      for (let i = 0; i < 8; i++) { activeStartup(); await chrome.tabs.create({ url: config.initialUrl, active: false }); }
      const until = Math.min(Date.now() + 3000, config.deadlineAt);
      let tabs;
      do { await pause(50); await tabCleanup; tabs = await chrome.tabs.query({}); } while (tabs.length > 5 && Date.now() < until);
      return { state: 'fixture', ...tabBudget.counts, actualOpen: tabs.length };
    }
    if (op === 'snapshot-session-auth') return { state: 'saved_unverified', cookies: await refreshAuth() };
    if (op === 'heartbeat') return { state: manual ? 'manual_input_required' : 'connected' };
    if (['authentication-start', 'authentication-probe', 'authentication-fill', 'authentication-follow', 'authentication-end'].includes(op)) {
      if (!config.authentication) throw Error('invalid_input');
      if (op === 'authentication-start') {
        if (manual || authenticating) throw Error('manual_control_active');
        authenticating = true; frame = undefined; observedFrameId = undefined;
        return { state: 'connected' };
      }
      if (!authenticating) throw Error('invalid_input');
      await guardUpdate;
      if (guardFailed) throw Error('document_blocked');
      const tab = await selected(); allowedNavigation(tab.url);
      if (documentFailures.has(tab.id) || httpFailures.has(tab.id)) throw Error('document_blocked');
      if (op === 'authentication-end') {
        const verified = args.success === true && (await chrome.tabs.sendMessage(tab.id, { kind: 'authentication-probe' }, { frameId: 0 }))?.state === 'success';
        authenticating = false; manual = !verified; frame = undefined;
        if (args.success === true && !verified) throw Error('manual_control_active');
        return { state: verified ? 'saved_unverified' : 'manual_input_required' };
      }
      // Fixed top-frame messages, never arbitrary DOM/evaluate/CDP. Values
      // stay in this private channel; the public call API has no such aliases.
      return chrome.tabs.sendMessage(tab.id, { kind: op, ...(['authentication-fill', 'authentication-follow', 'authentication-probe'].includes(op) ? args : {}) }, { frameId: 0 });
    }
    if (op === 'manual') {
      manual = true; frame = undefined;
      for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.clear();
      // Human authentication may use an owned popup. Counting/showing these
      // surfaces does not enable model-facing popup/DOM extraction.
      const tab = (await chrome.tabs.query({})).filter(tab => allowed(tab.url)).at(-1);
      if (!tab) throw Error('session_closed');
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { state: 'manual_input_required' };
    }
    if (op === 'ready') { manual = false; frame = undefined; return { state: 'saved_unverified' }; }
    if (op === 'close-windows' || (op === 'fixture-close-windows' && config.fixtureOnly)) {
      stopping = true;
      if (bootstrapState === 'pending') authReady?.reject(Error('lease_expired'));
      // The fixture command reproduces a human window-close without taking a
      // proactive host snapshot. It is unavailable to a production provider.
      if (op === 'close-windows' && authRestored) { try { await refreshAuth(); authFrozen = true; publishAuth(); } catch { authFailure(); } }
      manual = true; frame = undefined;
      for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
      for (const id of [...ownedWindows]) await chrome.windows.remove(id);
      return { state: 'closed' };
    }
    if (manual || authenticating) throw Error('manual_control_active');
    await guardUpdate;
    if (guardFailed) throw Error('document_blocked');
    if (op === 'navigate') {
      const url = allowedNavigation(args.url);
      frame = undefined;
      await tabCleanup;
      if (tabCleanupFailed) throw Error('tab_limit_reached');
      const tabs = (await chrome.tabs.query({ windowType: 'normal' })).filter(t => tabBudget.contains(t.id) && allowed(t.url));
      let target;
      if (tabs.length) target = preferredTab(tabs);
      else if (!tabBudget.canCreate) throw Error('tab_limit_reached');
      else if ((await chrome.windows.getAll({ windowTypes: ['normal'] })).length) target = await chrome.tabs.create({ url: 'about:blank', active: false });
      else target = (await chrome.windows.create({ url: 'about:blank', focused: false, width: 1440, height: 1000 })).tabs?.[0];
      await attach(target.id);
      await chrome.tabs.update(target.id, { url });
      await pause(1000);
      return captureDefault();
    }
    if (op === 'screenshot') return capture();
    if (['read-text', 'submit', 'request-ready'].includes(op) && config.observationMode !== 'text') throw Error('invalid_input');
    if (op === 'read-text') return captureText(args);
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
    }
    const f = frame;
    if (!f || f.frameId !== args.frameId || Date.now() - f.at > 60_000) throw Error('stale_frame');
    const tab = await chrome.tabs.get(f.tabId); allowedNavigation(tab.url);
    await credentialGuard(tab.id);
    frame = undefined; // consume before any input, including an unknown outcome
    const integer = (v, low, high) => Number.isInteger(v) && v >= low && v <= high;
    if (['click', 'scroll', 'download-attachment'].includes(op) && (!integer(args.x, 0, f.width - 1) || !integer(args.y, 0, f.height - 1))) throw Error('invalid_input');
    const x = args.x * f.cssWidth / f.width, y = args.y * f.cssHeight / f.height;
    if (op === 'download-attachment') {
      if (config.attachmentDownloads !== true || pendingAttachment) throw Error('invalid_input');
      const link = await chrome.tabs.sendMessage(f.tabId, { kind: 'resolve_attachment_link', x, y }, { frameId: 0 });
      let candidate = link?.url;
      if (!candidate) {
        // Some attachment cards are buttons calling window.open, without an
        // anchor href. A fixed one-click MAIN router captures that destination
        // locally before Chrome can activate a popup. No site code is read or
        // evaluated, and a timeout never falls back to opening a native window.
        const nonce = crypto.randomUUID(); let linkTimer;
        const destination = new Promise((resolve, reject) => { pendingFileLink = { tabId: f.tabId, nonce, resolve }; linkTimer = setTimeout(() => reject(Error('attachment_link_required')), 5000); });
        destination.catch(() => {});
        try {
          const ack = await chrome.tabs.sendMessage(f.tabId, { kind: 'arm_attachment_click', nonce, x, y }, { frameId: 0 });
          if (!ack?.ready) throw Error('attachment_link_required');
          await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await command(f.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          candidate = await destination;
        } finally {
          clearTimeout(linkTimer); pendingFileLink = undefined;
          await chrome.tabs.sendMessage(f.tabId, { kind: 'cancel_attachment_click' }, { frameId: 0 }).catch(() => {});
        }
      }
      if (typeof candidate !== 'string' || !candidate || candidate.length > 4096) throw Error('attachment_link_required');
      const url = new URL(candidate, tab.url);
      if (!allowed(url.href) || /\.(?:js|mjs|cjs|css|json|map|xml|html?|xhtml|svg|wasm|exe|dll|dmg|sh|ps1|bat|cmd)$/iu.test(decodeURIComponent(url.pathname))) throw Error('navigation_blocked');
      let timer;
      const promise = new Promise((resolve, reject) => {
        pendingAttachment = { tabId: f.tabId, mainFrameId: f.mainFrameId, until: Math.min(Date.now() + 30_000, config.deadlineAt), resolve, reject };
        timer = setTimeout(() => reject(Error('operation_failed')), Math.max(1, pendingAttachment.until - Date.now()));
      });
      // Observe rejection immediately while Chrome installs the exact-tab rule;
      // a detach/expiry must not become an unhandled rejected worker promise.
      promise.catch(() => {});
      try {
        guardUpdate = guardUpdate.then(() => installRules()); await guardUpdate;
        if (guardFailed || Date.now() >= pendingAttachment.until) throw Error('operation_failed');
        await chrome.tabs.update(f.tabId, { url: url.href });
        return await promise;
      } finally {
        clearTimeout(timer); pendingAttachment = undefined;
        guardUpdate = guardUpdate.then(() => installRules()).catch(() => { guardFailed = true; });
        await guardUpdate;
      }
    }
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
    return captureDefault();
  }
  function connect() {
    if (Date.now() >= config.deadlineAt) return;
    socket = new WebSocket(config.endpoint, ['trelio-visual-v1', config.token]);
    socket.onopen = () => {
      if (bootstrapState === 'ready') send({ kind: 'hello', version: 1 });
      else if (bootstrapState === 'failed') send({ kind: 'bootstrap_failed', stage: bootstrapStage });
      else if (bootstrapStage === 'auth' && authReady && !authStarted) send({ kind: 'auth_required' });
    };
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.id !== 'string' || typeof message.operation !== 'string' || (bootstrapState !== 'ready' && !['close-windows', 'restore-session-auth'].includes(message.operation))) return;
      const run = async () => {
        try { send({ kind: 'result', id: message.id, result: await execute(message.operation, message.args || {}) }); }
        catch (error) {
          const pacingReason = { BROWSER_REQUEST_PREVIOUS_RESULT_NOT_REVIEWED: 'request_not_reviewed', BROWSER_REQUEST_NO_RESULT_TO_REVIEW: 'request_not_ready' }[error.message];
          const reason = pacingReason || (['invalid_input', 'stale_frame', 'navigation_blocked', 'document_blocked', 'manual_control_active', 'session_closed', 'lease_expired', 'tab_limit_reached', 'attachment_unsupported', 'attachment_too_large', 'attachment_link_required'].includes(error.message) ? error.message : 'operation_failed');
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
  chrome.windows.onRemoved.addListener(windowId => {
    if (!windowInventoryReady) { windowChanges.push({ id: windowId, removed: true }); return; }
    ownedWindows.delete(windowId);
    windowClosing(windowId);
    if (!ownedWindows.size) send({ kind: 'windows_closed', manual });
  }, { windowTypes: ['normal', 'popup'] });
  // Connect before policy/window preparation so a native startup failure can
  // report one closed stage rather than disappear into a socket timeout.
  // Reconnection only repeats readiness, never the initial navigation.
  connect();
  async function installRules() {
      const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Attachment rules always outrank origin allow rules. The MIME-only
      // fallback stays strict for new/unattached tabs and subframes; an exact
      // tab is exempted only after its response-status-aware Fetch guard exists.
      // Otherwise a legitimate headerless redirect is mistaken for a file.
      const rules = [
        { id: 1, priority: 1, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['main_frame'] } },
        { id: 2, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['main_frame'], ...(pendingAttachment && guardedTabs.has(pendingAttachment.tabId) ? { excludedTabIds: [pendingAttachment.tabId] } : {}), responseHeaders: [{ header: 'content-disposition', values: ['*attachment*'] }] } },
        { id: 3, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['main_frame'], ...(guardedTabs.size ? { excludedTabIds: [...guardedTabs] } : {}), excludedResponseHeaders: [{ header: 'content-type', values: ['text/html*'] }] } },
        { id: 4, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['sub_frame'], excludedResponseHeaders: [{ header: 'content-type', values: ['text/html*'] }] } },
        { id: 5, priority: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://', resourceTypes: ['sub_frame'], responseHeaders: [{ header: 'content-disposition', values: ['*attachment*'] }] } },
      ];
      let ruleId = 6;
      for (const origin of config.origins) rules.push({ id: ruleId++, priority: 2, action: { type: 'allow' }, condition: { regexFilter: '^' + escape(origin) + '(?:/|$)', resourceTypes: ['main_frame'] } });
      for (const domain of config.domains) rules.push({ id: ruleId++, priority: 2, action: { type: 'allow' }, condition: { regexFilter: '^https://([a-zA-Z0-9-]+\\.)*' + escape(domain) + '/', resourceTypes: ['main_frame'] } });
      // This profile and its signed navigation policy live for one browser
      // process only. Session rules have that exact lifetime and avoid an
      // unnecessary persistent ruleset write before the first provider URL.
      // A service-worker reconnect never drops the browser's session rules.
      bootstrapStage = 'policy_read';
      const previous = await chrome.declarativeNetRequest.getSessionRules();
      bootstrapStage = 'policy_write';
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: previous.map(rule => rule.id), addRules: rules });
  }
  (async () => {
    try {
      await installRules();
      bootstrapStage = 'window_inventory';
      for (const window of await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] })) ownedWindows.add(window.id);
      for (const change of windowChanges.splice(0)) { if (change.removed) ownedWindows.delete(change.id); else ownedWindows.add(change.id); }
      windowInventoryReady = true;
      for (const tab of await chrome.tabs.query({})) admitTab(tab);
      await tabCleanup;
      if (tabCleanupFailed) throw Error('tab_limit_reached');
      activeStartup();
      bootstrapStage = 'auth';
      await new Promise((resolve, reject) => { authReady = { resolve, reject }; send({ kind: 'auth_required' }); });
      activeStartup();
      bootstrapStage = 'window';
      // Windows host startup opens an internal new tab; other desktops let this
      // extension create the initial inactive window. Navigate the owned blank
      // tab after guards exist, without selecting/focusing a tab on every
      // command. Private auth stores exclude Sessions, so no user tab is reused.
      const tabs = await chrome.tabs.query({ windowType: 'normal' });
      const blank = tabs.find(tab => ['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/'].includes(tab.url));
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      activeStartup();
      let initial;
      if (blank) initial = blank;
      else if (!tabBudget.canCreate) throw Error('tab_limit_reached');
      else if (!windows.length) initial = (await chrome.windows.create({ url: 'about:blank', focused: manual, width: 1440, height: 1000 })).tabs?.[0];
      else initial = await chrome.tabs.create({ url: 'about:blank', active: manual });
      // Windows/Linux start with Chrome's privileged new-tab page. Its target
      // cannot be attached like an ordinary document. Commit an owned inert
      // about:blank first; this performs no HTTP and leaves DNR fully strict.
      // tabs.update may acknowledge before that commit, so poll only the native
      // URL/status metadata under the original lease, never page code/selectors.
      if (initial.url !== 'about:blank') initial = await chrome.tabs.update(initial.id, { url: 'about:blank' });
      const blankUntil = Math.min(Date.now() + 8000, config.deadlineAt);
      while ((initial.status === 'loading' || initial.url !== 'about:blank') && Date.now() < blankUntil) { await pause(100); initial = await chrome.tabs.get(initial.id); }
      if (initial.url !== 'about:blank' || initial.status === 'loading') throw Error('document_blocked');
      await attach(initial.id);
      initial = await chrome.tabs.update(initial.id, { url: allowedNavigation(config.initialUrl) });
      // Manual setup must not announce its window before the first document has
      // loaded: a fast ready/close otherwise snapshots an unopened login page.
      // Read only browser tab metadata, under the original absolute deadline.
      const initialUntil = Math.min(Date.now() + 8000, config.deadlineAt);
      while (initial?.status === 'loading' && Date.now() < initialUntil) { await pause(100); initial = await chrome.tabs.get(initial.id); }
      await refreshAuth();
      activeStartup();
      bootstrapState = 'ready'; send({ kind: 'hello', version: 1 });
    } catch {
      bootstrapState = 'failed'; send({ kind: 'bootstrap_failed', stage: bootstrapStage });
    }
  })();
}
