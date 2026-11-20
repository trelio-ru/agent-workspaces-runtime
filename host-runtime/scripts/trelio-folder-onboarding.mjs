import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sameLocalPath } from "./trelio-local-path.mjs";
import { CODEX_TRELIO_DIRECT_TOOL_INSTRUCTIONS } from "./trelio-codex-routing.mjs";

import {
  GIT_DISABLED_GLOBAL_CONFIG_PATH,
  GIT_DISABLED_HOOKS_PATH,
  resolveGitExecutable,
} from "./trelio-git.mjs";

const execFileAsync = promisify(execFile);

export const TRELIO_FOLDER_ONBOARDING_OPERATION = "folder_onboarding_apply";
export const TRELIO_FOLDER_ONBOARDING_SCHEMA_VERSION = 1;

const MAX_PATH_LENGTH = 4096;
const MAX_NAME_LENGTH = 200;
const MAX_SLUG_LENGTH = 120;
const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;
const INSTRUCTION_FILES = new Set(["AGENTS.md", "AGENTS.override.md"]);
const BINDING_CLIENTS = new Set(["codex", "claude-code", "cursor", "antigravity", "deepseek-harness", "kimi-work", "multitool"]);
// Share exact membership with the local action dispatcher so a reviewed plan
// cannot be rejected by a second, stale client list before reaching the writer.
// Keep the Set private: callers may check instruction-format support, never
// mutate it or treat this predicate as OAuth/runtime-policy admission.
export const isTrelioFolderOnboardingClient = (value) => BINDING_CLIENTS.has(value);
const ROOT_ALLOWED_FILES = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  ".gitignore",
]);
const CODEX_ATTACHMENT_DIRECTORY = ".codex-remote-attachments";
const CODEX_CONFIG_DIRECTORY = ".codex";
const MANAGED_START = "<!-- trelio-agent-workspaces:start -->";
const MANAGED_END = "<!-- trelio-agent-workspaces:end -->";
const IGNORE_START = "# trelio-agent-workspaces:ignore:start";
const IGNORE_END = "# trelio-agent-workspaces:ignore:end";
const IGNORE_BLOCK = [IGNORE_START, "/workspaces/", IGNORE_END].join("\n");
// Codex checkpoint scope/turn identifiers use either two 32-hex segments or
// two 64-hex segments. They are not the Git object ID stored in the ref. Match
// only these complete known pairs: a width range or independent alternatives
// would silently admit unobserved layouts. Object type, tree contents and the
// complete object inventory are still checked separately in inspectServiceGit.
const CODEX_CHECKPOINT_REF = /^refs\/codex\/turn-diffs\/checkpoints\/(?:[0-9a-f]{32}\/[0-9a-f]{32}|[0-9a-f]{64}\/[0-9a-f]{64})\/[1-9][0-9]*\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODEX_CAPTURE_REF = /^refs\/codex\/turn-diffs\/captures\/[1-9][0-9]*\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:base|head)$/u;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
// Git hashes the object header and payload together. The canonical empty tree
// has only this header and cannot reference a file, directory or Git object.
const EMPTY_TREE_IDS = new Set(["sha1", "sha256"].map((algorithm) => (
  createHash(algorithm).update("tree 0\0").digest("hex")
)));
const ALLOWED_LOCAL_CONFIG_KEYS = new Set([
  "core.bare",
  "core.filemode",
  "core.ignorecase",
  "core.logallrefupdates",
  "core.precomposeunicode",
  "core.repositoryformatversion",
  // Git init can write this after probing symlink support (notably on
  // Windows). It does not relax the separate filesystem/tree symlink guards.
  "core.symlinks",
]);
const UNFINISHED_GIT_PATHS = [
  "BISECT_LOG",
  "CHERRY_PICK_HEAD",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "REVERT_HEAD",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
];

export class TrelioFolderOnboardingError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "TrelioFolderOnboardingError";
    this.code = code;
    this.details = details;
  }
}

const GIT_HISTORY_CODE = "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT";
const GIT_BLOCKER_MESSAGES = Object.freeze({
  commit_history: "В папке уже есть история коммитов Git.",
  remotes_or_index: "В репозитории настроен удалённый репозиторий или в индексе Git есть файлы.",
  unexpected_ref: "В репозитории есть ссылка Git, которая не соответствует служебным ссылкам Codex.",
  unexpected_tree_entry: "Дерево снимка Codex содержит запись, которую Trelio не может безопасно использовать.",
  commit_or_tag_object: "В репозитории найден объект коммита или тега Git.",
  malformed_inventory_entry: "Git вернул запись об объекте, которую не удалось проверить.",
  orphan_tree: "Найденное дерево Git недостижимо из допустимых служебных снимков Codex.",
  orphan_blob: "Найденный объект Git недостижим по разрешённым путям в служебных снимках Codex.",
  workspace_index: "Не удалось подтвердить, что рабочие материалы Trelio отсутствуют в индексе Git.",
});
const GIT_RECOVERY_MESSAGE = "Автоматического восстановления для этой папки нет. Чтобы сохранить исходную папку и её историю, оставьте её в Codex и подключите Trelio в отдельной папке вне Git-репозиториев.";

class FolderGitHistoryError extends TrelioFolderOnboardingError {
  #blocker;

  constructor(reason, message, objectType, objectId) {
    super(GIT_HISTORY_CODE, message);
    this.#blocker = { reason };
    // Report one validated Git object ID, never an inventory, ref name or path.
    // A root path, a branch name and even tree-entry metadata can be private.
    if (["tree", "blob", "commit", "tag"].includes(objectType)
      && typeof objectId === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)) {
      this.#blocker.object = { type: objectType, id: objectId };
    }
  }

  toBlockerPayload() {
    const { reason, object } = this.#blocker;
    return {
      code: GIT_HISTORY_CODE,
      message: [
        GIT_BLOCKER_MESSAGES[reason],
        object && `Объект Git ${object.type} ${object.id}.`,
        GIT_RECOVERY_MESSAGE,
      ].filter(Boolean).join(" "),
      details: {
        gitBlocker: { reason, ...(object ? { object: { ...object } } : {}) },
        recovery: { action: "select_separate_folder", sameFolderSupported: false },
      },
    };
  }
}

// Only the actual classifier can provide a blocker. Never forward arbitrary
// exception detail fields across the MCP or wizard boundary.
export const projectFolderGitHistoryBlocker = (error) => (
  error instanceof FolderGitHistoryError ? error.toBlockerPayload() : null
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const normalizeAbsoluteFolder = (value) => {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_LENGTH
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      "folderPath must be one bounded absolute path selected by the client.",
    );
  }
  return path.resolve(value);
};

const normalizeSingleLine = (value, fieldName, maximumLength) => {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || /[\0\r\n]/u.test(value)
  ) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      `${fieldName} must be one non-empty bounded line.`,
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      `${fieldName} must not contain whitespace only.`,
    );
  }
  return normalized;
};

const normalizeSlug = (value, fieldName) => {
  const slug = normalizeSingleLine(value, fieldName, MAX_SLUG_LENGTH);
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(slug)) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      `${fieldName} has an unsupported format.`,
    );
  }
  return slug;
};

