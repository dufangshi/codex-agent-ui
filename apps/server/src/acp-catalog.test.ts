import assert from "node:assert/strict";
import test from "node:test";

import { builtinAcpAgents, resolveAcpAgent } from "./acp-catalog.js";

test("catalog covers the four required harnesses", () => {
  assert.deepEqual(
    builtinAcpAgents.map((entry) => entry.id).sort(),
    ["claude", "codex", "cursor", "grok"],
  );
});

test("adapter harnesses declare an install command", () => {
  assert.equal(resolveAcpAgent("codex").transport, "adapter");
  assert.match(resolveAcpAgent("codex").installCommand ?? "", /codex-acp/);
  assert.equal(resolveAcpAgent("claude").transport, "adapter");
  assert.match(resolveAcpAgent("claude").installCommand ?? "", /claude-agent-acp/);
});

test("native harnesses do not need an adapter install", () => {
  assert.equal(resolveAcpAgent("grok").transport, "native");
  assert.equal(resolveAcpAgent("grok").installCommand, null);
  assert.equal(resolveAcpAgent("cursor").transport, "native");
  assert.equal(resolveAcpAgent("cursor").installCommand, null);
});
