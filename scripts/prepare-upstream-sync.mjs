import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const missing = Symbol("missing");
// Files whose fork state, including absence, is kept as is: upstream's changes to
// them are never applied. The fork's guide, release history and delivery docs are
// its own, and it does not publish to npm, so upstream's release-please and
// publishing files stay deleted here (OpenAIDE embeds the fork from git).
const forkOwnedFiles = [
  "AGENTS.md",
  ".github/workflows/publish.yml",
  ".release-please-manifest.json",
  "release-please-config.json",
  "CHANGELOG.md",
  "docs/RELEASES.md",
  "scripts/release-preflight.sh",
];
// Both are rewritten from the three-way JSON merge below.
const allowedConflicts = new Set(["package-lock.json", "package.json"]);
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

function optionalArgument(name) {
  return process.argv.includes(name) ? requiredArgument(name) : undefined;
}

function abort() {
  git(["reset", "--hard", "--quiet", "HEAD"]);
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
  // Sync PRs are squash-merged, so the fork's history does not contain upstream's.
  // The upstream release the fork last recorded is the true common ancestor.
  const mergeBase = optionalArgument("--base") ?? git(["merge-base", forkHead, release]);
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
  // Apply upstream's changes since the base as a three-way patch. The result is one
  // ordinary commit on top of the fork, matching how the PR is squash-merged. A
  // patch to a file the fork deleted cannot apply at all, so fork-owned files are
  // left out of the patch rather than restored afterwards.
  const excluded = forkOwnedFiles.map((file) => `:(exclude,literal)${file}`);
  const diff = execFileSync(
    "git",
    ["diff", "--binary", "--full-index", mergeBase, release, "--", ".", ...excluded],
    { maxBuffer: 1 << 30 },
  );
  const merge = spawnSync("git", ["apply", "--3way", "--index", "--whitespace=nowarn"], {
    encoding: "utf8",
    input: diff,
  });
  if (merge.status !== 0) {
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    if (conflicts.length === 0) {
      abort();
      throw new Error(`Unable to merge upstream ${tag}: ${merge.stderr || merge.stdout}`);
    }
    const unexpected = conflicts.filter((file) => !allowedConflicts.has(file));
    if (unexpected.length > 0) {
      abort();
      throw new SyncConflict(`Upstream changes need resolution: ${unexpected.join(", ")}`);
    }
  }

  writeJson("package.json", mergedPackage);
  writeJson("package-lock.json", mergedLock);
  git(["add", "package.json", "package-lock.json"]);
  const unresolved = git(["diff", "--name-only", "--diff-filter=U"]);
  if (unresolved) {
    abort();
    throw new SyncConflict(`Unresolved upstream conflicts: ${unresolved.replaceAll("\n", ", ")}`);
  }
  git(["diff", "--cached", "--check"]);
  git([
    "commit",
    "--message",
    `Sync upstream ${tag}\n\nUpstream-Sync-Base: ${forkHead}\nUpstream-Sync-Release: ${release}`,
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
