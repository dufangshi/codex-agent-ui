import assert from "node:assert/strict";
import test from "node:test";

import { parseExportEnvFile, selectAcpAuthMethodIds } from "./acp-environment.js";

test("parseExportEnvFile reads export KEY=value lines", () => {
  const env = parseExportEnvFile(`
# comment
export XAI_API_KEY="sk-test"
GROK_MODELS_BASE_URL=https://example.test/v1
export BAD
=nope
`);
  assert.equal(env.XAI_API_KEY, "sk-test");
  assert.equal(env.GROK_MODELS_BASE_URL, "https://example.test/v1");
  assert.equal(Object.keys(env).length, 2);
});

test("Grok does not invent auth methods when initialize lists none", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      harnessId: "grok",
      advertised: [],
      env: { XAI_API_KEY: "sk-test" },
    }),
    [],
  );
});

test("Codex prefers the API key and skips ChatGPT when no subscription session exists", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      harnessId: "codex",
      advertised: [{ id: "api-key" }, { id: "chat-gpt" }],
      env: { OPENAI_API_KEY: "sk-test" },
      hasChatGptSession: false,
    }),
    ["api-key"],
  );
});

test("Codex uses ChatGPT first when a local session is present", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      harnessId: "codex",
      advertised: [{ id: "api-key" }, { id: "chat-gpt" }],
      env: {},
      hasChatGptSession: true,
    }),
    ["chat-gpt"],
  );
});

test("interactive Grok browser login is skipped", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      harnessId: "grok",
      advertised: [{ id: "grok.com" }, { id: "cached_token" }],
      env: {},
    }),
    [],
  );
});

test("Grok only tries cached_token when its own login cache exists", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      harnessId: "grok",
      advertised: [{ id: "grok.com" }, { id: "cached_token" }, { id: "api-key" }],
      env: { OPENAI_API_KEY: "sk-openai" },
      hasGrokSession: true,
    }),
    ["cached_token"],
  );
});

test("Cursor does not launch browser auth unless its CLI cache already exists", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      harnessId: "cursor",
      advertised: [{ id: "cursor_login" }],
      env: {},
      hasCursorSession: false,
    }),
    [],
  );
});
