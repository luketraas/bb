import type { ThreadTimelineResponse } from "@bb/server-contract";
import type { CompletedTurnDisplay, ThreadStatus } from "@bb/domain";
import type { ThreadTimelinePageRequest } from "./timeline-pagination.js";

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_SHARE_OF_BUDGET = 4;

interface ThreadTimelineCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

interface ThreadTimelineCache {
  getOrBuild(
    threadId: string,
    key: string,
    build: () => ThreadTimelineResponse,
  ): ThreadTimelineResponse;
  invalidateThread(threadId: string): void;
  readonly size: number;
  readonly bytes: number;
}

interface ThreadTimelineCacheEntry {
  response: ThreadTimelineResponse;
  threadId: string;
  bytes: number;
}

export function createThreadTimelineCache(
  options: ThreadTimelineCacheOptions = {},
): ThreadTimelineCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntryBytes = maxBytes / MAX_ENTRY_SHARE_OF_BUDGET;
  const entries = new Map<string, ThreadTimelineCacheEntry>();
  let totalBytes = 0;

  function remove(key: string, entry: ThreadTimelineCacheEntry): void {
    entries.delete(key);
    totalBytes -= entry.bytes;
  }

  return {
    getOrBuild(threadId, key, build) {
      const cached = entries.get(key);
      if (cached !== undefined) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.response;
      }

      const value = build();
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > maxEntryBytes) {
        return value;
      }
      entries.set(key, { response: value, threadId, bytes });
      totalBytes += bytes;
      for (const [oldestKey, oldest] of entries) {
        if (entries.size <= maxEntries && totalBytes <= maxBytes) {
          break;
        }
        remove(oldestKey, oldest);
      }
      return value;
    },
    invalidateThread(threadId) {
      for (const [key, entry] of entries) {
        if (entry.threadId === threadId) {
          remove(key, entry);
        }
      }
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return totalBytes;
    },
  };
}

export interface ThreadTimelineCacheKeyArgs {
  threadId: string;
  maxSeq: number;
  status: ThreadStatus;
  environmentId: string | null;
  providerDisplayName?: string;
  page: ThreadTimelinePageRequest;
  includeNestedRows: boolean;
  summaryOnly: boolean;
  includeDiagnosticOperations: boolean;
  completedTurnDisplay: CompletedTurnDisplay;
}

function pageKeyPart(page: ThreadTimelinePageRequest): string {
  return page.kind === "older"
    ? `older:${page.segmentLimit}:${page.beforeCursor.anchorSeq}:${page.beforeCursor.anchorId}`
    : `latest:${page.segmentLimit}`;
}

export function buildThreadTimelineParamsKey(
  args: Omit<ThreadTimelineCacheKeyArgs, "maxSeq">,
): string {
  return [
    args.threadId,
    args.status,
    args.environmentId ?? "-",
    args.providerDisplayName ?? "-",
    pageKeyPart(args.page),
    args.includeNestedRows ? "1" : "0",
    args.summaryOnly ? "1" : "0",
    args.includeDiagnosticOperations ? "1" : "0",
    args.completedTurnDisplay,
  ].join("|");
}

export function buildThreadTimelineCacheKey(
  args: ThreadTimelineCacheKeyArgs,
): string {
  return `${args.maxSeq}|${buildThreadTimelineParamsKey(args)}`;
}
