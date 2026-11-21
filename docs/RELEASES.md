# Releases and delivery to OpenAIDE

The fork makes no releases and no longer publishes to npm. OpenAIDE embeds the
adapter from a git submodule pinned to a commit on this repository's `main`
([OpenAIDE ADR-0079](https://github.com/OldKrab/OpenAIDE/blob/main/docs/adr/0079-built-in-agent-adapters-are-embedded-from-fork-submodules.md)),
so a change reaches OpenAIDE once it is merged to `main` and CI passes there.

## How a merge reaches OpenAIDE

1. A pull request merges to `main`, and [`ci.yml`](../.github/workflows/ci.yml)
   runs on the push.
2. When that run succeeds,
   [`openaide-update.yml`](../.github/workflows/openaide-update.yml) dispatches
   `update-adapter.yml` in `OldKrab/OpenAIDE` with `adapter=claude-agent-acp` and
   the tested commit.
3. OpenAIDE moves the submodule to that commit, regenerates the adapter's runtime
   lockfile, builds and tests it, and opens a pull request that merges itself
   once its CI passes.

CI runs for two quick merges can finish out of order, so a run whose commit is no
longer the tip of `main` skips the dispatch; the newer commit's own run dispatches
once it passes. OpenAIDE also runs `update-adapter.yml` daily against the latest
`main`, so a lost dispatch only delays the update.

### Recovering a lost update

Re-run the failed `OpenAIDE Update` run, or dispatch the OpenAIDE workflow
directly with a full commit that is on `main`:

```sh
gh workflow run update-adapter.yml --repo OldKrab/OpenAIDE --ref main \
  -f adapter=claude-agent-acp -f commit=<commit>
```

## Versions and history

`version` in `package.json` stays at the last npm release. OpenAIDE identifies an
embedded build by its fork commit, so the version does not have to change.
[`CHANGELOG.md`](../CHANGELOG.md) and the `openaide-claude-agent-acp-vX.Y.Z` tags
record the releases published to npm before embedding.

[`deprecate-npm.yml`](../.github/workflows/deprecate-npm.yml) is a one-time,
manually dispatched workflow that deprecates every published version of
`@openaide/claude-agent-acp`. Delete it after it has run once.

## Upstream updates

`upstream-sync.yml` checks the latest `agentclientprotocol/claude-agent-acp`
GitHub release every day and opens one update PR per release. The PR branch
merges the immutable upstream release into the fork and resolves the
deterministic fork-owned conflicts before pushing: OpenAIDE package identity and
versioning, and the package lockfile. Package fields changed only by upstream are
imported; a field changed differently on both sides fails explicitly instead of
being guessed.

Upstream's changes to fork-owned files are never applied: this guide,
`AGENTS.md`, `CHANGELOG.md`, and upstream's release-please and npm publishing
files, which stay deleted in the fork. The list is `forkOwnedFiles` in
[`scripts/prepare-upstream-sync.mjs`](../scripts/prepare-upstream-sync.mjs).

Upstream preview tags have no GitHub release, so the sync only follows stable
upstream releases.

Before merging an upstream update, review the resulting product changes and let
the normal PR CI pass; the merge then reaches OpenAIDE like any other. A closed
update PR is treated as an intentional dismissal; the next upstream release gets
its own PR.

Like Dependabot, a newer upstream release replaces older unmerged update PRs:
while the newest release's PR is open, the sync closes every older update PR
with a `Superseded by #N` comment and deletes its branch. A branch carrying
commits from anyone other than `github-actions[bot]`, such as maintainer
conflict fixes, is kept so that work can be carried into the newer update.

## Credentials and repository settings

| Secret                                             | Used for                                                |
| -------------------------------------------------- | ------------------------------------------------------- |
| `RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY` | App token for upstream sync PRs and the OpenAIDE update |
| `NPM_TOKEN`                                        | The one-time npm deprecation only; remove it afterwards |

The GitHub App must be installed on this repository with `Contents: write`,
`Pull requests: write`, and `Workflows: write` permissions. The workflow
permission is required because an upstream release commit can update files under
`.github/workflows`. Its installation on `OldKrab/OpenAIDE` needs `Actions:
write` so `openaide-update.yml` can dispatch the update there.
