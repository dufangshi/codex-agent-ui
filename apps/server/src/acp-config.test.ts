import assert from "node:assert/strict";
import test from "node:test";

import type * as acp from "@agentclientprotocol/sdk";

import {
  describeAcpConfigOptions,
  flattenSelectOptions,
  mapAcpReasoningEffort,
  mapAcpSessionConfig,
  mapAcpSessionPayload,
  mapAcpUsageUpdate,
  parseContextTokens,
  parseModelIdParams,
  resolveAcpThoughtValue,
  rewriteModelIdForEffort,
} from "./acp-config.ts";

const sampleOptions: acp.SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5",
    options: [
      { value: "gpt-5", name: "GPT-5", description: "Default Codex model" },
      { value: "gpt-5-codex", name: "GPT-5 Codex", description: "Coding model" },
    ],
  },
  {
    id: "thought_level",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra high" },
    ],
  },
];

test("flattens grouped select options", () => {
  assert.deepEqual(
    flattenSelectOptions([
      {
        group: "legacy",
        name: "Legacy",
        options: [{ value: "o3", name: "o3" }, { value: "o4-mini", name: "o4-mini" }],
      },
    ]).map((entry) => entry.value),
    ["o3", "o4-mini"],
  );
});

test("maps ACP model and thought_level options onto the thread-ui catalog", () => {
  const mapped = mapAcpSessionConfig(sampleOptions);
  assert.equal(mapped.modelConfigId, "model");
  assert.equal(mapped.thoughtConfigId, "thought_level");
  assert.equal(mapped.model, "gpt-5");
  assert.equal(mapped.reasoningEffort, "medium");
  assert.deepEqual(mapped.models.map((entry) => entry.model), ["gpt-5", "gpt-5-codex"]);
  assert.equal(mapped.models[0]?.displayName, "GPT-5");
  assert.equal(mapped.models[0]?.isDefault, true);
  assert.deepEqual(
    mapped.models[0]?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(mapped.models[1]?.defaultReasoningEffort, "medium");
});

test("finds model and reasoning selectors without categories", () => {
  const mapped = mapAcpSessionConfig([
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "grok-4",
      options: [{ value: "grok-4", name: "Grok 4" }],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ]);
  assert.equal(mapped.model, "grok-4");
  assert.equal(mapped.reasoningEffort, "high");
  assert.equal(mapped.thoughtConfigId, "reasoning_effort");
});

test("maps thought-level aliases used by ACP agents", () => {
  assert.equal(mapAcpReasoningEffort("x-high"), "xhigh");
  assert.equal(mapAcpReasoningEffort("maximum"), "max");
  assert.equal(mapAcpReasoningEffort("auto"), null);
  assert.equal(mapAcpReasoningEffort("default"), null);
});

test("resolves a requested reasoning effort back to the ACP value id", () => {
  const mapped = mapAcpSessionConfig(sampleOptions);
  assert.equal(resolveAcpThoughtValue(mapped, "high"), "high");
  assert.equal(resolveAcpThoughtValue(mapped, "xhigh"), "xhigh");
  assert.equal(resolveAcpThoughtValue(mapped, "missing"), null);
});

test("maps usage_update onto the remoteCodex context window DTO", () => {
  const usage = mapAcpUsageUpdate({ used: 32_000, size: 272_000 }, "2026-08-27T00:00:00.000Z");
  assert.deepEqual(usage, {
    availability: "available",
    tokensInContextWindow: 32_000,
    modelContextWindow: 272_000,
    remainingPercent: 88,
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
});

test("describeAcpConfigOptions summarizes current values", () => {
  assert.equal(
    describeAcpConfigOptions(sampleOptions),
    "model=gpt-5, thought_level=medium",
  );
});

test("Codex-style configOptions write through session/set_config_option", () => {
  const mapped = mapAcpSessionConfig(sampleOptions);
  assert.equal(mapped.modelWrite, "config");
  assert.equal(mapped.thoughtWrite, "config");
});

test("maps Grok's unstable models payload onto the composer catalog", () => {
  const mapped = mapAcpSessionPayload({
    models: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            totalContextTokens: 500000,
            reasoningEffort: "high",
            supportsReasoningEffort: true,
            reasoningEfforts: [
              { id: "xhigh", value: "xhigh", label: "Extra High Effort" },
              { id: "high", value: "high", label: "High Effort", default: true },
              { id: "medium", value: "medium", label: "Medium Effort" },
              { id: "low", value: "low", label: "Low Effort" },
            ],
          },
        },
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: {
            totalContextTokens: 500000,
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", value: "high", label: "High Effort", default: true },
              { id: "low", value: "low", label: "Low Effort" },
            ],
          },
        },
      ],
    },
  });
  assert.equal(mapped.model, "grok-4.6");
  assert.equal(mapped.reasoningEffort, "high");
  assert.equal(mapped.modelWrite, "set_model");
  assert.equal(mapped.thoughtWrite, "set_mode");
  assert.equal(mapped.modelContextWindow, 500000);
  assert.deepEqual(mapped.models.map((entry) => entry.displayName), ["Grok 4.6", "Grok 4.5"]);
  assert.deepEqual(
    mapped.models[0]?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
    ["xhigh", "high", "medium", "low"],
  );
});

test("parses Cursor model ids for context window and reasoning", () => {
  const mapped = mapAcpSessionPayload({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
        options: [
          { value: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", name: "gpt-5.6-sol" },
          { value: "default[]", name: "Auto" },
        ],
      },
    ],
  });
  assert.equal(mapped.modelWrite, "config");
  assert.equal(mapped.thoughtWrite, "model_id");
  assert.equal(mapped.reasoningEffort, "medium");
  assert.equal(mapped.modelContextWindow, 272000);
  assert.equal(
    rewriteModelIdForEffort("gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", "high"),
    "gpt-5.6-sol[context=272k,reasoning=high,fast=false]",
  );
  assert.deepEqual(parseModelIdParams("gemini-3-flash[]"), { base: "gemini-3-flash", params: {} });
  assert.equal(parseContextTokens("300k"), 300000);
});