// Display names are server data, not Markdown authority. Escaping punctuation
// prevents a company or project label from changing the managed block shape.
const escapeMarkdownInline = (value) => value.replace(/[\\`*_<>]/gu, "\\$&");

const normalizeBinding = (rawInput) => {
  if (rawInput?.project && !rawInput?.company) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      "project requires an exact company binding.",
    );
  }
  if (!rawInput?.company) return null;
  const company = {
    name: escapeMarkdownInline(normalizeSingleLine(
      rawInput.company.name,
      "company.name",
      MAX_NAME_LENGTH,
    )),
    slug: normalizeSlug(rawInput.company.slug, "company.slug"),
  };
  const hasProject = rawInput.project !== undefined && rawInput.project !== null;
  const project = hasProject ? {
    name: escapeMarkdownInline(normalizeSingleLine(
      rawInput.project.name,
      "project.name",
      MAX_NAME_LENGTH,
    )),
    slug: normalizeSlug(rawInput.project.slug, "project.slug"),
  } : null;
  return { company, project };
};

const normalizeInstructionTarget = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (!INSTRUCTION_FILES.has(value)) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      "instructionTarget must be AGENTS.md or AGENTS.override.md.",
    );
  }
  return value;
};

const runGit = async (gitPath, argumentsList, cwd, execFileCommand = execFileAsync) => {
  try {
    const result = await execFileCommand(
      gitPath,
      [
        "-c",
        `core.hooksPath=${GIT_DISABLED_HOOKS_PATH}`,
        "-c",
        "core.longpaths=true",
        ...argumentsList,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: GIT_DISABLED_GLOBAL_CONFIG_PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    // These calls inspect metadata, not progress-producing Git mutations.
    // Git can exit successfully while omitting broken refs and warning on
    // stderr. Treat any diagnostic as an incomplete read, regardless of its
    // language, instead of interpreting the remaining stdout as a full list.
    const stderr = result.stderr || "";
    if (stderr.trim()) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
        "Git metadata inspection returned diagnostics; onboarding stopped without changing files.",
      );
    }
    return { ok: true, stdout: result.stdout || "", stderr };
  } catch (error) {
    // A diagnostic from a successful read must not become the expected
    // non-repository/unborn-HEAD failure used by classification branches.
    if (error instanceof TrelioFolderOnboardingError) throw error;
    return {
      ok: false,
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      code: error?.code ?? null,
    };
  }
};

const inspectOptionalRegularFile = async (filesystem, filePath) => {
  let stat;
  try {
    stat = await filesystem.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, text: "", sha256: null, mode: 0o600 };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_UNSAFE_FILE",
      `${path.basename(filePath)} must be an ordinary file, not a symlink or special entry.`,
    );
  }
  if (stat.size > MAX_INSTRUCTION_FILE_BYTES) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_FILE_TOO_LARGE",
      `${path.basename(filePath)} exceeds the onboarding size limit.`,
    );
  }
  const bytes = await filesystem.readFile(filePath);
  return {
    exists: true,
    text: bytes.toString("utf8"),
    sha256: sha256(bytes),
    mode: stat.mode & 0o777,
  };
};

const findMarkerRanges = (text, startMarker, endMarker) => {
  const starts = [];
  const ends = [];
  let index = -1;
  while ((index = text.indexOf(startMarker, index + 1)) >= 0) starts.push(index);
  index = -1;
  while ((index = text.indexOf(endMarker, index + 1)) >= 0) ends.push(index);
  if (starts.length === 0 && ends.length === 0) return [];
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_AMBIGUOUS_MARKERS",
      `Managed markers ${startMarker} / ${endMarker} are incomplete, repeated or reordered.`,
    );
  }
  return [{
    start: starts[0],
    end: ends[0] + endMarker.length,
  }];
};

const appendBlock = (text, block) => {
  const normalized = text.replace(/[ \t]+$/gmu, "").replace(/\s*$/u, "");
  return normalized ? `${normalized}\n\n${block}\n` : `${block}\n`;
};

const replaceManagedBlockAtEnd = (text, block, startMarker, endMarker) => {
  const ranges = findMarkerRanges(text, startMarker, endMarker);
  if (ranges.length === 0) return appendBlock(text, block);
  const range = ranges[0];
  const without = `${text.slice(0, range.start)}${text.slice(range.end)}`;
  return appendBlock(without, block);
};

// Diagnostics refresh an existing binding, not a newly selected scope. Parse
// only explicit scope lines inside one complete managed block; arbitrary user
// instructions, folder names and similar slugs cannot select a company.
export const readManagedBinding = (text) => {
  const ranges = findMarkerRanges(text, MANAGED_START, MANAGED_END);
  if (ranges.length === 0) return null;
  // Normalize CRLF for parsing only. CAS and the refresh writer still use the
  // original snapshot, preserving every personal byte outside the block.
  const block = text.slice(ranges[0].start, ranges[0].end).replaceAll("\r\n", "\n");
  const companyLines = [...block.matchAll(/^Папка привязана к компании «(.+)» \(`([a-z0-9_-]+)`\)\. Это контекст работы, а не привязка Git-репозитория\.$/gmu)];
  // Legacy registry: folder-managed-binding-sentences. These exact published
  // pre-runtime templates contain the same explicit company slug. Read them
  // through the ordinary same-scope refresh; do not infer a scope from prose.
  const legacyCompanyLines = [
    ...block.matchAll(/^Эта обычная локальная папка задаёт Trelio-контекст компании «(.+)»(?:\n| )\(`([a-z0-9_-]+)`\) и не связывает с Trelio Git-репозиторий\.$/gmu),
    ...block.matchAll(/^Эта рабочая папка связана с компанией Trelio «(.+)» \(`([a-z0-9_-]+)`\)\.$/gmu),
  ];
  const allCompanyLines = [...companyLines, ...legacyCompanyLines];
  const projectLines = [...block.matchAll(/^Работа ограничена проектом «(.+)» \(`([a-z0-9_-]+)`\)\.$/gmu)];
  // A malformed project line must never silently widen a project binding to
  // company scope. Count the recognized prefixes as well as exact valid lines.
  // Recognize the declaration prefix even when its separator is damaged.
  // Otherwise a missing space before «project» could silently remove the
  // project restriction while leaving a valid company line behind.
  const companyPrefixes = [...block.matchAll(/^[\t ]*(?:Папка привязана к компании|Эта обычная локальная папка задаёт Trelio-контекст компании|Эта рабочая папка связана с компанией Trelio)/gmu)];
  const projectPrefixes = [...block.matchAll(/^[\t ]*Работа ограничена проектом/gmu)];
  if (allCompanyLines.length !== 1 || companyPrefixes.length !== allCompanyLines.length
    || projectLines.length > 1 || projectPrefixes.length !== projectLines.length) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_BINDING_AMBIGUOUS",
      "The managed instruction block has no unambiguous canonical company/project binding.",
    );
  }
  const decodeName = (value) => value.replace(/\\([\\`*_<>])/gu, "$1");
  return {
    company: { name: decodeName(allCompanyLines[0][1]), slug: allCompanyLines[0][2] },
    ...(projectLines.length ? {
      project: { name: decodeName(projectLines[0][1]), slug: projectLines[0][2] },
    } : {}),
  };
};

const replaceExistingManagedBlock = (text, block) => {
  const [range] = findMarkerRanges(text, MANAGED_START, MANAGED_END);
  if (!range) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_BINDING_REQUIRED",
      "Instruction refresh requires an existing managed Trelio binding.",
    );
  }
  // Preserve every byte outside the managed range, including user whitespace
  // and rules after the block. Ordinary onboarding retains its existing layout.
  return `${text.slice(0, range.start)}${block}${text.slice(range.end)}`;
};

