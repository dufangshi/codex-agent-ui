import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentBackendToolboxItemSchemaDto,
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
  auth?: AuthPayload;
  cwd?: string;
  root?: string;
  status: AgentRuntimeStatusDto;
  threads: ThreadDto[];
  detail: ThreadDetailDto | null;
  modelOptions?: ModelOptionDto[];
}

interface AuthPayload {
  harnessId: string;
  displayName: string;
  status: "starting" | "authenticated" | "required" | "unknown";
  methods: string[];
  error: string | null;
  login: {
    available: boolean;
    status: "idle" | "running" | "succeeded" | "failed";
    output: string;
    urls: string[];
    deviceCode: string | null;
    error: string | null;
  };
}

const loginToolboxItems: AgentBackendToolboxItemSchemaDto[] = [{
  action: "prompt",
  command: "/login",
  label: "Sign in",
  description: "Authenticate this harness in the current host environment.",
}];

function AuthPanel({
  auth,
  input,
  onInputChange,
  onStart,
  onSubmitInput,
  onCancel,
}: {
  auth: AuthPayload;
  input: string;
  onInputChange: (value: string) => void;
  onStart: () => void;
  onSubmitInput: () => void;
  onCancel: () => void;
}) {
  const running = auth.login.status === "running";
  return (
    <section className="w-full border-b border-[var(--theme-border)] bg-[var(--theme-bg)] px-5 py-4 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--theme-fg)]">
              {running ? `Signing in to ${auth.displayName}` : `${auth.displayName} needs sign-in`}
            </p>
            <p className="mt-1 text-xs text-[var(--theme-fg-muted)]">
              {auth.login.error ?? auth.error ?? "Start the OAuth flow, then complete it in your browser."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <button type="button" onClick={onCancel} className="rounded-md border border-[var(--theme-border)] px-3 py-2 text-sm text-[var(--theme-fg)] hover:bg-[var(--theme-hover)]">
                Cancel
              </button>
            ) : null}
            {!running ? (
              <button type="button" disabled={!auth.login.available} onClick={onStart} className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-45">
                {auth.login.status === "failed" ? "Retry login" : "Start login"}
              </button>
            ) : null}
          </div>
        </div>
        {auth.login.urls.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {auth.login.urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer" className="break-all text-sm text-sky-400 underline underline-offset-2">
                Open authorization page
              </a>
            ))}
            {auth.login.deviceCode ? (
              <code className="rounded bg-[var(--theme-muted)] px-2 py-1 text-sm text-[var(--theme-fg)]">{auth.login.deviceCode}</code>
            ) : null}
          </div>
        ) : null}
        {running ? (
          <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); onSubmitInput(); }}>
            <input value={input} onChange={(event) => onInputChange(event.target.value)} placeholder="Paste authorization code or response" className="min-w-0 flex-1 rounded-md border border-[var(--theme-border)] bg-[var(--theme-muted)] px-3 py-2 text-sm text-[var(--theme-fg)] outline-none focus:border-[var(--theme-accent-border)]" />
            <button type="submit" disabled={!input.trim()} className="rounded-md border border-[var(--theme-border)] px-3 py-2 text-sm text-[var(--theme-fg)] hover:bg-[var(--theme-hover)] disabled:opacity-45">
              Submit
            </button>
          </form>
        ) : null}
        {auth.login.output ? (
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 p-3 text-xs leading-5 text-[var(--theme-fg-muted)]">{auth.login.output}</pre>
        ) : null}
      </div>
    </section>
  );
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
  const [authInput, setAuthInput] = useState("");

  const applyState = useCallback((payload: StatePayload) => {
    const displayName = payload.auth?.displayName ?? "ACP agent";
    setState(payload);
    setError(payload.detail || payload.auth?.status === "required"
      ? null
      : payload.ready
        ? `${displayName} is starting…`
        : `Connecting to ${displayName}…`);
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

  const startLogin = useCallback(async () => {
    setError(null);
    try {
      applyState(await api<StatePayload>("api/auth/login", { method: "POST", body: "{}" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [applyState]);

  const submitLoginInput = useCallback(async () => {
    const value = authInput.trim();
    if (!value) return;
    try {
      applyState(await api<StatePayload>("api/auth/input", {
        method: "POST",
        body: JSON.stringify({ value }),
      }));
      setAuthInput("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [applyState, authInput]);

  const cancelLogin = useCallback(async () => {
    applyState(await api<StatePayload>("api/auth/cancel", { method: "POST", body: "{}" }));
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
  const showAuth = Boolean(state?.auth && (
    state.auth.status === "required"
    || state.auth.login.status === "running"
    || state.auth.login.status === "failed"
  ));
  const authPanel = state?.auth && showAuth ? (
    <AuthPanel
      auth={state.auth}
      input={authInput}
      onInputChange={setAuthInput}
      onStart={() => { void startLogin(); }}
      onSubmitInput={() => { void submitLoginInput(); }}
      onCancel={() => { void cancelLogin(); }}
    />
  ) : null;

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
            authPanel ?? (
              <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-[var(--theme-fg-muted)]">
                Starting {state?.auth?.displayName ?? "ACP agent"}…
              </div>
            )
          }
          beforeTimelineContent={authPanel}
          workspaceFeatures={{
            workspace: false,
            toolUsage: false,
            guide: false,
            threadGraph: false,
            extensions: false,
          }}
          composerProps={{
            disabled: busy || !detail,
            toolboxItems: state?.auth ? loginToolboxItems : [],
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
