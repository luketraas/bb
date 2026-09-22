// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SplitLayout } from "./split-layout";
import { splitLayoutAtom } from "./split-layout/atoms";
import {
  toPluginSidebarSplitLayout,
  useSidebarThreadSplit,
} from "./plugin-sidebar-split";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => false,
}));

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => navigate,
}));

vi.mock("./plugin-sidebar-hooks", async () => {
  const { makeThreadListEntry } =
    await import("@bb/test-helpers/domain-fixtures");
  const entries = new Map([
    [
      "thr_a",
      makeThreadListEntry({
        id: "thr_a",
        projectId: "proj_1",
        title: "Thread A",
      }),
    ],
    [
      "thr_b",
      makeThreadListEntry({
        id: "thr_b",
        projectId: "proj_1",
        title: "Thread B",
      }),
    ],
  ]);
  return {
    useSidebarThreadEntry: (threadId: string) => entries.get(threadId) ?? null,
  };
});

const twoPanes: SplitLayout = {
  root: {
    type: "split",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      {
        type: "pane",
        paneId: "pane_a",
        content: { kind: "thread", projectId: "proj_1", threadId: "thr_a" },
      },
      {
        type: "pane",
        paneId: "pane_b",
        content: { kind: "thread", projectId: "proj_1", threadId: "thr_b" },
      },
    ],
  },
  focusedPaneId: "pane_b",
};

function layoutWithThread(
  threadId: string | null,
  focusedPaneId: string,
): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "pane",
          paneId: "pane_a",
          content:
            threadId === null
              ? { kind: "new-thread" }
              : { kind: "thread", projectId: "proj_1", threadId },
        },
        {
          type: "pane",
          paneId: "pane_b",
          content: { kind: "new-thread" },
        },
      ],
    },
    focusedPaneId,
  };
}

function renderThreadSplit(
  store: ReturnType<typeof createStore>,
  threadId: string,
) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  let renders = 0;
  const { result } = renderHook(
    () => {
      renders += 1;
      return useSidebarThreadSplit(threadId);
    },
    { wrapper },
  );
  return { result, renderCount: () => renders };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("toPluginSidebarSplitLayout", () => {
  it("is null without a layout or with a single pane", () => {
    expect(toPluginSidebarSplitLayout(null)).toBeNull();
    expect(
      toPluginSidebarSplitLayout({
        root:
          twoPanes.root.type === "split"
            ? twoPanes.root.children[0]!
            : twoPanes.root,
        focusedPaneId: "pane_a",
      }),
    ).toBeNull();
  });

  it("lists every pane with its thread, rect, and focus", () => {
    const layout = toPluginSidebarSplitLayout(twoPanes);
    expect(layout?.panes.map((pane) => pane.threadId)).toEqual([
      "thr_a",
      "thr_b",
    ]);
    expect(layout?.panes.map((pane) => pane.isFocused)).toEqual([false, true]);
    const [left, right] = layout!.panes;
    expect(left!.rect.x).toBe(0);
    expect(left!.rect.width).toBeCloseTo(0.5);
    expect(right!.rect.x).toBeCloseTo(0.5);
    expect(left!.rect.height).toBe(1);
  });
});

describe("useSidebarThreadSplit", () => {
  it("does not re-render a thread that is not in the split when focus moves", () => {
    const store = createStore();
    store.set(splitLayoutAtom, layoutWithThread("thr_b", "pane_a"));
    const row = renderThreadSplit(store, "thr_a");
    expect(row.result.current.layout).toBeNull();
    const settled = row.renderCount();
    const before = row.result.current;

    act(() => {
      store.set(splitLayoutAtom, layoutWithThread("thr_b", "pane_b"));
    });

    expect(row.renderCount()).toBe(settled);
    expect(row.result.current).toBe(before);
    expect(row.result.current.layout).toBeNull();
  });

  it("re-renders and re-reports focus for a thread that is in the split", () => {
    const store = createStore();
    store.set(splitLayoutAtom, layoutWithThread("thr_b", "pane_a"));
    const row = renderThreadSplit(store, "thr_b");
    expect(
      row.result.current.layout?.panes.find((pane) => pane.isMe)?.isFocused,
    ).toBe(true);
    const settled = row.renderCount();

    act(() => {
      store.set(splitLayoutAtom, layoutWithThread("thr_b", "pane_b"));
    });

    expect(row.renderCount()).toBeGreaterThan(settled);
    expect(
      row.result.current.layout?.panes.find((pane) => pane.isMe)?.isFocused,
    ).toBe(false);
  });

  it("reports the null split for a thread the sidebar does not know", () => {
    const store = createStore();
    store.set(splitLayoutAtom, layoutWithThread("thr_b", "pane_a"));
    const row = renderThreadSplit(store, "thr_missing");

    expect(row.result.current).toEqual({
      splitProps: {},
      isAvailable: false,
      layout: null,
    });
  });
});