const buildManagedBindingBlock = ({ company, project }) => {
  const lines = [
    MANAGED_START,
    "## Trelio",
    "",
    `Папка привязана к компании «${company.name}» (\`${company.slug}\`). Это контекст работы, а не привязка Git-репозитория.`,
    "",
  ];
  if (project) {
    lines.push(
      `Работа ограничена проектом «${project.name}» (\`${project.slug}\`).`,
      "",
    );
  }
  lines.push(
    "Не создавай рабочие материалы, `tmp/` или `output/` в корне этой папки. Для записи или редактирования материалов открой Agent Run и работай только в пути, который вернул bridge. Для новой папки в Трелио bridge создаёт локальный каталог `workspaces/<workspace-id>/`; внутри `workspace/` лежат редактируемые файлы, а `context/` и `.trelio-run.json` остаются служебными.",
    "Для bridge action `open` передай эту выбранную клиентом папку в `workingDirectory`; остальные returned arguments сохрани. Не подставляй cwd процесса MCP, каталог плагина или home.",
    "",
    "Если в корне осталась служебная `.git` клиента, сохраняй её и корневое исключение `/workspaces/` в `.gitignore`. Не выполняй Git add/commit/push из корня и не добавляй туда remote. Git-операции Trelio выполняются только в локальной папке, которую выдал bridge.",
    "",
    CODEX_TRELIO_DIRECT_TOOL_INSTRUCTIONS,
    // Keep one shared template across clients: a Kimi refresh must not remove
    // Codex guidance or make another client rewrite the same managed block.
    "Kimi Work: вызывай инструменты из MCP-каталога, без `system.invoke`. Если удалённого инструмента в чате нет, используй `trelio_find_tools` для его точной схемы и `trelio_call_tool` для вызова. Существующий OAuth переиспользуй. Возвращённые локальные действия выполняй через указанные MCP server/tool; если указан `nativeArgumentsTarget`, заполни только этот слот исходными аргументами.",
    "",
    "Мультитул: используй MCP-сервер Trelio и действующий OAuth. Если нужный удалённый инструмент не виден, получи его точную схему через `trelio_find_tools` и вызови через `trelio_call_tool`. Локальные действия выполняй через возвращённые MCP server/tool и аргументы. После `open` или `inspect` прочитай оба файла из `authorityReadPlan` по порядку до EOF. Если план недоступен или один из файлов не удалось прочитать полностью, останови работу с папкой и укажи причину.",
    "",
    "По запросу диагностики Trelio сначала вызови diagnose_trelio_installation с intent=diagnostics, реальным clientKind и текущей выбранной клиентом папкой в folderOnboarding.folderPath. Следуй возвращённому плану; не создавай учебные задачи или Run. Обновляй только существующий managed Trelio-блок через returned refresh action, если пользователь не запретил изменения.",
    "",
    "Каждое сообщение обрабатывай в контексте Trelio. Уже загруженные в текущей сессии правила и данные используй повторно, пока тема, объект и требования к актуальности не изменились.",
    "",
    "Если нужного контекста нет:",
    "",
    "- для точной задачи вызови `get_task` и примени возвращённые правила. Если для ответа или работы нужны материалы, проверь каноническую и релевантные связанные папки этой задачи. Прочитай нужные принятые материалы до ответа и до обращения к внешним источникам. Карточка задачи не содержит этих файлов;",
    `- иначе получи правила через \`get_agent_instructions\`, затем вызови Trelio \`search\` с \`companySlugs: [\"${company.slug}\"]\`. Если поиск нашёл нужную задачу, выполни предыдущий пункт.`,
    "",
    // The same block is refreshed by every client. Keep the read/write decision
    // here so a fresh chat can choose the read path even before loading a skill.
    "Для чтения принятых материалов папки используй `prepare_agent_workspace_read` с точным ID папки или координатами её задачи и выполни возвращённый `bridge.action` на указанном локальном MCP server/tool с его аргументами. Сначала полностью прочитай `agent-instructions.md` и `user-profile.md`, затем `WORKSPACE_CONTEXT.md`, если он есть, и релевантные файлы. Чтение выполняется без Agent Run, запуска браузера и изменений снимка. Для зашифрованной компании следуй локальному маршруту, который вернул Trelio. Если подходящих материалов нет или чтение заблокировано, явно укажи это.",
    "",
    "До этой проверки не используй WebSearch, WebFetch, другие внешние источники и не отвечай по существу из собственных знаний. Если после проверки нужны данные подключённого сервиса, сначала проверь `search.guidance` в точной компании и загрузи инструкции и исполнение подходящего Agent Skill через `get_agent_skill`.",
    "",
    "Не решай самостоятельно, что запрос «нерабочий» или не требует Trelio. Пропустить проверку можно только по прямому указанию пользователя в текущем сообщении.",
    "",
    "Если Trelio недоступен, сообщи, что контекст не проверен, и не подменяй его догадками.",
    MANAGED_END,
  );
  return lines.join("\n");
};

const parseSingleServiceWorktree = (stdout, rootPath) => {
  // Git 2.28, our supported minimum, cannot emit worktree list with -z.
  // A service repository must have exactly its main worktree, whose real
  // root was already verified independently. Consume that exact path as a
  // length-delimited prefix: newlines or record-looking text in a filename
  // cannot become attributes or additional worktrees. Then validate the
  // entire remaining record; another worktree, truncation or unknown fields
  // fail closed. Do not trim paths or decode them as quoted shell strings.
  const windows = process.platform === "win32";
  const output = windows ? String(stdout || "").replaceAll("\r\n", "\n") : String(stdout || "");
  const gitPath = windows ? rootPath.replaceAll("\\", "/") : rootPath;
  const prefix = `worktree ${gitPath}\n`;
  const actualPrefix = output.slice(0, prefix.length);
  if ((windows ? actualPrefix.toLowerCase() : actualPrefix)
    !== (windows ? prefix.toLowerCase() : prefix)) return null;
  const attributes = output.slice(prefix.length);
  return /^HEAD (?:[0-9a-f]{40}|[0-9a-f]{64})\n(?:branch refs\/[^\0\s]+|detached)\n\n$/u.test(attributes)
    ? rootPath : null;
};

const readGitPathOutput = (stdout) => {
  // Remove only Git's one output terminator. trim() also removes valid path
  // bytes such as a trailing space, tab, CR or an actual newline in POSIX.
  const output = String(stdout || "");
  const terminator = process.platform === "win32" ? /\r?\n$/u : /\n$/u;
  return terminator.test(output) ? output.replace(terminator, "") : null;
};

const parseObjectInventory = (stdout) => String(stdout || "")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => {
    const [objectId, type, rawSize, extra] = line.split(" ");
    // Number() alone would coerce a missing size between spaces to zero.
    const size = extra === undefined && /^(?:0|[1-9][0-9]*)$/u.test(rawSize)
      ? Number(rawSize)
      : NaN;
    return { objectId, type, size };
  });

const isCodexMetadataDirectory = (name) => (
  name === CODEX_CONFIG_DIRECTORY || name === CODEX_ATTACHMENT_DIRECTORY
);

