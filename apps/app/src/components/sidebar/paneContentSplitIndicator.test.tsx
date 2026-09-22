// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { LayoutNode, PaneContent, SplitLayout } from "@/lib/split-layout";
import { usePaneContentSplitIndicator } from "./paneContentSplitIndicator";

const { compactState } = vi.hoisted(() => ({
  compactState: { value: false },
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => compactState.value,
}));

function content(threadId: string): PaneContent {
  return { kind: "thread", projectId: "p1", threadId };
}

function pane(paneId: string, threadId: string): LayoutNode {
  return { type: "pane", paneId, content: content(threadId) };
}

function twoPanes(focused: string): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane("pane-1", "t1"), pane("pane-2", "t2")],
    },
    focusedPaneId: focused,
  };
}

function renderIndicatorFor(
  store: ReturnType<typeof createStore>,
  threadId: string,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  let renders = 0;
  const target = content(threadId);
  const { result } = renderHook(
    () => {
      renders += 1;
      return usePaneContentSplitIndicator(target, true);
    },
    { wrapper },
  );
  return { result, renderCount: () => renders };
}

function renderIndicator(threadId: string) {
  const store = createStore();
  store.set(splitLayoutAtom, twoPanes("pane-1"));
  return { store, ...renderIndicatorFor(store, threadId) };
}

function threePanes(focused: string): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [1 / 3, 1 / 3, 1 / 3],
      children: [
        pane("pane-1", "t1"),
        pane("pane-2", "t2"),
        pane("pane-3", "t3"),
      ],
    },
    focusedPaneId: focused,
  };
}

function twoPanesSized(leftFraction: number, focused: string): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [leftFraction, 1 - leftFraction],
      children: [pane("pane-1", "t1"), pane("pane-2", "t2")],
    },
    focusedPaneId: focused,
  };
}

beforeEach(() => {
  compactState.value = false;
});

describe("usePaneContentSplitIndicator", () => {
  it("does not re-render when the split layout changes on compact viewports", () => {
    compactState.value = true;
    const { store, result, renderCount } = renderIndicator("t1");
    expect(result.current.isOpenInSplit).toBe(false);
    const settled = renderCount();

    act(() => {
      store.set(splitLayoutAtom, twoPanes("pane-2"));
    });
    expect(renderCount()).toBe(settled);
    expect(result.current.isOpenInSplit).toBe(false);
  });

  it("follows the split layout on wide viewports", () => {
    const { store, result } = renderIndicator("t1");
    expect(result.current.isOpenInSplit).toBe(true);
    expect(result.current.miniMap?.find((slot) => slot.isMe)?.paneId).toBe(
      "pane-1",
    );
    act(() => {
      store.set(splitLayoutAtom, twoPanes("pane-2"));
    });
    expect(result.current.miniMap?.find((slot) => slot.isFocused)?.paneId).toBe(
      "pane-2",
    );
  });

  it("does not re-render when the layout is replaced with an equal value", () => {
    const store = createStore();
    store.set(splitLayoutAtom, threePanes("pane-1"));
    const row = renderIndicatorFor(store, "t1");
    const settled = row.renderCount();

    act(() => {
      store.set(splitLayoutAtom, threePanes("pane-1"));
    });

    expect(row.renderCount()).toBe(settled);
    expect(row.result.current.isOpenInSplit).toBe(true);
  });

  it("re-renders only the rows whose own split state changed when focus moves", () => {
    const store = createStore();
    store.set(splitLayoutAtom, threePanes("pane-1"));
    const losing = renderIndicatorFor(store, "t1");
    const gaining = renderIndicatorFor(store, "t2");
    const outside = renderIndicatorFor(store, "t9");

    expect(
      losing.result.current.miniMap?.find((slot) => slot.isMe)?.isFocused,
    ).toBe(true);
    expect(outside.result.current.isOpenInSplit).toBe(false);
    expect(outside.result.current.miniMap).toBeNull();
    const settledLosing = losing.renderCount();
    const settledGaining = gaining.renderCount();
    const settledOutside = outside.renderCount();

    act(() => {
      store.set(splitLayoutAtom, threePanes("pane-2"));
    });

    expect(losing.renderCount()).toBeGreaterThan(settledLosing);
    expect(gaining.renderCount()).toBeGreaterThan(settledGaining);
    expect(outside.renderCount()).toBe(settledOutside);
    expect(
      losing.result.current.miniMap?.find((slot) => slot.isMe)?.isFocused,
    ).toBe(false);
    expect(
      gaining.result.current.miniMap?.find((slot) => slot.isMe)?.isFocused,
    ).toBe(true);
  });

  it("re-renders when the pane geometry changes", () => {
    const store = createStore();
    store.set(splitLayoutAtom, twoPanesSized(0.5, "pane-1"));
    const row = renderIndicatorFor(store, "t1");
    const settled = row.renderCount();
    const before = row.result.current.miniMap ?? [];

    act(() => {
      store.set(splitLayoutAtom, twoPanesSized(0.3, "pane-1"));
    });

    expect(row.renderCount()).toBeGreaterThan(settled);
    const after = row.result.current.miniMap ?? [];
    expect(after.map((slot) => slot.rect)).not.toEqual(
      before.map((slot) => slot.rect),
    );
    expect(after.map((slot) => slot.isMe)).toEqual(
      before.map((slot) => slot.isMe),
    );
  });

  it("keeps mini-map geometry and membership while focus moves", () => {
    const store = createStore();
    store.set(splitLayoutAtom, threePanes("pane-1"));
    const row = renderIndicatorFor(store, "t1");
    const before = row.result.current.miniMap ?? [];

    act(() => {
      store.set(splitLayoutAtom, threePanes("pane-2"));
    });

    const after = row.result.current.miniMap ?? [];
    expect(after.map((slot) => slot.paneId)).toEqual(
      before.map((slot) => slot.paneId),
    );
    expect(after.map((slot) => slot.rect)).toEqual(
      before.map((slot) => slot.rect),
    );
    expect(after.map((slot) => slot.isMe)).toEqual(
      before.map((slot) => slot.isMe),
    );
    expect(after.map((slot) => slot.isFocused)).toEqual([false, true, false]);
  });
});
