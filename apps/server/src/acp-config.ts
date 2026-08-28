import type * as acp from "@agentclientprotocol/sdk";

import { mapReasoningEffort, type ModelOption, type ReasoningEffort } from "./map.js";

export interface ThreadContextUsage {
  availability: "available" | "unavailable";
  remainingPercent: number | null;
  tokensInContextWindow: number | null;
  modelContextWindow: number | null;
  updatedAt: string | null;
}

export interface AcpThoughtValue {
  value: string;
  effort: ReasoningEffort | null;
  name: string;
  description: string;
}

export type AcpModelWrite = "config" | "set_model" | null;
export type AcpThoughtWrite = "config" | "set_mode" | "model_id" | null;

export interface AcpLegacyModelInfo {
  modelId: string;
  name?: string;
  description?: string;
  _meta?: {
    totalContextTokens?: number;
    reasoningEffort?: string;
    supportsReasoningEffort?: boolean;
    reasoningEfforts?: Array<{
      id?: string;
      value?: string;
      label?: string;
      description?: string;
      default?: boolean;
    }>;
    [key: string]: unknown;
  };
}

export interface AcpLegacyModelState {
  currentModelId?: string;
  availableModels?: AcpLegacyModelInfo[];
}

export interface AcpSessionPayload {
  configOptions?: acp.SessionConfigOption[] | null;
  models?: AcpLegacyModelState | null;
  modes?: acp.SessionModeState | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionConfig {
  options: acp.SessionConfigOption[];
  models: ModelOption[];
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  modelConfigId: string | null;
  thoughtConfigId: string | null;
  thoughtValues: AcpThoughtValue[];
  modelWrite: AcpModelWrite;
  thoughtWrite: AcpThoughtWrite;
  modelContextWindow: number | null;
  legacyModels: AcpLegacyModelState | null;
}

const MODEL_ID_HINTS = new Set(["model", "models"]);
const THOUGHT_ID_HINTS = new Set([
  "thought_level",
  "thought-level",
  "thought",
  "reasoning",
  "reasoning_effort",
  "reasoning-effort",
  "effort",
]);

const EFFORT_ALIASES: Record<string, ReasoningEffort | null> = {
  "": null,
  auto: null,
  default: null,
  none: "none",
  off: "none",
  disable: "none",
  disabled: "none",
  min: "minimal",
  minimal: "minimal",
  low: "low",
  light: "low",
  med: "medium",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  extra: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
  maximum: "max",
  ultra: "ultra",
};

export function unavailableContextUsage(updatedAt: string | null = null): ThreadContextUsage {
  return {
    availability: "unavailable",
    remainingPercent: null,
    tokensInContextWindow: null,
    modelContextWindow: null,
    updatedAt,
  };
}

export function seedContextUsage(modelContextWindow: number | null, updatedAt = new Date().toISOString()): ThreadContextUsage {
  if (!modelContextWindow || modelContextWindow <= 0) {
    return unavailableContextUsage(updatedAt);
  }
  return {
    availability: "available",
    tokensInContextWindow: 0,
    modelContextWindow,
    remainingPercent: 100,
    updatedAt,
  };
}

export function mapAcpReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") {
    return mapReasoningEffort(value);
  }
  const key = value.trim().toLowerCase();
  if (key in EFFORT_ALIASES) {
    return EFFORT_ALIASES[key];
  }
  return mapReasoningEffort(key);
}

export function flattenSelectOptions(
  options: acp.SessionConfigSelectOptions | null | undefined,
): acp.SessionConfigSelectOption[] {
  if (!Array.isArray(options)) {
    return [];
  }
  const flattened: acp.SessionConfigSelectOption[] = [];
  for (const entry of options) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if ("group" in entry && Array.isArray(entry.options)) {
      flattened.push(...entry.options);
      continue;
    }
    if ("value" in entry && typeof entry.value === "string") {
      flattened.push(entry);
    }
  }
  return flattened;
}

