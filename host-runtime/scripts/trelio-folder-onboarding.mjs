import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
const ROOT_ALLOWED_FILES = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  ".gitignore",
]);
const MANAGED_START = "<!-- trelio-agent-workspaces:start -->";
const MANAGED_END = "<!-- trelio-agent-workspaces:end -->";
const IGNORE_START = "# trelio-agent-workspaces:ignore:start";
const IGNORE_END = "# trelio-agent-workspaces:ignore:end";
const IGNORE_BLOCK = [IGNORE_START, "/workspaces/", IGNORE_END].join("\n");
const CODEX_CHECKPOINT_REF = /^refs\/codex\/turn-diffs\/checkpoints\/[0-9a-f]{64}\/[0-9a-f]{64}\/[1-9][0-9]*\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODEX_CAPTURE_REF = /^refs\/codex\/turn-diffs\/captures\/[1-9][0-9]*\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:base|head)$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const ALLOWED_LOCAL_CONFIG_KEYS = new Set([
  "core.bare",
  "core.filemode",
  "core.ignorecase",
  "core.logallrefupdates",
  "core.precomposeunicode",
  "core.repositoryformatversion",
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
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
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
    "Не создавай рабочие материалы, `tmp/` или `output/` в корне этой папки. Для задачи или именованного воркспейса сначала открой Agent Run и работай только в пути, который вернул bridge. Новый Workspace bridge размещает в `workspaces/<workspace-id>/`; внутри `workspace/` лежат редактируемые файлы, а `context/` и `.trelio-run.json` остаются служебными.",
    "",
    "Если в корне осталась служебная `.git` клиента, сохраняй её и корневое исключение `/workspaces/` в `.gitignore`. Не выполняй Git add/commit/push из корня и не добавляй туда remote. Git-операции Trelio относятся только к выданному bridge воркспейсу.",
    "",
    "Каждое сообщение обрабатывай в контексте Trelio. Уже загруженные в текущей сессии правила и данные используй повторно, пока тема, объект и требования к актуальности не изменились.",
    "",
    "Если нужного контекста нет:",
    "",
    "- для точной задачи вызови `get_task`;",
    `- иначе получи правила через \`get_agent_instructions\`, затем вызови Trelio \`search\` с \`companySlugs: [\"${company.slug}\"]\`.`,
    "",
    "До этого не используй WebSearch, WebFetch, другие внешние источники и не отвечай по существу из собственных знаний.",
    "",
    "Не решай самостоятельно, что запрос «нерабочий» или не требует Trelio. Пропустить проверку можно только по прямому указанию пользователя в текущем сообщении.",
    "",
    "Если Trelio недоступен, сообщи, что контекст не проверен, и не подменяй его догадками.",
    MANAGED_END,
  );
  return lines.join("\n");
};

const parseWorktreePaths = (stdout) => String(stdout || "")
  .split(/\r?\n/u)
  .filter((line) => line.startsWith("worktree "))
  .map((line) => line.slice("worktree ".length));

const parseObjectInventory = (stdout) => String(stdout || "")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => {
    const [objectId, type, rawSize] = line.split(" ");
    return { objectId, type, size: Number(rawSize) };
  });

const inspectTree = async ({ gitPath, rootPath, treeId, execFileCommand }) => {
  const result = await runGit(
    gitPath,
    ["ls-tree", "-rz", "--full-tree", treeId],
    rootPath,
    execFileCommand,
  );
  if (!result.ok) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
      "Git tree inspection failed; onboarding stopped without changing the repository.",
    );
  }
  const blobs = new Set();
  const entries = Buffer.from(result.stdout, "utf8").toString("utf8").split("\0").filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^(?<mode>[0-9]{6}) (?<type>[^ ]+) (?<object>[0-9a-f]{40,64})\t(?<file>.+)$/u);
    if (
      !match?.groups
      || match.groups.mode !== "100644"
      || match.groups.type !== "blob"
      || !ROOT_ALLOWED_FILES.has(match.groups.file)
    ) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
        "A Codex turn-diff tree contains a path or object outside the onboarding allowlist.",
      );
    }
    blobs.add(match.groups.object);
  }
  return blobs;
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
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      "The selected folder already contains Git commit history.",
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
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      "The selected folder contains remotes or indexed paths.",
    );
  }
  const worktreePaths = parseWorktreePaths(worktrees.stdout);
  if (
    worktreePaths.length !== 1
    || await filesystem.realpath(worktreePaths[0]).catch(() => null) !== rootPath
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
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
        "The selected repository contains a ref outside exact Codex turn-diff trees.",
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
  if (objects.some(({ objectId, type, size }) => (
    !SHA_PATTERN.test(objectId)
    || !["tree", "blob"].includes(type)
    || !Number.isSafeInteger(size)
    || size < 0
  ))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      "The selected repository contains commit, tag or malformed Git objects.",
    );
  }
  const objectIds = new Set(objects.map(({ objectId }) => objectId));
  if ([...referencedTrees].some((treeId) => !objectIds.has(treeId))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED",
      "A Codex turn-diff ref points outside the complete local object inventory.",
    );
  }
  // A service repository has no ordinary history: every tree must be the exact
  // value of an allowed Codex ref. Otherwise an unreferenced tree could retain
  // an older instruction blob while still satisfying the root-path allowlist.
  if (objects.some(({ objectId, type }) => type === "tree" && !referencedTrees.has(objectId))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      "The selected repository contains an orphan Git tree outside exact Codex turn-diff refs.",
    );
  }
  const allowedBlobs = new Set();
  for (const treeId of referencedTrees) {
    const treeBlobs = await inspectTree({
      gitPath,
      rootPath,
      treeId,
      execFileCommand,
    });
    for (const blob of treeBlobs) allowedBlobs.add(blob);
  }
  if (objects.some(({ objectId, type }) => type === "blob" && !allowedBlobs.has(objectId))) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      "The selected repository contains an orphan Git blob without an allowed instruction path.",
    );
  }
};

