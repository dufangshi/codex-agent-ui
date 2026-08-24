import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { inferWorkspaceRoot, resolveThreadCwd, ThreadPathError } from "./path.ts";

test("inferWorkspaceRoot uses /workspace for Treer sandboxes", () => {
  assert.equal(inferWorkspaceRoot("/workspace/codex-agent-ui"), "/workspace");
  assert.equal(inferWorkspaceRoot("/workspace"), "/workspace");
});

test("inferWorkspaceRoot keeps a local project at its cwd", () => {
  assert.equal(inferWorkspaceRoot("/Users/mac/dev/codex-agent-ui"), "/Users/mac/dev/codex-agent-ui");
});

test("resolveThreadCwd accepts the workspace root and nested directories", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-ui-path-"));
  const nested = join(root, "codex-agent-ui");
  mkdirSync(nested);
  assert.equal(resolveThreadCwd(root, nested, root), root);
  assert.equal(resolveThreadCwd(nested, nested, root), nested);
  assert.equal(resolveThreadCwd(".", nested, root), nested);
});

test("resolveThreadCwd rejects missing paths and escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-ui-path-"));
  const nested = join(root, "codex-agent-ui");
  mkdirSync(nested);
  assert.throws(() => resolveThreadCwd("/tmp", nested, root), ThreadPathError);
  assert.throws(() => resolveThreadCwd(join(root, "missing"), nested, root), ThreadPathError);
});
