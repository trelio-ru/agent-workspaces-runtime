const fault = code => Object.assign(new Error(code), { code });
const sourcePath = /\.(?:js|mjs|css|json|map|xml|txt|pdf|wasm|zip|exe|dmg)$/iu;

export function createVisualOriginPolicy({ origins, domains = [], allowLoopback = false }) {
  if (!Array.isArray(origins) || !origins.length || origins.length > 16 || !Array.isArray(domains) || domains.length > 8) throw fault('invalid_input');
  const exact = new Set(origins.map(value => {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw fault('invalid_input');
    return value;
  }));
  if (domains.some(value => !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(value))) throw fault('invalid_input');
  const allowsOrigin = raw => {
    try { const url = new URL(raw); return exact.has(url.origin) || (url.protocol === 'https:' && !url.port && domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))); }
    catch { return false; }
  };
  return Object.freeze({
    fixtureOnly: allowLoopback && domains.length === 0 && [...exact].every(value => new URL(value).hostname === '127.0.0.1'),
    allowsOrigin,
    allowsCookie(domain) { const host = domain.replace(/^\./u, ''); return domains.some(root => host === root || host.endsWith(`.${root}`)) || [...exact].some(value => new URL(value).hostname === host); },
    navigate(raw) {
      try {
        const url = new URL(raw);
        if (!allowsOrigin(raw) || url.username || url.password || sourcePath.test(decodeURIComponent(url.pathname))) throw fault('navigation_blocked');
        return url.href;
      } catch { throw fault('navigation_blocked'); }
    },
  });
}
