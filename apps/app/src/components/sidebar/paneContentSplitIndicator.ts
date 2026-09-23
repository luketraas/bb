import { useMemo } from "react";
import { atom, useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import {
  computePaneRects,
  countPanes,
  listPanes,
  type PaneContent,
  type PaneRect,
  type SplitLayout,
} from "@/lib/split-layout";

export interface MiniMapSlot {
  paneId: string;
  rect: PaneRect;
  isMe: boolean;
  isFocused: boolean;
}

interface PaneContentSplitIndicator {
  isOpenInSplit: boolean;
  miniMap: MiniMapSlot[] | null;
}

const NO_INDICATOR: PaneContentSplitIndicator = {
  isOpenInSplit: false,
  miniMap: null,
};

// A disabled indicator must not subscribe to the persisted layout: mounting
// splitLayoutAtom re-reads storage and can replace the in-memory layout.
const NO_INDICATOR_ATOM = atom(NO_INDICATOR);

export interface ThreadSplitIndicatorTarget {
  id: string;
  projectId: string;
}

const FIELD_SEPARATOR = "\u0000";
const TARGET_SEPARATOR = "\u0001";

function paneContentMatchKey(content: PaneContent): string {
  switch (content.kind) {
    case "thread":
      return `thread${FIELD_SEPARATOR}${content.projectId}${FIELD_SEPARATOR}${content.threadId}`;
    case "plugin-panel":
      return `plugin-panel${FIELD_SEPARATOR}${content.pluginId}${FIELD_SEPARATOR}${content.panelPath}`;
    case "plugin-detail":
      return `plugin-detail${FIELD_SEPARATOR}${content.pluginId}`;
    case "new-thread":
      return "new-thread";
  }
}

function threadPaneMatchKey(projectId: string, threadId: string): string {
  return `${projectId}${FIELD_SEPARATOR}${threadId}`;
}

function threadMatchKey(thread: ThreadSplitIndicatorTarget): string {
  return threadPaneMatchKey(thread.projectId, thread.id);
}

function miniMapsEqual(
  a: readonly MiniMapSlot[] | null,
  b: readonly MiniMapSlot[] | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) return false;
    if (
      left.paneId !== right.paneId ||
      left.isMe !== right.isMe ||
      left.isFocused !== right.isFocused ||
      left.rect.x !== right.rect.x ||
      left.rect.y !== right.rect.y ||
      left.rect.w !== right.rect.w ||
      left.rect.h !== right.rect.h
    ) {
      return false;
    }
  }
  return true;
}

function indicatorsEqual(
  a: PaneContentSplitIndicator,
  b: PaneContentSplitIndicator,
): boolean {
  return (
    a.isOpenInSplit === b.isOpenInSplit && miniMapsEqual(a.miniMap, b.miniMap)
  );
}

function buildSplitIndicator(
  layout: SplitLayout,
  matchingPaneIds: ReadonlySet<string>,
): PaneContentSplitIndicator {
  if (matchingPaneIds.size === 0) {
    return NO_INDICATOR;
  }
  const rects = computePaneRects(layout.root);
  const miniMap: MiniMapSlot[] = listPanes(layout.root).flatMap((entry) => {
    const rect = rects.get(entry.paneId);
    return rect === undefined
      ? []
      : [
          {
            paneId: entry.paneId,
            rect,
            isMe: matchingPaneIds.has(entry.paneId),
            isFocused: entry.paneId === layout.focusedPaneId,
          },
        ];
  });
  return {
    isOpenInSplit: true,
    miniMap,
  };
}

function hasActiveSplit(
  layout: SplitLayout | null,
  isCompact: boolean,
): layout is SplitLayout {
  return layout !== null && !isCompact && countPanes(layout.root) >= 2;
}

function buildContentIndicator(
  layout: SplitLayout | null,
  contentKey: string,
  enabled: boolean,
  isCompact: boolean,
): PaneContentSplitIndicator {
  if (!enabled || !hasActiveSplit(layout, isCompact)) {
    return NO_INDICATOR;
  }
  const pane = listPanes(layout.root).find(
    (entry) => paneContentMatchKey(entry.content) === contentKey,
  );
  if (pane === undefined) {
    return NO_INDICATOR;
  }
  return buildSplitIndicator(layout, new Set([pane.paneId]));
}

function buildGroupIndicator(
  layout: SplitLayout | null,
  groupKey: string,
  isCompact: boolean,
): PaneContentSplitIndicator {
  if (groupKey.length === 0 || !hasActiveSplit(layout, isCompact)) {
    return NO_INDICATOR;
  }
  const threadKeys = new Set(groupKey.split(TARGET_SEPARATOR));
  const matchingPaneIds = new Set<string>();
  for (const pane of listPanes(layout.root)) {
    const content = pane.content;
    if (
      content.kind === "thread" &&
      threadKeys.has(threadPaneMatchKey(content.projectId, content.threadId))
    ) {
      matchingPaneIds.add(pane.paneId);
    }
  }
  return buildSplitIndicator(layout, matchingPaneIds);
}

function useSplitIndicator(
  select: (layout: SplitLayout | null) => PaneContentSplitIndicator,
  active: boolean,
): PaneContentSplitIndicator {
  const indicatorAtom = useMemo(
    () =>
      active
        ? selectAtom(splitLayoutAtom, select, indicatorsEqual)
        : NO_INDICATOR_ATOM,
    [active, select],
  );
  return useAtomValue(indicatorAtom);
}

export function usePaneContentSplitIndicator(
  content: PaneContent,
  enabled: boolean,
): PaneContentSplitIndicator {
  const isCompact = useIsCompactViewport();
  const contentKey = paneContentMatchKey(content);
  const select = useMemo(
    () => (layout: SplitLayout | null) =>
      buildContentIndicator(layout, contentKey, enabled, isCompact),
    [contentKey, enabled, isCompact],
  );
  return useSplitIndicator(select, enabled);
}

export function useThreadGroupSplitIndicator(
  threads: readonly ThreadSplitIndicatorTarget[],
  enabled: boolean,
): PaneContentSplitIndicator {
  const isCompact = useIsCompactViewport();
  const groupKey = enabled
    ? threads.map(threadMatchKey).join(TARGET_SEPARATOR)
    : "";
  const select = useMemo(
    () => (layout: SplitLayout | null) =>
      buildGroupIndicator(layout, groupKey, isCompact),
    [groupKey, isCompact],
  );
  return useSplitIndicator(select, groupKey.length > 0);
}