const isAllowedCodexMetadataEntry = (relativePath, type) => {
  if (relativePath === CODEX_CONFIG_DIRECTORY) return type === "tree";
  if (relativePath === `${CODEX_CONFIG_DIRECTORY}/config.toml`) return type === "blob";

  const [root, ...segments] = relativePath.split("/");
  if (root !== CODEX_ATTACHMENT_DIRECTORY || relativePath.length > MAX_PATH_LENGTH) return false;
  // The reserved directory is the boundary for opaque attachment files.
  // Both callers check entry types without opening the files. Validate path
  // components without making assumptions about their names or formats.
  if (segments.some((segment) => !segment || segment.startsWith(".") || /[. ]$/u.test(segment)
    || /[\x00-\x1f\x7f\\:<>"|?*\ufffd]/u.test(segment))) return false;
  return type === "tree" || (type === "blob" && segments.length > 0);
};

const inspectTree = async ({ gitPath, rootPath, treeId, objectsById, reachable, execFileCommand }) => {
  const result = await runGit(
    gitPath,
    // Include directory entries, even empty ones. Checking only the leaves
    // loses both the evidence for reachable trees and the paths of empty trees.
    ["ls-tree", "-rtz", "--full-tree", treeId],
    rootPath,
    execFileCommand,
  );
  if (!result.ok || (result.stdout && !result.stdout.endsWith("\0"))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
      "Git tree inspection failed; onboarding stopped without changing the repository.",
    );
  }
  const entries = result.stdout.split("\0").slice(0, -1);
  for (const entry of entries) {
    const fields = entry.match(/^(?<mode>[0-9]{6}) (?<type>[^ ]+) (?<object>[0-9a-f]+)\t(?<file>.+)$/su)?.groups;
    const regularBlob = fields?.mode === "100644" && fields.type === "blob";
    const directory = fields?.mode === "040000" && fields.type === "tree";
    const allowedPath = fields && (ROOT_ALLOWED_FILES.has(fields.file)
      ? regularBlob
      : isAllowedCodexMetadataEntry(fields.file, fields.type));
    if (!(regularBlob || directory) || !allowedPath) {
      throw new FolderGitHistoryError(
        "unexpected_tree_entry",
        "A Codex turn-diff tree contains a path or object outside the onboarding allowlist.",
        "tree", treeId,
      );
    }
    // ls-tree can report a blob entry whose object is missing. Require the
    // same type in the complete inventory before treating that path as proof.
    if (objectsById.get(fields.object) !== fields.type) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
        "A Codex turn-diff tree entry is missing from the complete Git object inventory or has a different type.",
      );
    }
    reachable.add(fields.object);
  }
};

const inspectServiceGit = async ({
  rootPath,
  gitPath,
  filesystem,
  execFileCommand,
}) => {
  const gitEntry = await filesystem.lstat(path.join(rootPath, ".git"));
  if (!gitEntry.isDirectory() || gitEntry.isSymbolicLink()) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
      "The selected root uses a gitfile, symlink, submodule or another unsupported .git layout.",
    );
  }

  const head = await runGit(gitPath, ["rev-parse", "--verify", "HEAD"], rootPath, execFileCommand);
  if (head.ok) {
    throw new FolderGitHistoryError(
      "commit_history",
      "The selected folder already contains Git commit history.",
      "commit", head.stdout.trim(),
    );
  }
  const bare = await runGit(gitPath, ["rev-parse", "--is-bare-repository"], rootPath, execFileCommand);
  if (!bare.ok || bare.stdout.trim() !== "false") {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
      "The selected folder is a bare or unreadable Git repository.",
    );
  }
  const remotes = await runGit(gitPath, ["remote"], rootPath, execFileCommand);
  const tracked = await runGit(gitPath, ["ls-files", "--stage", "-z"], rootPath, execFileCommand);
  const worktrees = await runGit(gitPath, ["worktree", "list", "--porcelain"], rootPath, execFileCommand);
  const localConfig = await runGit(
    gitPath,
    ["config", "--local", "--name-only", "--list"],
    rootPath,
    execFileCommand,
  );
  if (![remotes, tracked, worktrees, localConfig].every(({ ok }) => ok)) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
      "Git metadata could not be read completely.",
    );
  }
  if (remotes.stdout.trim() || tracked.stdout.length > 0) {
    throw new FolderGitHistoryError(
      "remotes_or_index",
      "The selected folder contains remotes or indexed paths.",
    );
  }
  const worktreePath = parseSingleServiceWorktree(worktrees.stdout, rootPath);
  const worktreeRealPath = worktreePath
    ? await filesystem.realpath(worktreePath).catch(() => null)
    : null;
  if (
    !worktreePath
    || !worktreeRealPath
    || !sameLocalPath(worktreeRealPath, rootPath)
  ) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
      "The selected repository has another or ambiguous worktree.",
    );
  }
  const configKeys = localConfig.stdout.split(/\r?\n/u).filter(Boolean);
  if (configKeys.some((key) => !ALLOWED_LOCAL_CONFIG_KEYS.has(key))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
      "The selected repository has non-default local Git configuration.",
    );
  }

  for (const relativePath of UNFINISHED_GIT_PATHS) {
    try {
      await filesystem.lstat(path.join(rootPath, ".git", relativePath));
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
        "The selected repository contains an unfinished Git operation.",
      );
    } catch (error) {
      if (error instanceof TrelioFolderOnboardingError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const hooksDirectory = path.join(rootPath, ".git", "hooks");
  const hooks = await filesystem.readdir(hooksDirectory, { withFileTypes: true }).catch((error) => (
    error?.code === "ENOENT" ? [] : Promise.reject(error)
  ));
  if (hooks.some((entry) => !entry.name.endsWith(".sample"))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
      "The selected repository contains custom Git hooks.",
    );
  }
  const alternates = await inspectOptionalRegularFile(
    filesystem,
    path.join(rootPath, ".git", "objects", "info", "alternates"),
  );
  if (alternates.exists && alternates.text.trim()) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
      "The selected repository uses Git object alternates.",
    );
  }

  const refs = await runGit(
    gitPath,
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)"],
    rootPath,
    execFileCommand,
  );
  if (!refs.ok) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
      "Git refs could not be read completely.",
    );
  }
  const referencedTrees = new Set();
  for (const line of refs.stdout.split(/\r?\n/u).filter(Boolean)) {
    const [refName, objectId, objectType, symref] = line.split("\0");
    if (
      !(CODEX_CHECKPOINT_REF.test(refName) || CODEX_CAPTURE_REF.test(refName))
      || objectType !== "tree"
      || symref !== ""
      || !SHA_PATTERN.test(objectId)
    ) {
      throw new FolderGitHistoryError(
        "unexpected_ref",
        "The selected repository contains a ref outside exact Codex turn-diff trees.",
        objectType, objectId,
      );
    }
    referencedTrees.add(objectId);
  }

  const inventory = await runGit(
    gitPath,
    ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    rootPath,
    execFileCommand,
  );
  if (!inventory.ok) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
      "Git object inventory could not be read completely.",
    );
  }
  const objects = parseObjectInventory(inventory.stdout);
  const unexpectedObject = objects.find(({ objectId, type, size }) => (
    !SHA_PATTERN.test(objectId)
    || !["tree", "blob"].includes(type)
    || !Number.isSafeInteger(size)
    || size < 0
  ));
  if (unexpectedObject) {
    const { objectId, type } = unexpectedObject;
    const commitOrTag = type === "commit" || type === "tag";
    throw new FolderGitHistoryError(
      commitOrTag ? "commit_or_tag_object" : "malformed_inventory_entry",
      "The selected repository contains commit, tag or malformed Git objects.",
      type, objectId,
    );
  }
  const objectsById = new Map(objects.map(({ objectId, type }) => [objectId, type]));
  if ([...referencedTrees].some((treeId) => objectsById.get(treeId) !== "tree")) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
      "A Codex turn-diff ref points outside the complete local object inventory.",
    );
  }
  const reachable = new Set(referencedTrees);
  for (const treeId of referencedTrees) {
    // Validate each root's full paths even when two roots share a subtree.
    // Reachability alone cannot authorize a subtree reused at another path.
    await inspectTree({ gitPath, rootPath, treeId, objectsById, reachable, execFileCommand });
  }
  // Git may retain the empty tree after Codex drops a snapshot ref. Accept
  // that one content-free object only when the complete inventory confirms
  // both its identity and size. Keep it out of the reachability set so this
  // exception cannot authorize an entry in a snapshot at a forbidden path.
  // Return the orphan refusal separately so a caller can preserve the binding
  // with external storage. Every other Git refusal still throws immediately.
  const orphanTree = objects.find(({ objectId, type, size }) => (
    type === "tree" && !reachable.has(objectId)
    && !(size === 0 && EMPTY_TREE_IDS.has(objectId))
  ));
  if (orphanTree) {
    return new FolderGitHistoryError(
      "orphan_tree",
      "The selected repository contains a Git tree unreachable from the validated Codex turn-diff refs.",
      "tree", orphanTree.objectId,
    );
  }
  const orphanBlob = objects.find(({ objectId, type }) => type === "blob" && !reachable.has(objectId));
  if (orphanBlob) {
    return new FolderGitHistoryError(
      "orphan_blob",
      "The selected repository contains a Git blob without a validated path in the Codex turn-diff refs.",
      "blob", orphanBlob.objectId,
    );
  }
  return null;
};

