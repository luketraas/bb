import { describe, expect, it, vi } from "vitest";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import type { ThreadTimelinePageRequest } from "../../../src/services/threads/timeline-pagination.js";
import {
  buildThreadTimelineCacheKey,
  createThreadTimelineCache,
  type ThreadTimelineCacheKeyArgs,
} from "../../../src/services/threads/timeline-cache.js";

function makeResponse(
  rowCount: number,
  detail: string | null = null,
): ThreadTimelineResponse {
  return {
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: `row-${index}`,
      kind: "system",
      threadId: "thr_x",
      turnId: null,
      sourceSeqStart: index,
      sourceSeqEnd: index,
      startedAt: 0,
      createdAt: 0,
      systemKind: "debug",
      title: "t",
      detail,
      status: null,
    })),
    contextBoundarySeq: null,
    completedTurnDisplay: "collapse",
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    maxSeq: 0,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

function serializedBytes(response: ThreadTimelineResponse): number {
  return Buffer.byteLength(JSON.stringify(response));
}

const latestPage: ThreadTimelinePageRequest = {
  kind: "latest",
  segmentLimit: 20,
};

const baseKeyArgs: ThreadTimelineCacheKeyArgs = {
  threadId: "thr_x",
  maxSeq: 10,
  status: "idle",
  environmentId: null,
  page: latestPage,
  includeNestedRows: false,
  summaryOnly: false,
  includeDiagnosticOperations: false,
  completedTurnDisplay: "collapse",
};