function isSelectOption(
  option: acp.SessionConfigOption,
): option is acp.SessionConfigOption & acp.SessionConfigSelect & { type: "select" } {
  return option.type === "select";
}

function optionCurrentValue(option: acp.SessionConfigOption): string | null {
  if (!isSelectOption(option)) {
    return null;
  }
  return typeof option.currentValue === "string" && option.currentValue.trim()
    ? option.currentValue.trim()
    : null;
}

function findSelectOption(
  options: acp.SessionConfigOption[],
  category: string,
  idHints: Set<string>,
  namePattern: RegExp,
): (acp.SessionConfigOption & acp.SessionConfigSelect & { type: "select" }) | null {
  const selects = options.filter(isSelectOption);
  return selects.find((option) => option.category === category)
    ?? selects.find((option) => idHints.has(option.id.trim().toLowerCase()))
    ?? selects.find((option) => namePattern.test(option.name))
    ?? null;
}

export function describeAcpConfigOptions(options: acp.SessionConfigOption[]) {
  if (options.length === 0) {
    return "(none)";
  }
  return options.map((option) => `${option.id}=${String(option.currentValue)}`).join(", ");
}

export function parseModelIdParams(modelId: string) {
  const trimmed = modelId.trim();
  const match = trimmed.match(/^([^[]+)\[(.*)\]$/);
  if (!match) {
    return { base: trimmed, params: {} as Record<string, string> };
  }
  const params: Record<string, string> = {};
  if (match[2].trim()) {
    for (const part of match[2].split(",")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      params[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  }
  return { base: match[1], params };
}

export function parseContextTokens(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  if (match[2] === "k") return Math.round(amount * 1000);
  if (match[2] === "m") return Math.round(amount * 1_000_000);
  return amount;
}

function thoughtValuesFromEfforts(efforts: unknown): AcpThoughtValue[] {
  if (!Array.isArray(efforts)) {
    return [];
  }
  return efforts.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { id?: string; value?: string; label?: string; description?: string };
    const value = item.value || item.id;
    if (!value) return [];
    return [{
      value,
      effort: mapAcpReasoningEffort(value) ?? mapAcpReasoningEffort(item.label),
      name: item.label || value,
      description: item.description ?? "",
    }];
  });
}

function thoughtFromModelId(modelId: string): { value: string; effort: ReasoningEffort } | null {
  const { params } = parseModelIdParams(modelId);
  const raw = params.reasoning || params.effort;
  const effort = mapAcpReasoningEffort(raw);
  if (!raw || !effort) {
    return null;
  }
  return { value: raw, effort };
}

function rewriteModelIdEffort(modelId: string, effort: string) {
  const { base, params } = parseModelIdParams(modelId);
  if (Object.keys(params).length === 0) {
    return `${base}[reasoning=${effort}]`;
  }
  if ("reasoning" in params) {
    params.reasoning = effort;
  } else if ("effort" in params) {
    params.effort = effort;
  } else {
    params.reasoning = effort;
  }
  const body = Object.entries(params).map(([key, value]) => `${key}=${value}`).join(",");
  return `${base}[${body}]`;
}

function currentLegacyModel(models: AcpLegacyModelState | null | undefined) {
  const available = models?.availableModels ?? [];
  const currentId = models?.currentModelId;
  return available.find((entry) => entry.modelId === currentId) ?? available[0] ?? null;
}

function modelsFromLegacy(models: AcpLegacyModelState, thoughtValues: AcpThoughtValue[], defaultEffort: ReasoningEffort | null): ModelOption[] {
  const currentId = models.currentModelId ?? null;
  return (models.availableModels ?? []).map((entry, index) => ({
    id: entry.modelId || `${entry.name ?? "model"}-${index}`,
    model: entry.modelId,
    displayName: entry.name || parseModelIdParams(entry.modelId).base || entry.modelId,
    description: entry.description ?? "",
    isDefault: entry.modelId === currentId || (!currentId && index === 0),
    hidden: false,
    supportedReasoningEfforts: thoughtValues.flatMap((item) => (
      item.effort ? [{ reasoningEffort: item.effort, description: item.description || item.name }] : []
    )),
    defaultReasoningEffort: defaultEffort,
  }));
}

function attachThoughtToModels(models: ModelOption[], thoughtValues: AcpThoughtValue[], defaultEffort: ReasoningEffort | null) {
  const supportedReasoningEfforts = thoughtValues.flatMap((item) => (
    item.effort ? [{ reasoningEffort: item.effort, description: item.description || item.name }] : []
  ));
  return models.map((entry) => ({
    ...entry,
    supportedReasoningEfforts: entry.supportedReasoningEfforts.length > 0
      ? entry.supportedReasoningEfforts
      : supportedReasoningEfforts,
    defaultReasoningEffort: entry.defaultReasoningEffort ?? defaultEffort,
  }));
}

export function mapAcpSessionConfig(
  options: acp.SessionConfigOption[] | null | undefined,
): AcpSessionConfig {
  return mapAcpSessionPayload({ configOptions: options ?? [] });
}

export function mapAcpSessionPayload(payload: AcpSessionPayload = {}): AcpSessionConfig {
  const list = Array.isArray(payload.configOptions) ? payload.configOptions : [];
  const modelOption = findSelectOption(list, "model", MODEL_ID_HINTS, /\bmodel\b/i);
  const thoughtOption = findSelectOption(
    list,
    "thought_level",
    THOUGHT_ID_HINTS,
    /reason|thought|effort/i,
  );
  const modelValues = flattenSelectOptions(modelOption?.options);
  let thoughtValues: AcpThoughtValue[] = flattenSelectOptions(thoughtOption?.options).map((entry) => ({
    value: entry.value,
    effort: mapAcpReasoningEffort(entry.value) ?? mapAcpReasoningEffort(entry.name),
    name: entry.name,
    description: entry.description ?? "",
  }));
  const currentModelFromConfig = modelOption ? optionCurrentValue(modelOption) : null;
  let models: ModelOption[] = modelValues.map((entry, index) => ({
    id: entry.value || `${entry.name}-${index}`,
    model: entry.value,
    displayName: entry.name || parseModelIdParams(entry.value).base || entry.value,
    description: entry.description ?? "",
    isDefault: entry.value === currentModelFromConfig || (!currentModelFromConfig && index === 0),
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  }));

  const legacyModels = payload.models ?? null;
  if (models.length === 0 && legacyModels?.availableModels?.length) {
    models = modelsFromLegacy(legacyModels, [], null);
  }

  const currentModel = currentModelFromConfig
    ?? legacyModels?.currentModelId
    ?? models[0]?.model
    ?? null;
  const currentLegacy = currentLegacyModel(legacyModels);
  const selected = models.find((entry) => entry.model === currentModel) ?? models[0] ?? null;

  if (thoughtValues.length === 0) {
    thoughtValues = thoughtValuesFromEfforts(currentLegacy?._meta?.reasoningEfforts);
  }
  if (thoughtValues.length === 0 && currentModel) {
    const encoded = thoughtFromModelId(currentModel);
    if (encoded) {
      thoughtValues = [
        { value: "low", effort: "low", name: "Low", description: "" },
        { value: "medium", effort: "medium", name: "Medium", description: "" },
        { value: "high", effort: "high", name: "High", description: "" },
        { value: "xhigh", effort: "xhigh", name: "Xhigh", description: "" },
        { value: "max", effort: "max", name: "Max", description: "" },
      ];
    }
  }
  if (thoughtValues.length === 0 && payload.modes?.availableModes?.length) {
    const modeThoughts = payload.modes.availableModes.flatMap((mode) => {
      const effort = mapAcpReasoningEffort(mode.id) ?? mapAcpReasoningEffort(mode.name);
      return effort ? [{ value: mode.id, effort, name: mode.name, description: mode.description ?? "" }] : [];
    });
    if (modeThoughts.length === payload.modes.availableModes.length) {
      thoughtValues = modeThoughts;
    }
  }

  const currentThoughtValue = thoughtOption
    ? optionCurrentValue(thoughtOption)
    : currentLegacy?._meta?.reasoningEffort
      ?? thoughtFromModelId(currentModel ?? "")?.value
      ?? payload.modes?.currentModeId
      ?? null;
  const currentThought = thoughtValues.find((entry) => entry.value === currentThoughtValue)
    ?? thoughtValues.find((entry) => entry.effort === mapAcpReasoningEffort(currentThoughtValue))
    ?? null;
  const defaultReasoningEffort = currentThought?.effort
    ?? thoughtValues.find((entry) => entry.effort)?.effort
    ?? null;
  models = attachThoughtToModels(models, thoughtValues, defaultReasoningEffort);

  const modelContextWindow = parseContextTokens(currentLegacy?._meta?.totalContextTokens)
    ?? parseContextTokens(parseModelIdParams(currentModel ?? "").params.context)
    ?? null;

  return {
    options: list,
    models,
    model: currentModel,
    reasoningEffort: defaultReasoningEffort,
    modelConfigId: modelOption?.id ?? null,
    thoughtConfigId: thoughtOption?.id ?? null,
    thoughtValues,
    modelWrite: modelOption ? "config" : (legacyModels?.availableModels?.length ? "set_model" : null),
    thoughtWrite: thoughtOption
      ? "config"
      : (thoughtValues.length > 0 && currentLegacy?._meta?.reasoningEfforts?.length ? "set_mode" : (
        thoughtFromModelId(currentModel ?? "") ? "model_id" : (
          thoughtValues.length > 0 && payload.modes?.availableModes?.length ? "set_mode" : null
        )
      )),
    modelContextWindow,
    legacyModels,
  };
}

export function resolveAcpThoughtValue(
  config: AcpSessionConfig,
  requested: string | null | undefined,
): string | null {
  if (requested === undefined) {
    return null;
  }
  if (requested === null || requested.trim() === "") {
    const auto = config.thoughtValues.find((entry) => entry.effort === null);
    return auto?.value ?? null;
  }
  const effort = mapAcpReasoningEffort(requested);
  const byEffort = effort
    ? config.thoughtValues.find((entry) => entry.effort === effort)
    : null;
  if (byEffort) {
    return byEffort.value;
  }
  const raw = requested.trim();
  return config.thoughtValues.find((entry) => entry.value === raw || entry.name === raw)?.value ?? null;
}

export function rewriteModelIdForEffort(modelId: string, effort: string) {
  return rewriteModelIdEffort(modelId, effort);
}

export function withCurrentModel(payload: AcpSessionPayload, modelId: string): AcpSessionPayload {
  if (!payload.models) {
    return payload;
  }
  return {
    ...payload,
    models: {
      ...payload.models,
      currentModelId: modelId,
    },
  };
}

export function mapAcpUsageUpdate(
  update: Pick<acp.UsageUpdate, "used" | "size">,
  updatedAt = new Date().toISOString(),
): ThreadContextUsage {
  const used = Number.isFinite(update.used) ? Math.max(0, update.used) : 0;
  const size = Number.isFinite(update.size) ? Math.max(0, update.size) : 0;
  if (size <= 0) {
    return unavailableContextUsage(updatedAt);
  }
  const remaining = Math.max(size - used, 0);
  return {
    availability: "available",
    tokensInContextWindow: used,
    modelContextWindow: size,
    remainingPercent: Math.max(0, Math.min(100, Math.round((remaining / size) * 100))),
    updatedAt,
  };
}