const inspectCodexMetadataDirectory = async (filesystem, rootPath, directory) => {
  const pending = [directory];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(rootPath, relativeDirectory);
    const stat = await filesystem.lstat(absoluteDirectory);
    // Recheck the complete directory path before descent in case a queued
    // directory's parent was replaced by a link after its initial listing.
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || !sameLocalPath(await filesystem.realpath(absoluteDirectory), absoluteDirectory)) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
        "A Codex metadata directory is not an ordinary local directory.",
      );
    }
    const entries = await filesystem.readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const type = entry.isDirectory() ? "tree" : entry.isFile() ? "blob" : null;
      if (entry.isSymbolicLink() || !type || !isAllowedCodexMetadataEntry(relativePath, type)) {
        throw new TrelioFolderOnboardingError(
          "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
          "A Codex metadata directory contains a path or file type outside the onboarding allowlist.",
        );
      }
      // A Codex cache or config is opaque to Trelio. Inspect only directory
      // entries, without reading, activating or copying their files.
      if (type === "tree") pending.push(relativePath);
    }
  }
};

const inspectRootEntries = async ({ filesystem, rootPath, serviceGit }) => {
  const entries = await filesystem.readdir(rootPath, { withFileTypes: true });
  if (!serviceGit) return { hasWorkspacesDirectory: false };
  let hasWorkspacesDirectory = false;
  for (const entry of entries) {
    if (entry.name === ".git" || ROOT_ALLOWED_FILES.has(entry.name)) continue;
    if (isCodexMetadataDirectory(entry.name)) {
      await inspectCodexMetadataDirectory(filesystem, rootPath, entry.name);
      continue;
    }
    if (entry.name === "workspaces" && entry.isDirectory() && !entry.isSymbolicLink()) {
      hasWorkspacesDirectory = true;
      continue;
    }
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
      "The service Git root contains files outside the onboarding allowlist.",
    );
  }
  return { hasWorkspacesDirectory };
};

const exactManagedBlockPresent = (text, startMarker, endMarker, expectedBlock = null) => {
  const ranges = findMarkerRanges(text, startMarker, endMarker);
  if (ranges.length !== 1) return false;
  const range = ranges[0];
  const managedText = text.slice(range.start, range.end);
  return expectedBlock === null || managedText === expectedBlock;
};

const assertDedicatedDiagnosticFolder = async (filesystem, rootPath, serviceGit) => {
  // Classify names/types only. An unrelated work directory is not a Trelio
  // control-plane root, and diagnosing it must not inspect business files.
  const entries = await filesystem.readdir(rootPath, { withFileTypes: true });
  const metadataNames = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
  for (const entry of entries) {
    if ((ROOT_ALLOWED_FILES.has(entry.name) || metadataNames.has(entry.name))
      && entry.isFile() && !entry.isSymbolicLink()) continue;
    if ([".git", "workspaces"].includes(entry.name)
      && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // Service Git inspection has already verified these directories and their
    // contents. Ordinary diagnostics still require a dedicated Trelio folder.
    if (serviceGit && isCodexMetadataDirectory(entry.name)
      && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_DIAGNOSTIC_DEDICATED_FOLDER_REQUIRED",
      "Diagnostics requires a dedicated persistent Trelio working folder; unrelated root files are left untouched.",
    );
  }
};

const inspectFolder = async ({
  folderPath,
  filesystem = fs,
  execFileCommand = execFileAsync,
  gitResolver = resolveGitExecutable,
  allowExternalWorkspaceStorage = false,
  requireServiceGitIsolation = false,
}) => {
  const requestedPath = normalizeAbsoluteFolder(folderPath);
  let rootStat;
  try {
    rootStat = await filesystem.lstat(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_FOLDER_MISSING",
        "The client-selected working folder does not exist.",
      );
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_FOLDER_UNSAFE",
      "The client-selected working folder must be an ordinary directory.",
    );
  }
  await filesystem.access(requestedPath, fsConstants.R_OK | fsConstants.W_OK);
  const rootPath = await filesystem.realpath(requestedPath);
  try {
    await filesystem.lstat(path.join(rootPath, ".trelio-run.json"));
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_AGENT_RUN_ROOT",
      "The selected folder is an Agent Workspace root, not a persistent binding folder.",
    );
  } catch (error) {
    if (error instanceof TrelioFolderOnboardingError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  const git = await gitResolver({ filesystem, execFileCommand });
  if (git.status !== "ready") {
    throw new TrelioFolderOnboardingError(
      "TRELIO_GIT_REQUIRED",
      "Standalone Git 2.28+ is required to classify the selected folder safely.",
      { diagnostic: git },
    );
  }
  const topLevel = await runGit(
    git.gitPath,
    ["rev-parse", "--show-toplevel"],
    rootPath,
    execFileCommand,
  );
  let serviceGit = false;
  let orphanError = null;
  if (topLevel.ok) {
    const reportedPath = readGitPathOutput(topLevel.stdout);
    const topLevelPath = reportedPath
      ? await filesystem.realpath(reportedPath).catch(() => null) : null;
    if (!topLevelPath || !sameLocalPath(topLevelPath, rootPath)) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_PARENT_GIT",
        "The selected folder is inside another Git worktree.",
      );
    }
    serviceGit = true;
    orphanError = await inspectServiceGit({
      rootPath,
      gitPath: git.gitPath,
      filesystem,
      execFileCommand,
    });
    if (orphanError && !allowExternalWorkspaceStorage) throw orphanError;
  } else {
    const gitDir = await runGit(git.gitPath, ["rev-parse", "--git-dir"], rootPath, execFileCommand);
    if (gitDir.ok) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
        "The selected folder is a bare or unsupported Git repository.",
      );
    }
    try {
      await filesystem.lstat(path.join(rootPath, ".git"));
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
        "The selected folder contains unreadable or unsupported .git metadata.",
      );
    } catch (error) {
      if (error instanceof TrelioFolderOnboardingError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const rootEntries = await inspectRootEntries({ filesystem, rootPath, serviceGit });

  const override = await inspectOptionalRegularFile(
    filesystem,
    path.join(rootPath, "AGENTS.override.md"),
  );
  // A pre-existing bridge directory is accepted only for a binding previously
  // activated by this runtime. We intentionally inspect only the root markers:
  // Workspace contents remain protected and outside onboarding classification.
  if (serviceGit && (rootEntries.hasWorkspacesDirectory || orphanError)) {
    const activeInstruction = override.exists
      ? override
      : await inspectOptionalRegularFile(filesystem, path.join(rootPath, "AGENTS.md"));
    // An unreachable object never becomes a trusted Git object. Only the
    // effective existing binding can keep working in external storage, after
    // the repo topology, live refs, index and root entries have passed the
    // same checks. Protect any older folder-local copies with the usual ignore
    // proof even when all new copies will be placed elsewhere.
    if (orphanError && !readManagedBinding(activeInstruction.text)) throw orphanError;
    const ignore = await inspectOptionalRegularFile(filesystem, path.join(rootPath, ".gitignore"));
    if (
      !exactManagedBlockPresent(activeInstruction.text, MANAGED_START, MANAGED_END)
      || !exactManagedBlockPresent(ignore.text, IGNORE_START, IGNORE_END, IGNORE_BLOCK)
    ) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
        "A service Git workspaces directory is allowed only for an existing runtime-managed binding with the exact root ignore rule.",
      );
    }
  }
  if (serviceGit && (orphanError || requireServiceGitIsolation)) {
    await verifyServiceGitIgnore({ rootPath, gitPath: git.gitPath, execFileCommand });
  }
  return {
    schemaVersion: TRELIO_FOLDER_ONBOARDING_SCHEMA_VERSION,
    status: override.exists ? "instruction_target_required" : "ready",
    folder: {
      path: rootPath,
      kind: serviceGit ? "service_git" : "ordinary",
      serviceGitPreserved: serviceGit,
      ...(orphanError ? { workspaceStorage: "external" } : {}),
    },
    instructionTarget: override.exists ? null : "AGENTS.md",
    requiredDecision: override.exists ? {
      code: "CHOOSE_ACTIVE_INSTRUCTION_FILE",
      options: ["AGENTS.override.md", "remove_or_rename_override_then_reinspect"],
      reason: "AGENTS.override.md overrides AGENTS.md; writing AGENTS.md would not activate the binding.",
    } : null,
    git: { executableReady: true, processPathReady: git.processPathReady === true },
  };
};

