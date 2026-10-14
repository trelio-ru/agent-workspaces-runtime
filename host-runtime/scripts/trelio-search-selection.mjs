import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// Selection is semantic; transferring its already returned locator is not.
// These refs are process-local correlations, not capabilities. Every eventual
// read still executes its live company/object ACL and accepted-head guards.
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => { throw Object.assign(new Error("Search selection is unavailable or does not match this route. Repeat the search and select again, or supply the complete explicit locator."),
  { code: "LOCAL_CONTEXT_SELECTION_STALE" }); };

export const createLocalSearchSelections = ({ now = Date.now, maximumEntries = 256, ttlMs = 600000 } = {}) => {
  const entries = new Map();
  const remove = key => { clearTimeout(entries.get(key)?.timer); entries.delete(key); };
  const prune = () => {
    for (const [key, entry] of entries) if (entry.expiresAt <= now()) remove(key);
  };
  const add = ({ origin, companySlug, nativeTool, arguments: args }) => {
    prune();
    const selectionRef = crypto.randomUUID();
    const entry = { origin, companySlug, nativeTool, arguments: structuredClone(args), expiresAt: now() + ttlMs };
    entries.set(selectionRef, entry);
    // Hard retention also applies to an idle MCP process. No background sync
    // or persistence is needed; this timer only releases its own RAM entry.
    entry.timer = setTimeout(() => remove(selectionRef), ttlMs);
    entry.timer.unref();
    while (entries.size > maximumEntries) remove(entries.keys().next().value);
    return selectionRef;
  };
  const resolve = (origin, input) => {
    if (input?.parameters?.selectedResultRef === undefined) return input;
    prune();
    const p = input.parameters;
    const entry = entries.get(p.selectedResultRef);
    const extras = record(p.arguments) ? Object.fromEntries(Object.entries(p.arguments).filter(([key]) =>
      !Object.hasOwn(entry?.arguments ?? {}, key))) : {};
    const allowedExtra = (key, value) => key === "responseDetail" && entry?.nativeTool === "fetch" && ["compact", "full"].includes(value)
      || key === "delivery" && entry?.nativeTool === "get_agent_workspace_file" && ["text", "local-file"].includes(value)
      || key === "knownInstructionRevisionKey" && entry?.nativeTool === "fetch" && typeof value === "string" && value.length <= 256;
    if (!entry || input.route !== "context" || p.operation !== "native_read"
      || entry.origin !== origin || entry.companySlug !== p.companySlug || entry.nativeTool !== p.nativeTool
      || p.nativeCallRef !== undefined || p.nativeArgumentKeys !== undefined
      || !record(p.arguments) || Object.keys(p.arguments).some(key =>
        Object.hasOwn(entry.arguments, key) ? !isDeepStrictEqual(p.arguments[key], entry.arguments[key])
          : !allowedExtra(key, p.arguments[key]))) fail();
    // Omit ref before ordinary native schema validation. Never merge authored
    // locators over the selected result, silently change a head, or refresh it.
    const { selectedResultRef: _ref, ...parameters } = p;
    return { ...input, parameters: { ...parameters, arguments: { ...entry.arguments, ...extras } } };
  };
  return { add, resolve };
};

export const localSearchSelections = createLocalSearchSelections();

export const selectedSearchLocator = (result, nativeTool) => {
  if (!record(result)) return null;
  if (nativeTool === "fetch") {
    // Secrets have a separate exact read/ACL contract. Do not manufacture fetch
    // continuations for their metadata merely because the result has an id.
    if (["agent-secret", "agent_secret", "secret"].includes(result.type)) return null;
    return typeof result.id === "string" && result.id.length <= 8192 ? { id: result.id } : null;
  }
  const { workspaceId, workspaceHead, filePath } = result;
  return typeof workspaceId === "string" && /^[0-9a-f-]{36}$/iu.test(workspaceId)
    && typeof workspaceHead === "string" && /^[0-9a-f]{40,64}$/u.test(workspaceHead)
    && typeof filePath === "string" && filePath.length > 0 && filePath.length <= 2048
    ? { workspaceId, workspaceHead, filePath } : null;
};
