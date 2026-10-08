import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const missing = Symbol("missing");
// Release history and publishing belong to the fork, independently of upstream.
const forkOwnedFiles = [
  "AGENTS.md",
  ".github/workflows/publish.yml",
  ".release-please-manifest.json",
  "release-please-config.json",
  "CHANGELOG.md",
  "docs/RELEASES.md",
  "scripts/release-preflight.sh",
];
const allowedConflicts = new Set([...forkOwnedFiles, "package-lock.json", "package.json"]);
class SyncConflict extends Error {}
const forkOwnedPackagePaths = new Set([
  "bugs",
  "homepage",
  "name",
  "repository",
  "scripts/release:preflight",
  "version",
]);
const forkOwnedLockPaths = new Set(["name", "packages//name", "packages//version", "version"]);

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function jsonAt(ref, file) {
  return JSON.parse(git(["show", `${ref}:${file}`]));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeJson(base, fork, upstream, forkOwnedPaths, path = []) {
  const pathKey = path.join("/");
  if (forkOwnedPaths.has(pathKey)) return fork;
  if (isDeepStrictEqual(fork, upstream)) return fork;
  if (isDeepStrictEqual(fork, base)) return upstream;
  if (isDeepStrictEqual(upstream, base)) return fork;

  if (isObject(base) || isObject(fork) || isObject(upstream)) {
    const keys = new Set([
      ...Object.keys(isObject(base) ? base : {}),
      ...Object.keys(isObject(fork) ? fork : {}),
      ...Object.keys(isObject(upstream) ? upstream : {}),
    ]);
    const merged = {};
    for (const key of keys) {
      const value = mergeJson(
        isObject(base) && key in base ? base[key] : missing,
        isObject(fork) && key in fork ? fork[key] : missing,
        isObject(upstream) && key in upstream ? upstream[key] : missing,
        forkOwnedPaths,
        [...path, key],
      );
      if (value !== missing) merged[key] = value;
    }
    return merged;
  }

  throw new SyncConflict(`Package metadata changed in both fork and upstream at ${pathKey}`);
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function prepare() {
  const release = requiredArgument("--release");
  const tag = requiredArgument("--tag");
  const branch = requiredArgument("--branch");
  if (!/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }

  const forkHead = git(["rev-parse", "HEAD"]);
  const mergeBase = git(["merge-base", forkHead, release]);
  const basePackage = jsonAt(mergeBase, "package.json");
  const forkPackage = jsonAt(forkHead, "package.json");
  const upstreamPackage = jsonAt(release, "package.json");
  const baseLock = jsonAt(mergeBase, "package-lock.json");
  const forkLock = jsonAt(forkHead, "package-lock.json");
  const upstreamLock = jsonAt(release, "package-lock.json");

  const mergedPackage = mergeJson(basePackage, forkPackage, upstreamPackage, forkOwnedPackagePaths);
  mergedPackage.openaideUpstream = `agentclientprotocol/claude-agent-acp@${tag}`;
  const mergedLock = mergeJson(baseLock, forkLock, upstreamLock, forkOwnedLockPaths);

  git(["switch", "--create", branch]);
  const merge = spawnSync("git", ["merge", "--no-ff", "--no-commit", release], {
    encoding: "utf8",
  });
  if (merge.status !== 0) {
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    if (conflicts.length === 0) {
      throw new Error(`Unable to merge upstream ${tag}: ${merge.stderr || merge.stdout}`);
    }
    const unexpected = conflicts.filter((file) => !allowedConflicts.has(file));
    if (unexpected.length > 0) {
      git(["merge", "--abort"]);
      throw new SyncConflict(`Upstream changes need resolution: ${unexpected.join(", ")}`);
    }
  }

  const ownedFiles = forkOwnedFiles.filter(
    (file) => spawnSync("git", ["cat-file", "-e", `${forkHead}:${file}`]).status === 0,
  );
  git(["restore", "--source", forkHead, "--staged", "--worktree", "--", ...ownedFiles]);
  writeJson("package.json", mergedPackage);
  writeJson("package-lock.json", mergedLock);
  git(["add", ...ownedFiles, "package.json", "package-lock.json"]);
  const unresolved = git(["diff", "--name-only", "--diff-filter=U"]);
  if (unresolved) {
    git(["merge", "--abort"]);
    throw new SyncConflict(`Unresolved upstream conflicts: ${unresolved.replaceAll("\n", ", ")}`);
  }
  git(["diff", "--cached", "--check"]);
  git([
    "commit",
    "--message",
    `Merge upstream ${tag}\n\nUpstream-Sync-Base: ${forkHead}\nUpstream-Sync-Release: ${release}`,
  ]);
}

const started = Date.now();
console.log(JSON.stringify({ operation: "upstream_sync", phase: "start", attempt: 1 }));
try {
  prepare();
  console.log(
    JSON.stringify({
      operation: "upstream_sync",
      phase: "end",
      outcome: "prepared",
      durationMs: Date.now() - started,
      attempt: 1,
    }),
  );
} catch (error) {
  const conflict = error instanceof SyncConflict;
  console.error(
    JSON.stringify({
      operation: "upstream_sync",
      phase: "end",
      outcome: "failure",
      errorClass: conflict ? "merge_conflict" : "preparation_failed",
      durationMs: Date.now() - started,
      attempt: 1,
    }),
  );
  console.error(error.message);
  // The publisher opens a draft for real conflicts; infrastructure failures remain failures.
  process.exitCode = conflict ? 2 : 1;
}