// Only the new implicit Workspace placement calls this. A normal working
// folder does not start Git, and an existing local Run is resolved before this
// check. Use the same isolated Git classifier as diagnostics and onboarding.
export const needsExternalWorkspaceStorage = async (folderPath) => {
  try {
    await fs.lstat(path.join(folderPath, ".git"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const { folder } = await inspectFolder({
    folderPath, allowExternalWorkspaceStorage: true, requireServiceGitIsolation: true,
  });
  return folder.workspaceStorage === "external";
};

const buildClaudeText = (currentText, instructionTarget, preserveBytes = false) => {
  const desiredImport = `@${instructionTarget}`;
  const otherImport = instructionTarget === "AGENTS.md"
    ? "@AGENTS.override.md"
    : "@AGENTS.md";
  const lines = currentText.split(/\r?\n/u);
  if (lines.includes(otherImport)) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_CLAUDE_IMPORT_CONFLICT",
      `CLAUDE.md already imports ${otherImport}; onboarding will not add both instruction imports.`,
    );
  }
  if (lines.includes(desiredImport)) return currentText;
  // Refresh may add the missing import, but unlike initial setup it cannot
  // normalize existing personal rules or trim their whitespace.
  if (preserveBytes) return `${currentText}${currentText && !currentText.endsWith("\n") ? "\n" : ""}${desiredImport}\n`;
  return appendBlock(currentText, desiredImport);
};

const buildFileChange = (relativePath, snapshot, nextText) => ({
  path: relativePath,
  action: snapshot.exists ? (snapshot.text === nextText ? "none" : "update") : "create",
  beforeSha256: snapshot.sha256,
  afterSha256: sha256(Buffer.from(nextText, "utf8")),
  bytes: Buffer.byteLength(nextText, "utf8"),
});

const buildPlanState = async (rawInput, dependencies = {}) => {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      "folder onboarding input must be one object.",
    );
  }
  const supportedKeys = new Set([
    "folderPath",
    "instructionTarget",
    "company",
    "project",
    "planHash",
    "userExplicitlyRequestedFolderSetup",
    "userExplicitlyRequestedInstructionRefresh",
    "instructionRefreshClientKind",
    "clientKind",
  ]);
  const unknownKey = Object.keys(rawInput).find((key) => !supportedKeys.has(key));
  if (unknownKey) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      `${unknownKey} is not supported by folder onboarding.`,
    );
  }
  const filesystem = dependencies.filesystem ?? fs;
  // The caller supplies the real client solely to select its instruction-file
  // format. This never changes OAuth admission, hooks or company permissions.
  // Omission retains the old Codex/Claude bootstrap ABI and its exact plan.
  const clientKind = rawInput.instructionRefreshClientKind ?? rawInput.clientKind ?? "codex";
  if (!isTrelioFolderOnboardingClient(clientKind)) {
    throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_INVALID_INPUT", "Folder binding requires a supported exact client.");
  }
  const refreshOnly = rawInput.userExplicitlyRequestedInstructionRefresh === true;
  const inspection = await inspectFolder({
    folderPath: rawInput.folderPath,
    filesystem,
    execFileCommand: dependencies.execFileCommand,
    gitResolver: dependencies.gitResolver,
    allowExternalWorkspaceStorage: clientKind === "codex",
  });
  const binding = normalizeBinding(rawInput);
  if (rawInput.userExplicitlyRequestedInstructionRefresh === true && !binding) {
    throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_BINDING_REQUIRED", "Instruction refresh requires the exact existing scope.");
  }
  if (!binding) return { inspection, plan: null, files: null };

  const requestedTarget = normalizeInstructionTarget(rawInput.instructionTarget);
  // AGENTS.override.md belongs to Codex's precedence rules. Native clients
  // load AGENTS.md, so never pretend that writing the override binds them.
  if (["cursor", "antigravity", "deepseek-harness", "kimi-work", "multitool"].includes(clientKind)
    && (requestedTarget === "AGENTS.override.md" || inspection.status === "instruction_target_required")) {
    throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_INACTIVE_TARGET", "This native client requires AGENTS.md; resolve the existing AGENTS.override.md before binding this shared folder.");
  }
  if (inspection.status === "instruction_target_required" && !requestedTarget) {
    return { inspection, plan: null, files: null };
  }
  const instructionTarget = requestedTarget || inspection.instructionTarget;
  if (
    instructionTarget === "AGENTS.md"
    && inspection.status === "instruction_target_required"
  ) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INACTIVE_TARGET",
      "AGENTS.override.md is still active; choose it or remove/rename it before planning AGENTS.md.",
    );
  }

  const rootPath = inspection.folder.path;
  const instructionSnapshot = await inspectOptionalRegularFile(
    filesystem,
    path.join(rootPath, instructionTarget),
  );
  const external = inspection.folder.workspaceStorage === "external";
  const managedBlockOnly = refreshOnly || external;
  if (managedBlockOnly) {
    // Refresh and external-storage reconnect only update the existing managed
    // block. Neither can establish another scope or rewrite the Git ignore
    // rule. A fresh binding still requires completely classified Git.
    if (instructionSnapshot.exists && sha256(Buffer.from(instructionSnapshot.text, "utf8")) !== instructionSnapshot.sha256) {
      throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_UNSAFE_FILE", "Managed refresh requires a valid UTF-8 instruction file.");
    }
    if (refreshOnly && !isTrelioFolderOnboardingClient(rawInput.instructionRefreshClientKind)) {
      throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_INVALID_INPUT", "Instruction refresh requires a supported exact client.");
    }
    const existing = readManagedBinding(instructionSnapshot.text);
    if (!existing || existing.company.slug !== rawInput.company.slug
      || (existing.project?.slug ?? null) !== (rawInput.project?.slug ?? null)) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_BINDING_MISMATCH",
        "Managed refresh or external storage reconnect cannot create a binding or change its company/project scope.",
      );
    }
  }
  const claudeSnapshot = await inspectOptionalRegularFile(
    filesystem,
    path.join(rootPath, "CLAUDE.md"),
  );
  if (refreshOnly && rawInput.instructionRefreshClientKind === "claude-code"
    && claudeSnapshot.exists && sha256(Buffer.from(claudeSnapshot.text, "utf8")) !== claudeSnapshot.sha256) {
    throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_UNSAFE_FILE", "Managed refresh requires a valid UTF-8 Claude import file.");
  }
  const ignoreSnapshot = inspection.folder.serviceGitPreserved
    ? await inspectOptionalRegularFile(filesystem, path.join(rootPath, ".gitignore"))
    : null;
  const managedBlock = buildManagedBindingBlock(binding);
  const instructionText = managedBlockOnly ? replaceExistingManagedBlock(instructionSnapshot.text, managedBlock) : replaceManagedBlockAtEnd(
    instructionSnapshot.text,
    managedBlock,
    MANAGED_START,
    MANAGED_END,
  );
  const managesClaudeImport = !external && (refreshOnly ? clientKind === "claude-code"
    : ["codex", "claude-code"].includes(clientKind));
  const claudeText = !managesClaudeImport
    ? claudeSnapshot.text
    : buildClaudeText(claudeSnapshot.text, instructionTarget, refreshOnly);
  const ignoreText = ignoreSnapshot
    ? (managedBlockOnly ? ignoreSnapshot.text : replaceManagedBlockAtEnd(ignoreSnapshot.text, IGNORE_BLOCK, IGNORE_START, IGNORE_END))
    : null;
  const changes = [
    buildFileChange(instructionTarget, instructionSnapshot, instructionText),
    ...(managesClaudeImport
      ? [buildFileChange("CLAUDE.md", claudeSnapshot, claudeText)] : []),
    ...(ignoreSnapshot ? [buildFileChange(".gitignore", ignoreSnapshot, ignoreText)] : []),
  ];
  const planBasis = {
    schemaVersion: TRELIO_FOLDER_ONBOARDING_SCHEMA_VERSION,
    folderPath: rootPath,
    folderKind: inspection.folder.kind,
    ...(inspection.folder.workspaceStorage ? { workspaceStorage: inspection.folder.workspaceStorage } : {}),
    instructionTarget,
    company: binding.company,
    project: binding.project,
    changes,
    ...(refreshOnly ? { instructionRefreshClientKind: rawInput.instructionRefreshClientKind } : {}),
    ...(rawInput.clientKind ? { clientKind: rawInput.clientKind } : {}),
  };
  const planHash = sha256(Buffer.from(JSON.stringify(planBasis), "utf8"));
  const changedFiles = changes.filter(({ action }) => action !== "none");
  return {
    inspection,
    plan: {
      ...planBasis,
      status: changedFiles.length === 0 ? "already_configured" : "ready_to_apply",
      planHash,
      preview: { managedBlock },
      apply: changedFiles.length === 0 ? null : {
        toolName: "continue_trelio_workspace_action",
        arguments: {
          schemaVersion: 1,
          operation: TRELIO_FOLDER_ONBOARDING_OPERATION,
          parameters: {
            folderPath: rootPath,
            instructionTarget,
            company: rawInput.company,
            ...(rawInput.project ? { project: rawInput.project } : {}),
            planHash,
            ...(rawInput.clientKind ? { clientKind: rawInput.clientKind } : {}),
            ...(refreshOnly ? {
              userExplicitlyRequestedInstructionRefresh: true,
              instructionRefreshClientKind: rawInput.instructionRefreshClientKind,
            } : { userExplicitlyRequestedFolderSetup: true }),
          },
        },
      },
    },
    files: {
      [instructionTarget]: { snapshot: instructionSnapshot, text: instructionText },
      "CLAUDE.md": { snapshot: claudeSnapshot, text: claudeText },
      ...(ignoreSnapshot ? { ".gitignore": { snapshot: ignoreSnapshot, text: ignoreText } } : {}),
    },
  };
};

