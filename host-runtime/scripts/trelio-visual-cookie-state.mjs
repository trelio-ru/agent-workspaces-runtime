/** Fixed private authentication-state helper, shared by host and its extension.
 * It is materialized with the worker, never supplied by a provider/model. The
 * public visual protocol has no cookie operation or cookie-valued field. */
export function visualCookieState(config) {
  const maximumBytes = 1024 * 1024;
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(key => keys.includes(key));
  const invalid = () => Object.assign(new Error('VISUAL_STORAGE_CORRUPT'), { code: 'VISUAL_STORAGE_CORRUPT' });
  const allowedDomain = domain => {
    if (typeof domain !== 'string') return false;
    const host = domain.replace(/^\./u, '').toLowerCase();
    if (!host || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(host)) return false;
    return config.origins.some(origin => new URL(origin).hostname === host)
      || config.domains.some(name => host === name || host.endsWith('.' + name));
  };
  function record(cookie) {
    if (!exact(cookie, ['name', 'value', 'domain', 'path', 'hostOnly', 'httpOnly', 'secure', 'sameSite', 'partitionKey'])
      || typeof cookie.name !== 'string' || cookie.name.length > 4096
      || typeof cookie.value !== 'string' || cookie.value.length > 8192 || !allowedDomain(cookie.domain)
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 2048 || /[\u0000-\u001f\u007f]/u.test(cookie.path)
      || ['hostOnly', 'httpOnly', 'secure'].some(key => typeof cookie[key] !== 'boolean')
      || !['no_restriction', 'lax', 'strict', 'unspecified'].includes(cookie.sameSite)) throw invalid();
    if (cookie.partitionKey !== undefined) {
      const p = cookie.partitionKey;
      if (!exact(p, ['topLevelSite', 'hasCrossSiteAncestor']) || typeof p.topLevelSite !== 'string'
        || (p.hasCrossSiteAncestor !== undefined && typeof p.hasCrossSiteAncestor !== 'boolean')) throw invalid();
      let site; try { site = new URL(p.topLevelSite); } catch { throw invalid(); }
      if (site.origin !== p.topLevelSite || site.username || site.password || (site.protocol !== 'https:' && !(site.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(site.hostname)))) throw invalid();
    }
    return JSON.parse(JSON.stringify(cookie));
  }
  const key = cookie => JSON.stringify([cookie.domain.toLowerCase(), cookie.path, cookie.name, cookie.partitionKey?.topLevelSite ?? null, cookie.partitionKey?.hasCrossSiteAncestor ?? null]);
  function validate(values) {
    if (!Array.isArray(values) || values.length > 1024 || new TextEncoder().encode(JSON.stringify(values)).length > maximumBytes) throw invalid();
    const result = values.map(record), seen = new Set();
    for (const cookie of result) { const id = key(cookie); if (seen.has(id)) throw invalid(); seen.add(id); }
    return result;
  }
  function fromChrome(cookie) {
    // Transport permission is not auth authority: discard localhost/other
    // cookies unless the signed navigation scope itself includes that host.
    if (!cookie.session || !allowedDomain(cookie.domain) || (cookie.storeId && cookie.storeId !== '0')) return null;
    const result = {};
    for (const name of ['name', 'value', 'domain', 'path', 'hostOnly', 'httpOnly', 'secure', 'sameSite', 'partitionKey']) if (cookie[name] !== undefined) result[name] = cookie[name];
    return record(result);
  }
  function forChrome(cookie) {
    const value = record(cookie), host = value.domain.replace(/^\./u, '');
    const origin = config.origins.find(candidate => new URL(candidate).hostname === host);
    // A declared domain scope can include its subdomains. An exact origin
    // alone never grants its parent domain; record() already checked this.
    // This URL is used by the local Cookie API only and never navigates a page.
    const url = new URL(origin || `https://${host}`); url.hostname = host; url.pathname = value.path; url.search = ''; url.hash = '';
    return { url: url.href, name: value.name, value: value.value, path: value.path, secure: value.secure, httpOnly: value.httpOnly, sameSite: value.sameSite,
      ...(!value.hostOnly ? { domain: value.domain } : {}), ...(value.partitionKey ? { partitionKey: value.partitionKey } : {}),
    };
  }
  return { validate, fromChrome, forChrome, key };
}
