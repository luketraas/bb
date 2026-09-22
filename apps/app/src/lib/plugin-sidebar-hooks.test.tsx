// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { memo, useEffect } from "react";
import { getDefaultStore } from "jotai";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  SidebarThreadDataProvider,
  useSidebarThreadActions,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadEntry,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut,
  useSidebarThreads,
} from "./plugin-sidebar-hooks";
import {
  clearPluginThreadRowStatuses,
  setPluginThreadRowStatus,
} from "./plugin-thread-row-status";
import { useEnvironmentProviders } from "./plugin-sdk-hooks";
import { SidebarThreadShortcutKeysContext } from "@/components/sidebar/sidebarThreadShortcuts";

const actions = vi.hoisted(() => ({
  navigate: vi.fn(),
  setRootComposeProjectId: vi.fn(),
}));

type SidebarSection = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

const state = vi.hoisted(() => ({
  data: undefined as
    | {
        sections: SidebarSection[];
        projects: { id: string; name: string; threads: ThreadListEntry[] }[];
        personalProject: {
          id: string;
          name: string;
          threads: ThreadListEntry[];
        };
      }
    | undefined,
}));

const archiveQuery = vi.hoisted(() => ({
  data: undefined as { pages: ThreadListEntry[][] } | undefined,
  isLoadingError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage: vi.fn(async () => undefined),
}));
const archiveEnabled = vi.hoisted(() => vi.fn());
const derivations = vi.hoisted(() => ({ navigation: 0, archived: 0 }));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: (_filters: object, options: { enabled: boolean }) => {
    derivations.archived += 1;
    archiveEnabled(options.enabled);
    return archiveQuery;
  },
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => {
    derivations.navigation += 1;
    return { data: state.data, isError: false };
  },
}));

vi.mock("@/hooks/queries/host-queries", () => {
  const hosts: never[] = [];
  return { useHosts: () => ({ data: hosts }) };
});

vi.mock("@/components/thread/ThreadActionsProvider", () => {
  const threadActions = {
    archiveThreadAndChildren: vi.fn(),
    requestDelete: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
  };
  return { useThreadActions: () => threadActions };
});

vi.mock("@/hooks/mutations/thread-state-mutations", () => {
  const updateThread = { mutateAsync: vi.fn(async () => undefined) };
  return { useUpdateThread: () => updateThread };
});

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => actions.navigate,
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("./root-compose-selection", () => ({
  useSetRootComposeProjectId: () => actions.setRootComposeProjectId,
}));

const environmentProviders = vi.hoisted(() => ({
  providers: undefined as readonly Record<string, unknown>[] | undefined,
}));

vi.mock("@/hooks/queries/environment-provider-queries", () => ({
  useSystemEnvironmentProviders: () => ({
    providers: environmentProviders.providers,
  }),
}));

const drafts = vi.hoisted(() => ({
  threadIds: new Set<string>(),
  listeners: new Set<() => void>(),
  notify() {
    for (const listener of drafts.listeners) listener();
  },
}));

vi.mock("@/hooks/usePromptDraftStorage", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    drafts.listeners.add(listener);
    return () => drafts.listeners.delete(listener);
  };
  return {
    usePromptDraftHasInput: (scope: { threadId: string }) =>
      useSyncExternalStore(subscribe, () =>
        drafts.threadIds.has(scope.threadId),
      ),
    usePromptDraftInputThreadIds: (threads: readonly { id: string }[]) => {
      const snapshot = useSyncExternalStore(subscribe, () =>
        threads
          .map((thread) => (drafts.threadIds.has(thread.id) ? "1" : "0"))
          .join(""),
      );
      return new Set(
        threads.filter((_, index) => snapshot[index] === "1").map((t) => t.id),
      );
    },
  };
});

function payload(threads: ThreadListEntry[], sections: SidebarSection[] = []) {
  return {
    sections,
    projects: [{ id: "proj_app", name: "App", threads }],
    personalProject: { id: PERSONAL_PROJECT_ID, name: "Personal", threads: [] },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  derivations.navigation = 0;
  derivations.archived = 0;
  state.data = undefined;
  archiveQuery.data = undefined;
  archiveQuery.isLoadingError = false;
  archiveQuery.hasNextPage = false;
  archiveQuery.isFetchingNextPage = false;
  archiveQuery.isFetchNextPageError = false;
  drafts.threadIds.clear();
  clearPluginThreadRowStatuses("plugin-a");
  environmentProviders.providers = undefined;
});