export const prepareTrelioFolderOnboarding = async (rawInput, dependencies = {}) => {
  const state = await buildPlanState(rawInput, dependencies);
  return {
    schemaVersion: TRELIO_FOLDER_ONBOARDING_SCHEMA_VERSION,
    kind: "trelio-folder-onboarding",
    inspection: state.inspection,
    plan: state.plan,
  };
};

/**
 * Read-only diagnostic of the client-selected root and the current signed
 * runtime's instruction template. The resulting refresh action still uses the
 * onboarding CAS/read-back/rollback implementation; it never inspects Workspace
 * materials and never creates a task, Workspace or Run.
 */
export const prepareTrelioFolderDiagnostic = async (rawInput, clientKind, dependencies = {}) => {
  if (!rawInput) return { status: "not_checked", reasonCode: "CLIENT_WORKING_FOLDER_REQUIRED" };
  if (typeof rawInput !== "object" || Array.isArray(rawInput)
    || Object.keys(rawInput).some((key) => !["folderPath"].includes(key))) {
    throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_INVALID_INPUT", "Folder diagnostics accepts only the client-selected folderPath.");
  }
  const filesystem = dependencies.filesystem ?? fs;
  const inspection = await inspectFolder({
    folderPath: rawInput.folderPath,
    ...dependencies,
    allowExternalWorkspaceStorage: clientKind === "codex",
    requireServiceGitIsolation: true,
  });
  if (["cursor", "antigravity", "deepseek-harness", "kimi-work", "multitool"].includes(clientKind) && inspection.status === "instruction_target_required") {
    throw new TrelioFolderOnboardingError("TRELIO_FOLDER_ONBOARDING_INACTIVE_TARGET", "This client loads AGENTS.md; an existing override needs an explicit target decision.");
  }
  const instructionTarget = inspection.status === "instruction_target_required"
    ? "AGENTS.override.md" : inspection.instructionTarget;
  const snapshot = await inspectOptionalRegularFile(filesystem, path.join(inspection.folder.path, instructionTarget));
  const binding = readManagedBinding(snapshot.text);
  if (!binding) {
    await assertDedicatedDiagnosticFolder(filesystem, inspection.folder.path, inspection.folder.serviceGitPreserved);
    return { status: "setup_required", folder: inspection.folder, instructionTarget,
      reasonCode: "TRELIO_FOLDER_ONBOARDING_BINDING_REQUIRED" };
  }
  const state = await buildPlanState({
    folderPath: inspection.folder.path, instructionTarget, ...binding,
    userExplicitlyRequestedInstructionRefresh: true, instructionRefreshClientKind: clientKind,
  }, dependencies);
  return {
    status: state.plan.status === "already_configured" ? "ready" : "refresh_available",
    folder: state.inspection.folder, instructionTarget,
    scope: { companySlug: binding.company.slug, ...(binding.project ? { projectSlug: binding.project.slug } : {}) },
    instructions: { status: state.plan.status === "already_configured" ? "current" : "outdated", templateSha256: sha256(state.plan.preview.managedBlock) },
    refresh: state.plan.apply ? {
      after: "successful_protected_read_for_exact_scope",
      authority: "diagnostic_request_unless_user_forbids_changes",
      changes: state.plan.changes.filter(({ action }) => action !== "none"),
      action: state.plan.apply,
      newClientSessionRequired: true,
    } : null,
  };
};

