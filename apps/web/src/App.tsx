import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentProviderCapabilitiesDto,
  AgentRuntimeStatusDto,
  ModelOptionDto,
  ThreadDetailDto,
  ThreadDto,
  UpdateThreadSettingsInput,
} from "@remote-codex/shared";
import {
  AppShellNavContext,
  PluginProvider,
  ThreadDetailSurface,
  type AppShellNavContextValue,
  type ThreadDetailUiAdapter,
} from "@remote-codex/thread-ui";

import { api, connectEvents } from "./api";

interface StatePayload {
  ready: boolean;
  cwd?: string;
  root?: string;
  status: AgentRuntimeStatusDto;
  threads: ThreadDto[];
  detail: ThreadDetailDto | null;
  modelOptions?: ModelOptionDto[];
}

const capabilities: AgentProviderCapabilitiesDto = {
  sessions: { list: false, read: true, resume: false, importLocal: false },
  turns: { start: true, streamInput: false, steer: false, interrupt: true, compact: false },
  branching: { fork: false, hardRollback: false, resumeAt: false, rewindFiles: false },
  controls: {
    planMode: false,
    permissionRequests: false,
    sandboxMode: false,
    performanceMode: false,
    goals: false,
  },
  management: {
    models: true,
    mcpStatus: false,
    skills: false,
    hooks: false,
    hookTrust: false,
    hostConfigFiles: false,
    providerSettings: false,
  },
  usage: { contextWindow: true, tokenUsage: true, costUsd: false },
};

export function App() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const applyState = useCallback((payload: StatePayload) => {
    setState(payload);
    setError(payload.detail ? null : payload.ready ? "Codex is starting…" : "Connecting to Codex…");
  }, []);

  useEffect(() => {
    let disposed = false;
    void api<StatePayload>("api/state")
      .then((payload) => {
        if (!disposed) {
          applyState(payload);
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    const socket = connectEvents((data) => {
      if (disposed || !data || typeof data !== "object" || (data as { type?: string }).type !== "state") {
        return;
      }
      applyState(data as StatePayload);
    });
    return () => {
      disposed = true;
      socket.close();
    };
  }, [applyState]);

  const sendPrompt = useCallback(async (input: { prompt: string }) => {
    const prompt = input.prompt.trim();
    if (!prompt) {
      return false;
    }
    setBusy(true);
    try {
      const payload = await api<StatePayload>("api/prompt", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      applyState(payload);
      setDraft("");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }, [applyState]);

  const interrupt = useCallback(async () => {
    await api<StatePayload>("api/interrupt", { method: "POST" });
  }, []);

  const updateSettings = useCallback(async (input: UpdateThreadSettingsInput) => {
    setSettingsBusy(true);
    try {
      const payload = await api<StatePayload>("api/settings", {
        method: "POST",
        body: JSON.stringify({
          model: input.model,
          reasoningEffort: input.reasoningEffort,
        }),
      });
      applyState(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setSettingsBusy(false);
    }
  }, [applyState]);

  const adapter = useMemo<ThreadDetailUiAdapter>(
    () => ({
      openThread: () => {},
      sendPrompt,
      interrupt,
      updateSettings,
    }),
    [interrupt, sendPrompt, updateSettings],
  );

  const nav = useMemo<AppShellNavContextValue>(
    () => ({
      navOpen: false,
      openNav: () => {},
      toggleNav: () => {},
      closeNav: () => {},
      settingsOpen: false,
      openSettings: () => {},
      closeSettings: () => {},
      themeMode: "dark",
      setThemeMode: () => {},
      effectiveTheme: "dark",
      defaultBackend: "codex",
      setDefaultBackend: () => {},
      autoCollapseCompletedTurns: true,
      setAutoCollapseCompletedTurns: () => {},
    }),
    [],
  );

  const detail = state?.detail ?? null;
  const canInterrupt = detail?.thread.status === "running";

  return (
    <div className="flex h-full min-h-0 flex-col">
    <AppShellNavContext.Provider value={nav}>
      <PluginProvider builtinPlugins={[]}>
        <ThreadDetailSurface
          hideRoomsRail
          threads={state?.threads ?? []}
          detail={detail}
          loading={!state}
          error={error}
          status={state?.status ?? null}
          capabilities={capabilities}
          adapter={adapter}
          currentThreadId={detail?.thread.id}
          currentWorkspaceId={detail?.workspace.id}
          currentWorkspaceLabel={detail?.workspace.label ?? "Codex"}
          activeView="chat"
          emptyContent={
            <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-[var(--theme-fg-muted)]">
              Starting Codex…
            </div>
          }
          workspaceFeatures={{
            workspace: false,
            toolUsage: false,
            guide: false,
            threadGraph: false,
            extensions: false,
          }}
          composerProps={{
            disabled: busy || !detail,
            settingsBusy,
            draftPrompt: draft,
            onDraftChange: (value) => {
              const next = typeof value === "function" ? value({ prompt: draft, attachments: [] }) : value;
              setDraft(typeof next === "string" ? next : next.prompt);
            },
            model: detail?.thread.model,
            reasoningEffort: detail?.thread.reasoningEffort,
            modelOptions: state?.modelOptions ?? [],
            contextUsage: detail?.thread.contextUsage,
            capabilities,
            collaborationMode: "default",
            canInterrupt,
            onInterrupt: interrupt,
            onUpdateSettings: updateSettings,
            followTail,
            onToggleFollow: () => setFollowTail(true),
            hideSandboxModeControl: true,
          }}
        />
      </PluginProvider>
    </AppShellNavContext.Provider>
    </div>
  );
}
