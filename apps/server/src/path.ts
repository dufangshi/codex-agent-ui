import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export class ThreadPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadPathError";
  }
}

export function inferWorkspaceRoot(cwd: string, configured?: string) {
  if (configured?.trim()) {
    return resolve(configured.trim());
  }
  const resolved = resolve(cwd);
  if (resolved === "/workspace" || resolved.startsWith("/workspace/")) {
    return "/workspace";
  }
  return resolved;
}

export function resolveThreadCwd(input: string | undefined, cwd: string, root: string) {
  const requested = (input ?? "").trim() || cwd;
  const resolved = resolve(cwd, requested);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ThreadPathError(`path must stay inside ${root}`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new ThreadPathError(`path is not a directory: ${resolved}`);
  }
  return resolved;
}
