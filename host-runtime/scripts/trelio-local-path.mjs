import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Node resolves an entry module through filesystem aliases, while argv[1]
 * retains the path used by its parent. A raw URL/path comparison can therefore
 * exit successfully without running a CLI at all (for example /var -> /private/
 * var, or a Windows directory junction). Compare the same actual file instead.
 *
 * This helper is only a main-module guard. It does not select another runtime,
 * scan caches, or relax symlink/containment checks for package or private data.
 * In particular, an imported module with the same basename is never a CLI.
 */
export const isDirectModuleInvocation = (moduleUrl, argumentPath = process.argv[1]) => {
  if (typeof argumentPath !== "string" || !argumentPath) return false;
  try {
    return sameLocalPath(
      realpathSync.native(fileURLToPath(moduleUrl)),
      realpathSync.native(path.resolve(argumentPath)),
    );
  } catch {
    // An absent/unresolvable argv target cannot establish direct invocation.
    // Imports (tests, node -e, embedded consumers) must remain side-effect free.
    return false;
  }
};

/**
 * Compare local paths with the platform's own path rules. In particular,
 * win32.relative treats spelling-only case differences as the same directory;
 * comparing two resolved strings would reject a valid Windows Run.
 * The optional path API lets tests exercise Windows semantics on other hosts.
 */
export const sameLocalPath = (left, right, pathApi = path) => (
  typeof left === "string" && left.length > 0
  && typeof right === "string" && right.length > 0
  && pathApi.relative(pathApi.resolve(left), pathApi.resolve(right)) === ""
);

/**
 * Require a strict descendant, including on Windows when drive or directory
 * letters differ in case. The separator check keeps sibling prefixes out and
 * the absolute check rejects paths on another drive or UNC share.
 */
export const isLocalPathInside = (parent, child, pathApi = path) => {
  if (typeof parent !== "string" || !parent || typeof child !== "string" || !child) {
    return false;
  }
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative);
};