const assertSnapshotUnchanged = async (filesystem, rootPath, relativePath, snapshot) => {
  const current = await inspectOptionalRegularFile(filesystem, path.join(rootPath, relativePath));
  if (current.exists !== snapshot.exists || current.sha256 !== snapshot.sha256) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_PLAN_STALE",
      `${relativePath} changed after the plan was prepared. Prepare and review a new plan.`,
    );
  }
};

const writeAtomicFile = async (filesystem, rootPath, relativePath, fileState) => {
  const targetPath = path.join(rootPath, relativePath);
  const temporaryPath = path.join(
    rootPath,
    `.${relativePath.replaceAll(path.sep, "-")}.trelio-${process.pid}-${randomUUID()}.tmp`,
  );
  await filesystem.writeFile(temporaryPath, fileState.text, {
    encoding: "utf8",
    mode: fileState.snapshot.exists ? fileState.snapshot.mode : 0o600,
    flag: "wx",
  });
  try {
    await filesystem.rename(temporaryPath, targetPath);
  } catch (error) {
    await filesystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
};

const restoreWrittenFile = async (filesystem, rootPath, relativePath, fileState) => {
  const current = await inspectOptionalRegularFile(filesystem, path.join(rootPath, relativePath));
  const writtenSha256 = sha256(Buffer.from(fileState.text, "utf8"));
  // Never overwrite a concurrent edit made after our write. In that rare case
  // rollback stops at this file and the original failure remains authoritative.
  if (!current.exists || current.sha256 !== writtenSha256) return false;
  if (!fileState.snapshot.exists) {
    await filesystem.rm(path.join(rootPath, relativePath));
    return true;
  }
  await writeAtomicFile(filesystem, rootPath, relativePath, {
    snapshot: fileState.snapshot,
    text: fileState.snapshot.text,
  });
  return true;
};

const verifyServiceGitIgnore = async ({
  rootPath,
  gitPath,
  execFileCommand = execFileAsync,
}) => {
  const ignored = await runGit(
    gitPath,
    [
      "check-ignore",
      "--no-index",
      "--verbose",
      "--",
      "workspaces/",
      "workspaces/.trelio-onboarding-probe",
    ],
    rootPath,
    execFileCommand,
  );
  const lines = ignored.stdout.split(/\r?\n/u).filter(Boolean);
  if (
    !ignored.ok
    || lines.length !== 2
    || lines.some((line) => !/^\.gitignore:[0-9]+:\/workspaces\/\tworkspaces\//u.test(line))
  ) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_IGNORE_FAILED",
      "The root .gitignore did not prove that both Workspace paths are excluded.",
    );
  }
  const tracked = await runGit(
    gitPath,
    ["ls-files", "--stage", "-z", "--", "workspaces"],
    rootPath,
    execFileCommand,
  );
  if (!tracked.ok || tracked.stdout.length > 0) {
    throw new FolderGitHistoryError(
      "workspace_index",
      "The service Git index already contains Workspace paths.",
    );
  }
};

export const applyTrelioFolderOnboarding = async (rawInput, dependencies = {}) => {
  if (rawInput?.userExplicitlyRequestedFolderSetup !== true && rawInput?.userExplicitlyRequestedInstructionRefresh !== true) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_AUTHORITY_REQUIRED",
      "Folder apply requires a setup request or authorized managed instruction refresh.",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(String(rawInput?.planHash || ""))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      "planHash must be the exact SHA-256 returned by the current plan.",
    );
  }
  const filesystem = dependencies.filesystem ?? fs;
  const state = await buildPlanState(rawInput, dependencies);
  if (!state.plan || state.plan.status === "already_configured") {
    return {
      schemaVersion: 1,
      status: "already_configured",
      folder: state.inspection.folder,
      changedFiles: [],
    };
  }
  if (state.plan.planHash !== rawInput.planHash) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_PLAN_STALE",
      "The folder onboarding plan no longer matches current files or Git state.",
    );
  }
  const rootPath = state.inspection.folder.path;
  for (const [relativePath, fileState] of Object.entries(state.files)) {
    await assertSnapshotUnchanged(filesystem, rootPath, relativePath, fileState.snapshot);
  }

  const writtenFiles = [];
  let verified;
  try {
    // Isolate the bridge directory before activating instructions. If any later
    // proof or write fails, the exact files still owned by this apply are rolled
    // back to their CAS snapshots in reverse order.
    if (state.files[".gitignore"]?.snapshot.text !== state.files[".gitignore"]?.text) {
      await writeAtomicFile(filesystem, rootPath, ".gitignore", state.files[".gitignore"]);
      writtenFiles.push(".gitignore");
    }
    if (state.inspection.folder.serviceGitPreserved) {
      const git = await (dependencies.gitResolver ?? resolveGitExecutable)({
        filesystem,
        execFileCommand: dependencies.execFileCommand,
      });
      if (git.status !== "ready") {
        throw new TrelioFolderOnboardingError(
          "TRELIO_GIT_REQUIRED",
          "Standalone Git became unavailable before onboarding apply.",
        );
      }
      await verifyServiceGitIgnore({
        rootPath,
        gitPath: git.gitPath,
        execFileCommand: dependencies.execFileCommand,
      });
      const orphanError = await inspectServiceGit({
        rootPath, gitPath: git.gitPath, filesystem, execFileCommand: dependencies.execFileCommand,
      });
      const external = state.inspection.folder.workspaceStorage === "external";
      if (orphanError && !external) throw orphanError;
      if (!orphanError && external) {
        throw new TrelioFolderOnboardingError(
          "TRELIO_FOLDER_ONBOARDING_PLAN_STALE",
          "Git state changed while applying the reviewed external Workspace storage plan.",
        );
      }
    }
    for (const relativePath of [state.plan.instructionTarget, "CLAUDE.md"]) {
      const fileState = state.files[relativePath];
      if (fileState.snapshot.text !== fileState.text) {
        await writeAtomicFile(filesystem, rootPath, relativePath, fileState);
        writtenFiles.push(relativePath);
      }
    }

    verified = await buildPlanState(rawInput, dependencies);
    if (verified.plan?.status !== "already_configured"
      || verified.inspection.folder.workspaceStorage !== state.inspection.folder.workspaceStorage) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_VERIFY_FAILED",
        "Folder onboarding files did not match the reviewed plan after apply.",
      );
    }
  } catch (error) {
    for (const relativePath of writtenFiles.reverse()) {
      await restoreWrittenFile(
        filesystem,
        rootPath,
        relativePath,
        state.files[relativePath],
      ).catch(() => false);
    }
    throw error;
  }
  return {
    schemaVersion: 1,
    status: "applied",
    folder: verified.inspection.folder,
    instructionTarget: verified.plan.instructionTarget,
    company: verified.plan.company,
    project: verified.plan.project,
    changedFiles: state.plan.changes
      .filter(({ action }) => action !== "none")
      .map(({ path: relativePath, action, afterSha256 }) => ({
        path: relativePath,
        action,
        sha256: afterSha256,
      })),
    nextAction: {
      code: "START_NEW_CLIENT_TASK_OR_SESSION",
      reason: "Start a new client task/session to load the saved folder instructions.",
    },
  };
};
