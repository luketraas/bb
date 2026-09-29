import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "@bb/host-workspace";
import {
  createWorkspaceListingCache,
  invalidateWorkspacePathListings,
  listWorkspacePaths,
} from "./file-list.js";
import { listHostPaths } from "./host-files.js";

const roots: string[] = [];

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-workspace-paths-"));
  roots.push(root);
  return root;
}

async function write(root: string, file: string, content = "fixture") {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

async function initRepo(root: string) {
  await runGit(["init", "-b", "main"], { cwd: root });
}

function listingArgs(root: string) {
  return {
    root,
    includeFiles: true,
    includeDirectories: true,
    includeHidden: true,
    respectGitIgnore: true,
    excludeNames: [],
    reuseRecentListing: false,
  };
}

async function paths(root: string) {
  return (await listWorkspacePaths(listingArgs(root)))
    .map((entry) => entry.path)
    .sort();
}

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots) {
    invalidateWorkspacePathListings(await fs.realpath(root).catch(() => root));
  }
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("workspace path discovery", () => {
  it("includes tracked and non-ignored untracked files while pruning Git-ignored trees", async () => {
    const root = await createRoot();
    await initRepo(root);
    await write(root, ".github/workflows/ci.yml");
    await write(root, ".generated/tracked.txt");
    await runGit(["add", "."], { cwd: root });
    await write(
      root,
      ".gitignore",
      ".generated/\ncustom-cache/\n.state/*\n!.state/keep.txt\n",
    );
    await write(root, ".git/info/exclude", "local-output/\n");
    await write(root, ".generated/deep/ignored.txt");
    await write(root, "custom-cache/arbitrary-tool/ignored.txt");
    await write(root, "local-output/ignored.txt");
    await write(root, ".state/drop.txt");
    await write(root, ".state/keep.txt");
    await write(root, "src/new\nfile.ts");
    await write(root, "src/ignored\nfile.log");
    await write(root, "src/.gitignore", "*.log\n");
    await fs.mkdir(path.join(root, "empty"));
    await fs.symlink("src/new\nfile.ts", path.join(root, "link.ts"));

    expect(await paths(root)).toEqual([
      ".generated",
      ".generated/tracked.txt",
      ".github",
      ".github/workflows",
      ".github/workflows/ci.yml",
      ".gitignore",
      ".state",
      ".state/keep.txt",
      "empty",
      "src",
      "src/.gitignore",
      "src/new\nfile.ts",
    ]);
  });

  it("resolves ignore rules relative to a subdirectory and a linked worktree", async () => {
    const root = await createRoot();
    await initRepo(root);
    await write(root, ".gitignore", "/.sandboxes/\n*.log\n");
    await write(root, "src/README.md");
    await runGit(["add", "."], { cwd: root });
    await runGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    const worktree = path.join(root, ".sandboxes", "worker");
    await runGit(["worktree", "add", "--detach", worktree], { cwd: root });
    await write(worktree, "src/trace.log");
    await write(worktree, "src/new.ts");

    expect(await paths(root)).not.toContain(".sandboxes");
    expect(await paths(path.join(worktree, "src"))).toEqual([
      "README.md",
      "new.ts",
    ]);
    expect(await paths(worktree)).toContain("src/new.ts");
  });

  it("preserves filesystem listings without Git and when ignore filtering is disabled", async () => {
    const root = await createRoot();
    await write(root, ".gitignore", "output/\n");
    await write(root, "output/result.txt");
    await write(root, ".claude/settings.json");
    await write(root, ".claude/worktrees/worker/README.md");
    await write(root, "src/worktrees/index.ts");
    const args = { ...listingArgs(root), excludeNames: [".claude/worktrees"] };
    expect((await listWorkspacePaths(args)).map((entry) => entry.path)).toEqual(
      [
        ".claude",
        ".claude/settings.json",
        ".gitignore",
        "output",
        "output/result.txt",
        "src",
        "src/worktrees",
        "src/worktrees/index.ts",
      ],
    );
    await initRepo(root);
    expect(await paths(root)).not.toContain("output/result.txt");
    expect(
      (await listWorkspacePaths({ ...args, respectGitIgnore: false })).map(
        (entry) => entry.path,
      ),
    ).toContain("output/result.txt");
    expect(
      (await listWorkspacePaths({ ...args, includeHidden: false })).map(
        (entry) => entry.path,
      ),
    ).toEqual(["src", "src/worktrees", "src/worktrees/index.ts"]);
  });

  it("shares pending discovery but refreshes completed results and ignore rules", async () => {
    const root = await createRoot();
    await initRepo(root);
    await write(root, "first.txt");
    const args = listingArgs(root);
    const first = listWorkspacePaths(args);
    const second = listWorkspacePaths({ ...args, excludeNames: [] });
    expect(second).toBe(first);
    await first;
    await write(root, "second.txt");
    await write(root, ".gitignore", "first.txt\n");
    expect(await paths(root)).toEqual([".gitignore", "second.txt"]);

    const hidden = listWorkspacePaths(args);
    const visible = listWorkspacePaths({ ...args, includeHidden: false });
    expect((await hidden).map((entry) => entry.path)).toContain(".gitignore");
    expect((await visible).map((entry) => entry.path)).not.toContain(
      ".gitignore",
    );
  });

  it("does not retain failed discovery", async () => {
    const root = path.join(await createRoot(), "missing");
    await expect(listWorkspacePaths(listingArgs(root))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await write(root, "recovered.txt");
    expect(await paths(root)).toEqual(["recovered.txt"]);
  });

  it("ranks concurrent queries independently over the shared listing", async () => {
    const root = await createRoot();
    await initRepo(root);
    await write(root, "alpha.md");
    await write(root, "beta.md");
    const command = {
      type: "host.list_paths" as const,
      path: root,
      includeFiles: true,
      includeDirectories: false,
      includeHidden: true,
      respectGitIgnore: true,
      excludeNames: [],
      limit: 1,
    };
    const [alpha, beta] = await Promise.all([
      listHostPaths({ ...command, query: "alpha" }),
      listHostPaths({ ...command, query: "beta" }),
    ]);
    expect(alpha.paths.map((entry) => entry.path)).toEqual(["alpha.md"]);
    expect(beta.paths.map((entry) => entry.path)).toEqual(["beta.md"]);
  });

  it("skips excluded names at any depth and never lists .git", async () => {
    const root = await createRoot();
    await write(root, ".git/HEAD");
    await write(root, "node_modules/pkg/index.js");
    await write(root, "apps/web/.turbo/log");
    await write(root, "apps/web/.DS_Store");
    await write(root, "apps/web/index.ts");
    const listPaths = async (excludeNames: string[]) =>
      (
        await listWorkspacePaths({
          ...listingArgs(root),
          respectGitIgnore: false,
          excludeNames,
        })
      )
        .map((entry) => entry.path)
        .sort();

    expect(await listPaths(["node_modules", ".turbo", ".DS_Store"])).toEqual([
      "apps",
      "apps/web",
      "apps/web/index.ts",
    ]);
    expect(await listPaths([])).toEqual([
      "apps",
      "apps/web",
      "apps/web/.DS_Store",
      "apps/web/.turbo",
      "apps/web/.turbo/log",
      "apps/web/index.ts",
      "node_modules",
      "node_modules/pkg",
      "node_modules/pkg/index.js",
    ]);
  });

  it("does not overflow the call stack merging a large subdirectory", async () => {
    const root = await createRoot();
    const nested = path.join(root, "many");
    await fs.mkdir(nested, { recursive: true });
    const fileCount = 150_000;
    const batchSize = 500;
    for (let start = 0; start < fileCount; start += batchSize) {
      const end = Math.min(start + batchSize, fileCount);
      await Promise.all(
        Array.from({ length: end - start }, (_, offset) =>
          fs.writeFile(path.join(nested, `f${start + offset}.txt`), ""),
        ),
      );
    }

    const result = await listWorkspacePaths({
      ...listingArgs(root),
      includeDirectories: false,
      includeHidden: false,
      respectGitIgnore: false,
    });

    expect(result).toHaveLength(fileCount);
  }, 60_000);
});

describe("recent workspace listing reuse", () => {
  const TTL_MS = 2_000;

  function createCache(
    limits: { maxListings?: number; maxPaths?: number } = {},
  ) {
    return createWorkspaceListingCache({
      ttlMs: TTL_MS,
      maxListings: limits.maxListings ?? 32,
      maxPaths: limits.maxPaths ?? 100_000,
    });
  }

  async function settledRoot(files = ["first.txt"]) {
    const root = await fs.realpath(await createRoot());
    for (const file of files) await write(root, file);
    return root;
  }

  function recentArgs(root: string, reuseRecentListing = true) {
    return {
      ...listingArgs(root),
      respectGitIgnore: false,
      reuseRecentListing,
    };
  }

  async function listedPaths(listing: ReturnType<typeof listWorkspacePaths>) {
    return (await listing).map((entry) => entry.path);
  }

  it("reuses a settled listing for successive queried requests", async () => {
    const cache = createCache();
    const root = await settledRoot();
    const first = cache.list(recentArgs(root));
    await first;
    await write(root, "second.txt");

    const second = cache.list(recentArgs(root));
    expect(second).toBe(first);
    expect(await listedPaths(second)).not.toContain("second.txt");
  });

  it("rediscovers for requests without a query through the host command", async () => {
    const root = await settledRoot();
    const command = {
      type: "host.list_paths" as const,
      path: root,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: true,
      respectGitIgnore: false,
      excludeNames: [],
      limit: 10,
    };
    await listHostPaths({ ...command, query: "first" });
    await write(root, "second.txt");
    expect(
      (await listHostPaths(command)).paths.map((entry) => entry.path),
    ).toContain("second.txt");
    await write(root, "third.txt");
    expect(
      (await listHostPaths({ ...command, query: "third" })).paths.map(
        (entry) => entry.path,
      ),
    ).not.toContain("third.txt");
  });

  it("does not let a request without a query join a scan invalidated in flight", async () => {
    const cache = createCache();
    const root = await settledRoot();
    const queried = cache.list(recentArgs(root));
    cache.invalidate(root);
    const joined = cache.list(recentArgs(root));
    const fresh = cache.list(recentArgs(root, false));

    expect(joined).toBe(queried);
    expect(fresh).not.toBe(queried);
    expect(cache.list(recentArgs(root))).toBe(fresh);
    await fresh;
    await queried;
  });

  it("rediscovers once the freshness window after discovery expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cache = createCache();
    const root = await settledRoot();
    const first = cache.list(recentArgs(root));
    await first;

    vi.advanceTimersByTime(TTL_MS - 1);
    const beforeExpiry = cache.list(recentArgs(root));
    await beforeExpiry;
    expect(beforeExpiry).toBe(first);
    vi.advanceTimersByTime(1);
    await write(root, "second.txt");
    const refreshed = cache.list(recentArgs(root));
    expect(refreshed).not.toBe(first);
    expect(await listedPaths(refreshed)).toContain("second.txt");
  });

  it("drops settled listings for a changed root, its descendants and its ancestors", async () => {
    const cache = createCache();
    const root = await settledRoot(["src/app.ts"]);
    const nestedRoot = path.join(root, "src");
    const whole = cache.list(recentArgs(root));
    const nested = cache.list(recentArgs(nestedRoot));
    await Promise.all([whole, nested]);

    cache.invalidate(nestedRoot);
    const [wholeAgain, nestedAgain] = [
      cache.list(recentArgs(root)),
      cache.list(recentArgs(nestedRoot)),
    ];
    await Promise.all([wholeAgain, nestedAgain]);
    expect(wholeAgain).not.toBe(whole);
    expect(nestedAgain).not.toBe(nested);

    cache.invalidate(path.parse(root).root);
    const afterFilesystemRoot = cache.list(recentArgs(root));
    await afterFilesystemRoot;
    expect(afterFilesystemRoot).not.toBe(wholeAgain);
  });

  it("keeps sharing a queried scan invalidated in flight but does not reuse its result", async () => {
    const cache = createCache();
    const root = await settledRoot();
    const first = cache.list(recentArgs(root));
    cache.invalidate(root);
    expect(cache.list(recentArgs(root))).toBe(first);
    await first;

    const next = cache.list(recentArgs(root));
    await next;
    expect(next).not.toBe(first);
  });

  it("keeps listings for unrelated roots", async () => {
    const cache = createCache();
    const root = await settledRoot();
    const other = await settledRoot();
    const first = cache.list(recentArgs(root));
    await first;

    cache.invalidate(other);

    const reused = cache.list(recentArgs(root));
    await reused;
    expect(reused).toBe(first);
  });

  it("evicts the least recently used listing beyond the listing limit", async () => {
    const cache = createCache({ maxListings: 2 });
    const [a, b, c] = await Promise.all([
      settledRoot(),
      settledRoot(),
      settledRoot(),
    ]);
    const listingA = cache.list(recentArgs(a));
    await listingA;
    const listingB = cache.list(recentArgs(b));
    await listingB;
    expect(cache.list(recentArgs(a))).toBe(listingA);
    const listingC = cache.list(recentArgs(c));
    await listingC;

    expect(cache.size).toBe(2);
    expect(cache.list(recentArgs(a))).toBe(listingA);
    expect(cache.list(recentArgs(c))).toBe(listingC);
    const rediscoveredB = cache.list(recentArgs(b));
    expect(rediscoveredB).not.toBe(listingB);
    await rediscoveredB;
  });

  it("evicts listings beyond the path limit and never keeps an oversized listing", async () => {
    const cache = createCache({ maxPaths: 4 });
    const small = await settledRoot(["one.txt", "two.txt"]);
    const other = await settledRoot(["three.txt", "four.txt"]);
    const oversized = await settledRoot([
      "a.txt",
      "b.txt",
      "c.txt",
      "d.txt",
      "e.txt",
    ]);

    const listingSmall = cache.list(recentArgs(small));
    await listingSmall;
    const listingOther = cache.list(recentArgs(other));
    await listingOther;
    const listingOversized = cache.list(recentArgs(oversized));
    await listingOversized;
    expect(cache.size).toBe(2);
    const oversizedAgain = cache.list(recentArgs(oversized));
    expect(oversizedAgain).not.toBe(listingOversized);
    await oversizedAgain;
    expect(cache.size).toBe(2);

    const third = await settledRoot(["six.txt"]);
    const listingThird = cache.list(recentArgs(third));
    await listingThird;

    expect(cache.size).toBe(2);
    expect(cache.list(recentArgs(other))).toBe(listingOther);
    expect(cache.list(recentArgs(third))).toBe(listingThird);
    const smallAgain = cache.list(recentArgs(small));
    expect(smallAgain).not.toBe(listingSmall);
    await smallAgain;
  });
});