describe("useSidebarThreads", () => {
  it("keeps DTO identity for entries that did not change across a sidebar update", () => {
    const stable = makeThreadListEntry({ id: "thr_stable", title: "Stable" });
    const changing = makeThreadListEntry({ id: "thr_changing", title: "One" });
    state.data = payload([stable, changing]);
    const { result, rerender } = renderHook(() => useSidebarThreads());
    const before = result.current.threads;
    expect(before.map((thread) => thread.id)).toEqual([
      "thr_stable",
      "thr_changing",
    ]);

    state.data = payload([
      stable,
      makeThreadListEntry({ id: "thr_changing", title: "Two" }),
    ]);
    rerender();
    const after = result.current.threads;
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.title).toBe("Two");
  });

  it("shares DTO identity between two consumers of the same payload", () => {
    const stable = makeThreadListEntry({ id: "thr_stable", title: "Stable" });
    state.data = payload([stable]);
    const first = renderHook(() => useSidebarThreads());
    const second = renderHook(() => useSidebarThreads());
    expect(second.result.current.threads[0]).toBe(
      first.result.current.threads[0],
    );
    const before = first.result.current.threads[0];
    first.rerender();
    second.rerender();
    expect(first.result.current.threads[0]).toBe(before);
    expect(second.result.current.threads[0]).toBe(before);
  });
});

describe("sidebar lifecycle selection", () => {
  it("keeps active reads archive-free and selects archived, both, and active again", async () => {
    const active = makeThreadListEntry({ id: "thr_active", archivedAt: null });
    const archived = makeThreadListEntry({
      id: "thr_archived",
      archivedAt: 42,
    });
    state.data = payload([active, archived]);
    archiveQuery.data = { pages: [[archived, active], [archived]] };
    archiveQuery.hasNextPage = true;
    const { result, rerender } = renderHook(
      ({ lifecycles }: { lifecycles: ("active" | "archived")[] }) =>
        useSidebarThreads({ experimental_lifecycles: lifecycles }),
      { initialProps: { lifecycles: ["active"] } },
    );
    expect(archiveEnabled).toHaveBeenLastCalledWith(false);
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      active.id,
    ]);
    expect(result.current.experimental_archived).toBeNull();
    rerender({ lifecycles: ["archived"] });
    expect(archiveEnabled).toHaveBeenLastCalledWith(true);
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      archived.id,
    ]);
    expect(result.current.experimental_archived?.hasNextPage).toBe(true);
    await result.current.experimental_archived?.fetchNextPage();
    expect(archiveQuery.fetchNextPage).toHaveBeenCalledOnce();
    rerender({ lifecycles: ["active", "archived"] });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      archived.id,
      active.id,
    ]);
    rerender({ lifecycles: ["active"] });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      active.id,
    ]);
  });

  it("reports archive loading and errors without hiding active rows in a combined view", () => {
    state.data = payload([makeThreadListEntry({ archivedAt: null })]);
    const { result, rerender } = renderHook(
      ({ lifecycles }: { lifecycles: ("active" | "archived")[] }) =>
        useSidebarThreads({ experimental_lifecycles: lifecycles }),
      { initialProps: { lifecycles: ["archived"] } },
    );
    expect(result.current.status).toBe("loading");
    archiveQuery.isLoadingError = true;
    rerender({ lifecycles: ["archived"] });
    expect(result.current.status).toBe("error");
    rerender({ lifecycles: ["active", "archived"] });
    expect(result.current.status).toBe("ready");
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.experimental_archived?.status).toBe("error");
  });

  it("resolves archived entries for host-owned row actions and status", () => {
    const archived = makeThreadListEntry({
      id: "thr_archived",
      archivedAt: 42,
    });
    state.data = payload([]);
    archiveQuery.data = { pages: [[archived]] };
    const { result } = renderHook(() => useSidebarThreadEntry(archived.id));
    expect(result.current).toBe(archived);
  });
});