const inspectRootEntries = async ({ filesystem, rootPath, serviceGit }) => {
  const entries = await filesystem.readdir(rootPath, { withFileTypes: true });
  if (!serviceGit) return { hasWorkspacesDirectory: false };
  let hasWorkspacesDirectory = false;
  for (const entry of entries) {
    if (entry.name === ".git" || ROOT_ALLOWED_FILES.has(entry.name)) continue;
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

const inspectFolder = async ({
  folderPath,
  filesystem = fs,
  execFileCommand = execFileAsync,
  gitResolver = resolveGitExecutable,
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
  if (topLevel.ok) {
    const topLevelPath = await filesystem.realpath(topLevel.stdout.trim()).catch(() => null);
    if (topLevelPath !== rootPath) {
      throw new TrelioFolderOnboardingError(
        "TRELIO_FOLDER_ONBOARDING_PARENT_GIT",
        "The selected folder is inside another Git worktree.",
      );
    }
    serviceGit = true;
    await inspectServiceGit({
      rootPath,
      gitPath: git.gitPath,
      filesystem,
      execFileCommand,
    });
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
  if (serviceGit && rootEntries.hasWorkspacesDirectory) {
    const activeInstruction = override.exists
      ? override
      : await inspectOptionalRegularFile(filesystem, path.join(rootPath, "AGENTS.md"));
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
  return {
    schemaVersion: TRELIO_FOLDER_ONBOARDING_SCHEMA_VERSION,
    status: override.exists ? "instruction_target_required" : "ready",
    folder: {
      path: rootPath,
      kind: serviceGit ? "service_git" : "ordinary",
      serviceGitPreserved: serviceGit,
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

const buildClaudeText = (currentText, instructionTarget) => {
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
  ]);
  const unknownKey = Object.keys(rawInput).find((key) => !supportedKeys.has(key));
  if (unknownKey) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT",
      `${unknownKey} is not supported by folder onboarding.`,
    );
  }
  const filesystem = dependencies.filesystem ?? fs;
  const inspection = await inspectFolder({
    folderPath: rawInput.folderPath,
    filesystem,
    execFileCommand: dependencies.execFileCommand,
    gitResolver: dependencies.gitResolver,
  });
  const binding = normalizeBinding(rawInput);
  if (!binding) return { inspection, plan: null, files: null };

  const requestedTarget = normalizeInstructionTarget(rawInput.instructionTarget);
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
  const claudeSnapshot = await inspectOptionalRegularFile(
    filesystem,
    path.join(rootPath, "CLAUDE.md"),
  );
  const ignoreSnapshot = inspection.folder.serviceGitPreserved
    ? await inspectOptionalRegularFile(filesystem, path.join(rootPath, ".gitignore"))
    : null;
  const managedBlock = buildManagedBindingBlock(binding);
  const instructionText = replaceManagedBlockAtEnd(
    instructionSnapshot.text,
    managedBlock,
    MANAGED_START,
    MANAGED_END,
  );
  const claudeText = buildClaudeText(claudeSnapshot.text, instructionTarget);
  const ignoreText = ignoreSnapshot
    ? replaceManagedBlockAtEnd(ignoreSnapshot.text, IGNORE_BLOCK, IGNORE_START, IGNORE_END)
    : null;
  const changes = [
    buildFileChange(instructionTarget, instructionSnapshot, instructionText),
    buildFileChange("CLAUDE.md", claudeSnapshot, claudeText),
    ...(ignoreSnapshot ? [buildFileChange(".gitignore", ignoreSnapshot, ignoreText)] : []),
  ];
  const planBasis = {
    schemaVersion: TRELIO_FOLDER_ONBOARDING_SCHEMA_VERSION,
    folderPath: rootPath,
    folderKind: inspection.folder.kind,
    instructionTarget,
    company: binding.company,
    project: binding.project,
    changes,
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
            userExplicitlyRequestedFolderSetup: true,
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

const verifyServiceGitIsolation = async ({
  rootPath,
  gitPath,
  filesystem,
  execFileCommand,
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
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      "The service Git index already contains Workspace paths.",
    );
  }
  await inspectServiceGit({ rootPath, gitPath, filesystem, execFileCommand });
};

export const applyTrelioFolderOnboarding = async (rawInput, dependencies = {}) => {
  if (rawInput?.userExplicitlyRequestedFolderSetup !== true) {
    throw new TrelioFolderOnboardingError(
      "TRELIO_FOLDER_ONBOARDING_AUTHORITY_REQUIRED",
      "Folder onboarding apply requires an explicit user setup request.",
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
      await verifyServiceGitIsolation({
        rootPath,
        gitPath: git.gitPath,
        filesystem,
        execFileCommand: dependencies.execFileCommand,
      });
    }
    for (const relativePath of [state.plan.instructionTarget, "CLAUDE.md"]) {
      const fileState = state.files[relativePath];
      if (fileState.snapshot.text !== fileState.text) {
        await writeAtomicFile(filesystem, rootPath, relativePath, fileState);
        writtenFiles.push(relativePath);
      }
    }

    verified = await buildPlanState(rawInput, dependencies);
    if (verified.plan?.status !== "already_configured") {
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
      reason: "Folder instruction files are loaded only by a new Codex task or Claude session.",
    },
  };
};
