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

test("Grok with a host API key authenticates even when initialize lists no methods", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      advertised: [],
      env: { XAI_API_KEY: "sk-test" },
    }),
    ["xai.api_key", "cached_token"],
  );
});

test("Codex prefers the API key and skips ChatGPT when no subscription session exists", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
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
      advertised: [{ id: "api-key" }, { id: "chat-gpt" }],
      env: {},
      hasChatGptSession: true,
    }),
    ["chat-gpt", "api-key"],
  );
});

test("interactive Grok browser login is skipped", () => {
  assert.deepEqual(
    selectAcpAuthMethodIds({
      advertised: [{ id: "grok.com" }, { id: "cached_token" }],
      env: {},
    }),
    ["cached_token"],
  );
});