describe("createThreadTimelineCache", () => {
  it("builds once for the same key and serves cached on repeat", () => {
    const cache = createThreadTimelineCache();
    const build = vi.fn(() => makeResponse(3));

    const first = cache.getOrBuild("thr_x", "k", build);
    const second = cache.getOrBuild("thr_x", "k", build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("rebuilds when the key changes (e.g. new maxSeq)", () => {
    const cache = createThreadTimelineCache();
    const build = vi.fn(() => makeResponse(3));

    cache.getOrBuild("thr_x", "k1", build);
    cache.getOrBuild("thr_x", "k2", build);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it("shares one build between identical requests above 200 rows", () => {
    const cache = createThreadTimelineCache();
    const build = vi.fn(() => makeResponse(450));

    const first = cache.getOrBuild("thr_x", "k", build);
    const second = cache.getOrBuild("thr_x", "k", build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("evicts least-recently-used entries to stay within the byte budget", () => {
    const entryBytes = serializedBytes(makeResponse(10));
    const cache = createThreadTimelineCache({ maxBytes: entryBytes * 4 });
    const build = vi.fn(() => makeResponse(10));

    for (const key of ["a", "b", "c", "d"])
      cache.getOrBuild("thr_x", key, build);
    cache.getOrBuild("thr_x", "a", build);
    cache.getOrBuild("thr_x", "e", build);

    expect(cache.size).toBe(4);
    expect(cache.bytes).toBe(entryBytes * 4);
    const buildAgain = vi.fn(() => makeResponse(10));
    cache.getOrBuild("thr_x", "a", buildAgain);
    cache.getOrBuild("thr_x", "b", buildAgain);
    expect(buildAgain).toHaveBeenCalledTimes(1);
  });

  it("keeps byte accounting exact across mixed-size eviction and invalidation", () => {
    const small = serializedBytes(makeResponse(2));
    const medium = serializedBytes(makeResponse(6));
    const large = serializedBytes(makeResponse(9));
    expect(small + medium + large * 3).toBeGreaterThan(large * 4);
    expect(medium + large * 3).toBeLessThanOrEqual(large * 4);
    const cache = createThreadTimelineCache({ maxBytes: large * 4 });

    cache.getOrBuild("thr_x", "x-small", () => makeResponse(2));
    cache.getOrBuild("thr_y", "y-medium", () => makeResponse(6));
    cache.getOrBuild("thr_x", "x-large", () => makeResponse(9));
    cache.getOrBuild("thr_y", "y-large", () => makeResponse(9));
    cache.getOrBuild("thr_x", "x-large-2", () => makeResponse(9));

    expect(cache.size).toBe(4);
    expect(cache.bytes).toBe(medium + large * 3);

    cache.invalidateThread("thr_x");
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(medium + large);

    cache.invalidateThread("thr_y");
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("weighs row content, not row count", () => {
    const small = makeResponse(3);
    const large = makeResponse(3, "output ".repeat(2_000));
    const cache = createThreadTimelineCache({
      maxBytes: serializedBytes(small) * 8,
    });
    expect(serializedBytes(large)).toBeGreaterThan(serializedBytes(small) * 2);
    const buildLarge = vi.fn(() => large);

    cache.getOrBuild("thr_x", "small", () => small);
    cache.getOrBuild("thr_x", "large", buildLarge);
    cache.getOrBuild("thr_x", "large", buildLarge);

    expect(buildLarge).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(serializedBytes(small));
  });

  it("does not admit a response larger than a quarter of the byte budget", () => {
    const cache = createThreadTimelineCache({
      maxBytes: serializedBytes(makeResponse(10)) * 4,
    });
    const build = vi.fn(() => makeResponse(50));

    cache.getOrBuild("thr_x", "k", build);
    cache.getOrBuild("thr_x", "k", build);

    expect(build).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("evicts least-recently-used entries beyond maxEntries", () => {
    const cache = createThreadTimelineCache({ maxEntries: 2 });
    const build = vi.fn(() => makeResponse(1));

    cache.getOrBuild("thr_x", "a", build);
    cache.getOrBuild("thr_x", "b", build);
    cache.getOrBuild("thr_x", "a", build);
    cache.getOrBuild("thr_x", "c", build);

    expect(cache.size).toBe(2);
    const buildAgain = vi.fn(() => makeResponse(1));
    cache.getOrBuild("thr_x", "a", buildAgain);
    cache.getOrBuild("thr_x", "b", buildAgain);
    expect(buildAgain).toHaveBeenCalledTimes(1);
  });

  it("invalidates only entries for the rewritten thread", () => {
    const cache = createThreadTimelineCache();
    const build = vi.fn(() => makeResponse(1));
    cache.getOrBuild("thr_x", "x", build);
    cache.getOrBuild("thr_y", "y", build);

    cache.invalidateThread("thr_x");

    expect(cache.bytes).toBe(serializedBytes(makeResponse(1)));

    cache.getOrBuild("thr_x", "x", build);
    cache.getOrBuild("thr_y", "y", build);
    expect(build).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(2);
  });
});

describe("buildThreadTimelineCacheKey", () => {
  it("differs when any projection input differs", () => {
    const base = buildThreadTimelineCacheKey(baseKeyArgs);
    const variants: ThreadTimelineCacheKeyArgs[] = [
      { ...baseKeyArgs, maxSeq: 11 },
      { ...baseKeyArgs, status: "active" },
      { ...baseKeyArgs, environmentId: "env_1" },
      { ...baseKeyArgs, includeNestedRows: true },
      { ...baseKeyArgs, summaryOnly: true },
      { ...baseKeyArgs, includeDiagnosticOperations: true },
      { ...baseKeyArgs, completedTurnDisplay: "flat" },
      {
        ...baseKeyArgs,
        page: {
          kind: "older",
          segmentLimit: 20,
          beforeCursor: { anchorSeq: 5, anchorId: "a5" },
        },
      },
    ];
    for (const variant of variants) {
      expect(buildThreadTimelineCacheKey(variant)).not.toBe(base);
    }
  });

  it("distinguishes older-page cursors", () => {
    const cursorA = buildThreadTimelineCacheKey({
      ...baseKeyArgs,
      page: {
        kind: "older",
        segmentLimit: 20,
        beforeCursor: { anchorSeq: 5, anchorId: "a5" },
      },
    });
    const cursorB = buildThreadTimelineCacheKey({
      ...baseKeyArgs,
      page: {
        kind: "older",
        segmentLimit: 20,
        beforeCursor: { anchorSeq: 6, anchorId: "a6" },
      },
    });
    expect(cursorA).not.toBe(cursorB);
  });
});