describe("useSidebarThreads sections", () => {
  it("passes the bootstrap sections through in server order", () => {
    const sections = [
      { id: "sec_later", name: "Later", createdAt: 1, updatedAt: 1 },
      { id: "sec_slop", name: "Slop Cop", createdAt: 2, updatedAt: 2 },
    ];
    state.data = payload([], sections);
    const { result } = renderHook(() => useSidebarThreads());
    expect(result.current.sections).toEqual(sections);
  });

  it("gives each project its compose and settings hrefs", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreads());
    expect(result.current.projects).toEqual([
      {
        id: "proj_app",
        name: "App",
        isPersonal: false,
        href: "/projects/proj_app",
        settingsHref: "/settings/projects/proj_app",
      },
      {
        id: PERSONAL_PROJECT_ID,
        name: "Personal",
        isPersonal: true,
        href: "/",
        settingsHref: `/settings/projects/${PERSONAL_PROJECT_ID}`,
      },
    ]);
  });

  it("reports an empty section list while loading", () => {
    const { result } = renderHook(() => useSidebarThreads());
    expect(result.current.status).toBe("loading");
    expect(result.current.sections).toEqual([]);
  });
});

describe("useSidebarThreadActions", () => {
  it("opens a project composer without a legacy route transition", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        projectId: "proj_target",
        focusPrompt: true,
      });
    });

    expect(actions.setRootComposeProjectId).toHaveBeenCalledWith("proj_target");
    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: { focusPrompt: true },
    });
  });

  it("files a new thread under a section the way bb's section menu does", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        projectId: PERSONAL_PROJECT_ID,
        sectionId: "sec_later",
        focusPrompt: true,
      });
    });

    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: { focusPrompt: true, sectionId: "sec_later" },
    });
  });

  it("reuses an environment the way bb's environment header does", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.openNewThread({
        projectId: "proj_app",
        environmentId: "env_1",
      });
    });

    expect(actions.navigate).toHaveBeenCalledWith("/", {
      state: { reuseEnvironmentId: "env_1" },
    });
  });

  it("navigates with no router state when no option is set", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());
    act(() => {
      result.current.openNewThread();
    });
    expect(actions.navigate).toHaveBeenCalledWith("/", undefined);
  });

  it("re-expands a collapsed conversation when opening its thread", () => {
    const thread = makeThreadListEntry({ id: "thr_1", projectId: "proj_app" });
    state.data = payload([thread]);
    const store = getDefaultStore();
    const collapsedAtom = getThreadConversationCollapsedAtom("thr_1");
    store.set(collapsedAtom, true);
    const { result } = renderHook(() => useSidebarThreadActions());

    act(() => {
      result.current.open("thr_1");
    });

    expect(store.get(collapsedAtom)).toBe(false);
    expect(actions.navigate).toHaveBeenCalledWith(
      "/projects/proj_app/threads/thr_1",
    );
  });

  it("ignores open for an unknown thread", () => {
    state.data = payload([]);
    const { result } = renderHook(() => useSidebarThreadActions());
    act(() => {
      result.current.open("thr_missing");
    });
    expect(actions.navigate).not.toHaveBeenCalled();
  });
});

