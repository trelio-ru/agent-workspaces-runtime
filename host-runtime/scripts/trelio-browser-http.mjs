/** Safe HTTP evidence for browser adapters; never exports a response or URL. */
export const safeHttpFailure = (value) => {
  if (!value || !Number.isInteger(value.httpStatus) || value.httpStatus < 400 || value.httpStatus > 599
    || typeof value.origin !== "string" || value.origin.length > 253) return {};
  try {
    const url = new URL(value.origin);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.origin !== value.origin) return {};
    return { httpStatus: value.httpStatus, origin: url.origin };
  } catch { return {}; }
};

// Hash changes in a SPA do not load another document. Paths and queries remain
// exact in RAM so a failed callback cannot be attributed to a different page.
const documentUrl = (value) => { const url = new URL(value); url.hash = ""; return url.href; };
const mainPage = (request) => {
  if (!request.isNavigationRequest() || request.resourceType() !== "document") return null;
  const frame = request.frame(); const page = frame.page();
  return frame === page.mainFrame() ? page : null;
};

export const createDocumentHttpObserver = (context, { isAllowedUrl, ignoreStatus = () => false }) => {
  if (typeof isAllowedUrl !== "function" || typeof ignoreStatus !== "function") throw new TypeError("Provider HTTP policy is required.");
  const states = new WeakMap(); let disposed = false;
  // Every new main-document request clears the previous result, even for the
  // same URL. Identity also rejects a late response from an older navigation.
  // XHR, subframes, other pages and network failures cannot supply HTTP proof.
  const onRequest = (request) => {
    try { const page = mainPage(request); if (page) states.set(page, { request }); } catch { /* A detached frame supplies no evidence. */ }
  };
  const onResponse = (response) => {
    try {
      const request = response.request(); const page = mainPage(request);
      const state = page && states.get(page);
      if (!state || state.request !== request) return;
      const url = response.url(); const status = response.status();
      const failure = safeHttpFailure({ httpStatus: status, origin: new URL(url).origin });
      if (!failure.httpStatus || !isAllowedUrl(url) || ignoreStatus(status, url, page)) return;
      state.url = documentUrl(url); state.failure = Object.freeze(failure);
    } catch { /* Never surface raw response/URL/exception from this observer. */ }
  };
  context.on("request", onRequest); context.on("response", onResponse);
  return Object.freeze({
    failure(page) {
      if (disposed) return null;
      try {
        const state = states.get(page);
        return !page.isClosed() && state?.failure && state.url === documentUrl(page.url())
          ? { ...state.failure } : null;
      } catch { return null; }
    },
    dispose() { disposed = true; context.off("request", onRequest); context.off("response", onResponse); },
  });
};
