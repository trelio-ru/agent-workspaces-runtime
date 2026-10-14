import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import path from "node:path";

/** Per-response reads stay within the selected company. A bounded local binding
 * chooses only a slug; the server still authenticates the actor and checks ACL.
 * Titles/rules/files are never fetched and neither queue nor content is cached. */
const SLUG = /^[a-z0-9_-]{1,120}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const START = "<!-- trelio-agent-workspaces:start -->";
const END = "<!-- trelio-agent-workspaces:end -->";
const MAXIMUM_BINDING_BYTES = 64 * 1024;
export const UNFILED_QUEUE_UNAVAILABLE_NOTICE = "Очередь «Неразобранные» не проверена: не удалось получить актуальные данные. Повторю проверку при следующем ответе.";

// Symlinks and oversized input cannot silently select another company. The
// descriptor is checked after open as well; a replaced path is never trusted.
const readBindingFile = async filename => {
  let handle;
  try {
    const before = await lstat(filename);
    if (!before.isFile() || before.size > MAXIMUM_BINDING_BYTES) throw new Error("UNFILED_BINDING_INVALID");
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || after.size > MAXIMUM_BINDING_BYTES || before.ino !== after.ino || before.dev !== after.dev) throw new Error("UNFILED_BINDING_INVALID");
    const bytes = Buffer.alloc(MAXIMUM_BINDING_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAXIMUM_BINDING_BYTES) throw new Error("UNFILED_BINDING_INVALID");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close(); }
};

export const readUnfiledCompanyBinding = async cwd => {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  let directory = path.resolve(cwd);
  // A Run's workspace/ and context/ are children of its exact metadata root;
  // an onboarded root is at most two more ancestors. Do not scan home/history.
  for (let depth = 0; depth <= 4; depth++) {
    const runText = await readBindingFile(path.join(directory, ".trelio-run.json"));
    if (runText !== null) {
      const run = JSON.parse(runText);
      if (!SLUG.test(run.company?.slug ?? "")) throw new Error("UNFILED_BINDING_INVALID");
      return { companySlug: run.company.slug };
    }
    const text = await readBindingFile(path.join(directory, "AGENTS.md"));
    if (text !== null && (text.includes(START) || text.includes(END))) {
      const start = text.indexOf(START), end = text.indexOf(END);
      if (start < 0 || end < start || text.indexOf(START, start + START.length) !== -1 || text.indexOf(END, end + END.length) !== -1) throw new Error("UNFILED_BINDING_INVALID");
      const block = text.slice(start + START.length, end);
      // Only the canonical managed scope sentence is authoritative, never a
      // name/slug mentioned in ordinary instructions or the folder's basename.
      const matches = [...block.matchAll(/^Папка привязана к компании «.+» \(`([a-z0-9_-]+)`\)\. Это контекст работы, а не привязка Git-репозитория\.$/gmu)];
      if (matches.length !== 1 || [...block.matchAll(/^Папка привязана к компании /gmu)].length !== 1 || !SLUG.test(matches[0][1])) throw new Error("UNFILED_BINDING_INVALID");
      return { companySlug: matches[0][1] };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
};

export const buildUnfiledQueueResponseSuffix = (queue, { origin, companySlug }) => {
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !SLUG.test(companySlug ?? "") || queue?.schemaVersion !== 1 || queue.companySlug !== companySlug || !Number.isSafeInteger(queue.count)
    || queue.count < 0 || !Array.isArray(queue.workspaces) || queue.workspaces.length > 20
    || queue.workspaces.length > queue.count || (queue.count > 0 && queue.workspaces.length === 0)
    || typeof queue.timeZone !== "string" || !queue.timeZone || queue.timeZone.length > 80
    || new Set(queue.workspaces.map(item => item.id)).size !== queue.workspaces.length) throw new Error("UNFILED_QUEUE_INVALID");
  const formatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: queue.timeZone });
  for (const item of queue.workspaces) {
    if (!UUID.test(item.id ?? "") || !Number.isFinite(Date.parse(item.expiresAt))) throw new Error("UNFILED_QUEUE_INVALID");
  }
  if (!queue.count) return null;
  const selected = [...queue.workspaces].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.id.localeCompare(b.id))[0];
  const date = formatter.format(new Date(selected.expiresAt));
  const url = new URL(`/${encodeURIComponent(companySlug)}/workspaces/catalog/${selected.id}/`, base.origin).toString();
  return `Неразобранные: ${queue.count}. Для [этого воркспейса](${url}) укажите проект или «удалить». Автоудаление – ${date}`;
};

export const runUnfiledQueueHook = async (input, { origin = process.env.TRELIO_WORKSPACE_ORIGIN || "https://trelio.ru", readBinding = readUnfiledCompanyBinding, readQueue, bridge, signal } = {}) => {
  let suffix;
  try {
    const binding = await readBinding(input.cwd);
    if (!binding) return {}; // No selected company means no queue obligation.
    if (!SLUG.test(binding.companySlug ?? "")) throw new Error("UNFILED_BINDING_INVALID");
    let queue;
    if (readQueue) queue = await readQueue(binding.companySlug);
    else {
      const runtime = bridge ?? await import("./trelio-workspace.mjs");
      const token = await runtime.readExistingBridgeSessionToken(origin, { signal });
      // Installation alone must not start pairing, repair credentials or inject
      // setup prompts. This read never supplies admission proof for a mutation.
      if (!token) return {};
      const query = new URLSearchParams({ companySlug: binding.companySlug });
      const response = await runtime.request(origin, token, `/api/agent-workspaces/unfiled-queue?${query}`, { signal, maximumErrorResponseBytes: 64 * 1024 });
      queue = JSON.parse((await runtime.readBoundedResponseBuffer(response, 64 * 1024, "Unfiled queue")).toString("utf8"));
    }
    suffix = buildUnfiledQueueResponseSuffix(queue, { origin, companySlug: binding.companySlug });
  } catch {
    suffix = UNFILED_QUEUE_UNAVAILABLE_NOTICE; // Failure never means an empty queue.
  }
  if (!suffix) {
    // The queue may empty after prompt injection. Empty ordinary turns stay
    // silent; only an actual stale footer needs correction (not quoted examples).
    if (input.hook_event_name === "Stop" && typeof input.last_assistant_message === "string"
      && /Неразобранные: [1-9]\d*\. Для \[этого воркспейса\]\([^\n]+\) укажите проект или «удалить»\. Автоудаление – \d{2}\.\d{2}\.\d{2}$/u.test(input.last_assistant_message.trimEnd())) {
      return { decision: "block", reason: "Очередь «Неразобранные» теперь пуста. Уберите устаревшее напоминание; завершённую работу не повторяйте." };
    }
    return {};
  }
  if (input.hook_event_name === "UserPromptSubmit") return {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext:
      `Include the current company’s personal unfiled queue reminder in the final response. A project/deletion reply resolves the exact Workspace asked about previously, not an implicit batch or a newer queue item. Required reminder: ${suffix}` },
  };
  if (input.hook_event_name === "Stop") {
    if (typeof input.last_assistant_message === "string" && input.last_assistant_message.includes(suffix)) return {};
    // Older clients may omit the response field. Prompt once, then allow their
    // continuation without pretending it was verified or creating an endless loop.
    if (input.stop_hook_active && typeof input.last_assistant_message !== "string") return {};
    return { decision: "block", reason: `Add the current reminder without redoing completed work: ${suffix}` };
  }
  return {};
};