describe("per-row client state hooks", () => {
  it("reports an unsent draft for a known thread and false otherwise", () => {
    const thread = makeThreadListEntry({ id: "thr_1", projectId: "proj_app" });
    state.data = payload([thread]);
    drafts.threadIds.add("thr_1");
    drafts.threadIds.add("thr_unknown");

    const known = renderHook(() => useSidebarThreadDraft("thr_1"));
    const unknown = renderHook(() => useSidebarThreadDraft("thr_unknown"));
    expect(known.result.current.hasUnsubmittedDraft).toBe(true);
    expect(unknown.result.current.hasUnsubmittedDraft).toBe(false);

    act(() => {
      drafts.threadIds.delete("thr_1");
      drafts.notify();
    });
    expect(known.result.current.hasUnsubmittedDraft).toBe(false);
  });

  it("collects every sidebar thread holding a draft", () => {
    state.data = payload([
      makeThreadListEntry({ id: "thr_1", projectId: "proj_app" }),
      makeThreadListEntry({ id: "thr_2", projectId: "proj_app" }),
    ]);
    drafts.threadIds.add("thr_2");
    const { result } = renderHook(() => useSidebarThreadDraftIds());
    expect([...result.current]).toEqual(["thr_2"]);

    act(() => {
      drafts.threadIds.add("thr_1");
      drafts.notify();
    });
    expect([...result.current].sort()).toEqual(["thr_1", "thr_2"]);
  });

  it("reads and tracks a row status set by another plugin", () => {
    const { result } = renderHook(() => useSidebarThreadRowStatus("thr_1"));
    expect(result.current).toBeNull();

    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", {
        icon: "Loading",
        label: "Drafting",
        tone: "running",
      });
    });
    expect(result.current).toEqual({
      icon: "Loading",
      label: "Drafting",
      tone: "running",
    });

    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", null);
    });
    expect(result.current).toBeNull();
  });

  it("collects every row status for group rollups and keeps identity while unchanged", () => {
    const { result } = renderHook(() => useSidebarThreadRowStatuses());
    expect(result.current.size).toBe(0);
    const initial = result.current;
    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", {
        icon: "Loading",
        label: "Drafting",
      });
      setPluginThreadRowStatus("thr_2", "plugin-a", {
        icon: "Check",
        label: "Done",
        tone: "success",
      });
    });
    expect([...result.current.keys()].sort()).toEqual(["thr_1", "thr_2"]);
    expect(result.current.get("thr_2")?.tone).toBe("success");
    const settled = result.current;
    act(() => {});
    expect(result.current).toBe(settled);
    act(() => {
      setPluginThreadRowStatus("thr_1", "plugin-a", null);
      setPluginThreadRowStatus("thr_2", "plugin-a", null);
    });
    expect(result.current.size).toBe(0);
    expect(result.current).toBe(initial);
  });

  it("reports the assigned shortcut only while the host provides one", () => {
    const withoutProvider = renderHook(() => useSidebarThreadShortcut("thr_1"));
    expect(withoutProvider.result.current).toBeNull();

    const keys = new Map([
      ["thr_1", { label: "⌘1", ariaKeyshortcuts: "Meta+1" }],
    ]);
    const { result } = renderHook(() => useSidebarThreadShortcut("thr_1"), {
      wrapper: ({ children }) => (
        <SidebarThreadShortcutKeysContext.Provider value={keys}>
          {children}
        </SidebarThreadShortcutKeysContext.Provider>
      ),
    });
    expect(result.current).toEqual({ label: "⌘1", ariaKeyshortcuts: "Meta+1" });
    const other = renderHook(() => useSidebarThreadShortcut("thr_2"), {
      wrapper: ({ children }) => (
        <SidebarThreadShortcutKeysContext.Provider value={keys}>
          {children}
        </SidebarThreadShortcutKeysContext.Provider>
      ),
    });
    expect(other.result.current).toBeNull();
  });
});

describe("useEnvironmentProviders", () => {
  it("reports loading until the catalog resolves, then a narrowed row per provider", () => {
    const { result, rerender } = renderHook(() => useEnvironmentProviders());
    expect(result.current).toEqual({ status: "loading", providers: [] });

    environmentProviders.providers = [
      {
        id: "git-worktree",
        displayName: "Git worktree",
        description: "A worktree per thread",
        icon: "GitBranch",
        logoUrl: null,
        pluginId: "environment-git-worktree",
        machineProviderId: null,
        requires: {},
        inputs: null,
        acceptsEmptyInputs: true,
        availability: null,
        machineAvailability: {},
      },
    ];
    rerender();
    expect(result.current).toEqual({
      status: "ready",
      providers: [
        {
          id: "git-worktree",
          displayName: "Git worktree",
          description: "A worktree per thread",
          icon: "GitBranch",
          logoUrl: null,
          pluginId: "environment-git-worktree",
          machineProviderId: null,
        },
      ],
    });
  });
});

