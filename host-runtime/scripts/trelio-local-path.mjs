import path from "node:path";

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
