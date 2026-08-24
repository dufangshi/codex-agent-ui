import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultAgentId, LOCAL_AGENT_ID, resolveAgentId } from "./agent-id.ts";

test("defaultAgentId prefers TREER_AGENT_ID", () => {
  assert.equal(defaultAgentId({ TREER_AGENT_ID: "ag_1" }), "ag_1");
  assert.equal(defaultAgentId({}), LOCAL_AGENT_ID);
});

test("resolveAgentId prefers query, then header, then body, then fallback", () => {
  assert.equal(
    resolveAgentId({ query: "ag_q", header: "ag_h", body: "ag_b", fallback: "ag_f" }),
    "ag_q",
  );
  assert.equal(resolveAgentId({ header: "ag_h", body: "ag_b", fallback: "ag_f" }), "ag_h");
  assert.equal(resolveAgentId({ body: "ag_b", fallback: "ag_f" }), "ag_b");
  assert.equal(resolveAgentId({ fallback: "ag_f" }), "ag_f");
  assert.equal(resolveAgentId({}), LOCAL_AGENT_ID);
});