describe("SidebarThreadDataProvider", () => {
  interface RowObservation {
    entryId: string | null;
    hasDraft: boolean;
    projectName: string | undefined;
    actions: unknown;
  }

  function RowProbe({
    threadId,
    onObserve,
  }: {
    threadId: string;
    onObserve: (observation: RowObservation) => void;
  }) {
    const actions = useSidebarThreadActions();
    const entry = useSidebarThreadEntry(threadId);
    const draft = useSidebarThreadDraft(threadId);
    const { projects } = useSidebarThreads();
    onObserve({
      entryId: entry?.id ?? null,
      hasDraft: draft.hasUnsubmittedDraft,
      projectName: projects.find((project) => project.id === "proj_app")?.name,
      actions,
    });
    return null;
  }

  function renderRows(threads: ThreadListEntry[]) {
    const observations: RowObservation[] = [];
    const build = () => (
      <SidebarThreadDataProvider>
        {threads.map((thread) => (
          <RowProbe
            key={thread.id}
            threadId={thread.id}
            onObserve={(observation) => observations.push(observation)}
          />
        ))}
      </SidebarThreadDataProvider>
    );
    const view = render(build());
    return {
      observations,
      rerender: () => view.rerender(build()),
    };
  }

  function ArchivedConsumer({
    onState,
  }: {
    onState?: (state: ReturnType<typeof useSidebarThreads>) => void;
  }) {
    const state = useSidebarThreads({
      experimental_lifecycles: ["archived"],
    });
    onState?.(state);
    return null;
  }

  function renderArchivedTree(options?: {
    consumers?: number;
    onState?: (state: ReturnType<typeof useSidebarThreads>) => void;
  }) {
    const build = (consumers: number) => (
      <SidebarThreadDataProvider>
        {Array.from({ length: consumers }, (_, index) => (
          <ArchivedConsumer key={index} onState={options?.onState} />
        ))}
      </SidebarThreadDataProvider>
    );
    const view = render(build(options?.consumers ?? 1));
    return {
      view,
      rerenderConsumers: (consumers: number) => view.rerender(build(consumers)),
    };
  }

  it("derives sidebar-wide data once for many rows and keeps each row correct", () => {
    const threads = Array.from({ length: 40 }, (_, index) =>
      makeThreadListEntry({
        id: `thr_${index}`,
        projectId: "proj_app",
        title: `Thread ${index}`,
      }),
    );
    state.data = payload(threads);
    drafts.threadIds.add("thr_7");

    const { observations } = renderRows(threads);

    expect(derivations.navigation).toBe(1);
    expect(derivations.archived).toBe(1);
    expect(observations).toHaveLength(threads.length);
    expect(observations.every((row) => row.entryId !== null)).toBe(true);
    expect(observations.map((row) => row.entryId)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(observations.filter((row) => row.hasDraft)).toHaveLength(1);
    expect(observations[7]?.hasDraft).toBe(true);
    expect(observations[0]?.hasDraft).toBe(false);
    expect(observations.every((row) => row.projectName === "App")).toBe(true);
    expect(new Set(observations.map((row) => row.actions)).size).toBe(1);
  });

  it("shares one actions identity across rerenders while the data is unchanged", () => {
    const threads = [makeThreadListEntry({ id: "thr_1", projectId: "proj_app" })];
    state.data = payload(threads);
    const { observations, rerender } = renderRows(threads);
    const first = observations[0]?.actions;
    expect(derivations.navigation).toBe(1);
    rerender();
    expect(derivations.navigation).toBe(2);
    expect(observations[observations.length - 1]?.actions).toBe(first);
  });

  it("falls back to per-hook derivation outside the provider", () => {
    state.data = payload([makeThreadListEntry({ id: "thr_1" })]);
    renderHook(() => useSidebarThreads());
    renderHook(() => useSidebarThreadEntry("thr_1"));
    expect(derivations.navigation).toBe(2);
    expect(derivations.archived).toBe(2);
  });

  it("keeps the archived query off until a consumer asks and releases it after", () => {
    state.data = payload([]);
    const { rerenderConsumers } = renderArchivedTree({ consumers: 0 });
    expect(archiveEnabled).toHaveBeenLastCalledWith(false);

    rerenderConsumers(1);
    expect(archiveEnabled).toHaveBeenLastCalledWith(true);

    rerenderConsumers(0);
    expect(archiveEnabled).toHaveBeenLastCalledWith(false);
  });

  it("keeps the archived query on while any consumer still holds it", () => {
    state.data = payload([]);
    const { rerenderConsumers } = renderArchivedTree({ consumers: 2 });
    expect(archiveEnabled).toHaveBeenLastCalledWith(true);

    rerenderConsumers(1);
    expect(archiveEnabled).toHaveBeenLastCalledWith(true);

    rerenderConsumers(0);
    expect(archiveEnabled).toHaveBeenLastCalledWith(false);
  });

  it("reports ready on the first frame when archived data is already cached", () => {
    const archived = makeThreadListEntry({
      id: "thr_archived",
      archivedAt: 42,
    });
    state.data = payload([]);
    archiveQuery.data = { pages: [[archived]] };
    archiveQuery.hasNextPage = true;
    const seen: ReturnType<typeof useSidebarThreads>[] = [];

    renderArchivedTree({ consumers: 1, onState: (state) => seen.push(state) });

    expect(seen[0]?.experimental_archived?.status).toBe("ready");
    expect(seen[0]?.experimental_archived?.hasNextPage).toBe(true);
    expect(seen[0]?.threads.map((thread) => thread.id)).toEqual([archived.id]);
  });

  it("reports loading for an archived-only view with no data yet", () => {
    state.data = payload([]);
    const seen: ReturnType<typeof useSidebarThreads>[] = [];

    renderArchivedTree({ consumers: 1, onState: (state) => seen.push(state) });

    expect(seen[0]?.status).toBe("loading");
    expect(seen[0]?.experimental_archived?.status).toBe("loading");
    expect(seen[0]?.threads).toEqual([]);
  });

  it("passes archive paging flags through to the archived state", () => {
    state.data = payload([]);
    archiveQuery.data = { pages: [[]] };
    archiveQuery.hasNextPage = true;
    archiveQuery.isFetchingNextPage = true;
    archiveQuery.isFetchNextPageError = true;
    const seen: ReturnType<typeof useSidebarThreads>[] = [];

    renderArchivedTree({ consumers: 1, onState: (state) => seen.push(state) });

    expect(seen[0]?.experimental_archived).toMatchObject({
      hasNextPage: true,
      isFetchingNextPage: true,
      isFetchNextPageError: true,
    });
  });

  it("keeps state identity when a consumer passes an inline lifecycles array", () => {
    state.data = payload([]);
    const { result, rerender } = renderHook(
      () => useSidebarThreads({ experimental_lifecycles: ["archived"] }),
      {
        wrapper: ({ children }) => (
          <SidebarThreadDataProvider>{children}</SidebarThreadDataProvider>
        ),
      },
    );
    const before = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(before);
  });

  it("does not re-render a row that only reads entries and actions when paging flags change", () => {
    const renders = { list: 0, row: 0 };
    const RowOnly = memo(function RowOnly({
      threadId,
      onRender,
    }: {
      threadId: string;
      onRender: () => void;
    }) {
      useSidebarThreadActions();
      useSidebarThreadEntry(threadId);
      useEffect(() => {
        onRender();
      });
      return null;
    });
    function ListConsumer({ onRender }: { onRender: () => void }) {
      useSidebarThreads({ experimental_lifecycles: ["archived"] });
      useEffect(() => {
        onRender();
      });
      return null;
    }
    state.data = payload([
      makeThreadListEntry({ id: "thr_1", projectId: "proj_app" }),
    ]);
    archiveQuery.data = { pages: [[]] };
    const onListRender = () => {
      renders.list += 1;
    };
    const onRowRender = () => {
      renders.row += 1;
    };
    const tree = () => (
      <SidebarThreadDataProvider>
        <ListConsumer onRender={onListRender} />
        <RowOnly threadId="thr_1" onRender={onRowRender} />
      </SidebarThreadDataProvider>
    );
    const view = render(tree());
    renders.list = 0;
    renders.row = 0;

    archiveQuery.isFetchingNextPage = true;
    view.rerender(tree());

    expect(renders.list).toBeGreaterThan(0);
    expect(renders.row).toBe(0);
  });

  it("keeps an outside fallback consumer correct beside a mounted provider", () => {
    const threads = [
      makeThreadListEntry({ id: "thr_1", projectId: "proj_app" }),
      makeThreadListEntry({ id: "thr_2", projectId: "proj_app" }),
    ];
    state.data = payload(threads);
    const outside: { entryId: string | null; threadIds: string[] }[] = [];
    const inside: RowObservation[] = [];

    function OutsideConsumer() {
      const state = useSidebarThreads();
      const entry = useSidebarThreadEntry("thr_1");
      outside.push({
        entryId: entry?.id ?? null,
        threadIds: state.threads.map((thread) => thread.id),
      });
      return null;
    }

    render(
      <>
        <OutsideConsumer />
        <SidebarThreadDataProvider>
          <RowProbe
            threadId="thr_2"
            onObserve={(observation) => inside.push(observation)}
          />
        </SidebarThreadDataProvider>
      </>,
    );

    expect(outside[0]?.threadIds).toEqual(["thr_1", "thr_2"]);
    expect(outside[0]?.entryId).toBe("thr_1");
    expect(inside[0]?.entryId).toBe("thr_2");
    expect(inside[0]?.projectName).toBe("App");
    expect(derivations.navigation).toBe(3);
    expect(derivations.archived).toBe(3);
  });
});
