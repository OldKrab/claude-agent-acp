# Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please)
in [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). Every push
to `main` re-computes the next version from the conventional commit messages and
keeps a single release PR open, titled `chore(main): release openaide-claude-agent-acp X.Y.Z`
and labelled `autorelease: pending`.

Merging that PR is what releases. It tags `openaide-claude-agent-acp-vX.Y.Z`,
creates the GitHub release, runs the verification suite, publishes
`@openaide/claude-agent-acp` to npm, and asks OpenAIDE to open the pull request
that pins the new version.

There is no manual release button, and versions are never typed in by hand: the
version is an output of the commit history, not an input. There is no preview
channel; only release merges publish.

## Bootstrapping the package

release-please only releases what lands after its manifest version, so the first
`1.0.0` publish is dispatched by hand once the repository secrets exist:

```sh
gh workflow run publish.yml --ref main -f ref=main
```

The bootstrap run's `trigger-openaide-update` job fails if OpenAIDE's `main` does
not have `update-claude-acp.yml` yet; the OpenAIDE change that adds it also pins
`1.0.0`, so nothing is lost.

That publish authenticates with the repository's encrypted `NPM_TOKEN` secret.
After the package exists, configure npm Trusted Publishing for
`OldKrab/claude-agent-acp`, workflow `publish.yml`, environment `release`, and
allow `npm publish`. Later releases then authenticate through GitHub Actions
OIDC; remove `NPM_TOKEN` after the trusted publisher succeeds.

## Releasing

```sh
npm run release:preflight
```

This reports the open release PR, the version it will ship, and checks that the
repository is in a state where merging is safe. Nothing has to be remembered —
if it exits non-zero, follow what it prints instead of merging.

Then merge it, using the PR number the preflight printed:

```sh
gh pr merge <pr-number> --squash
gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The run is looked up rather than picked interactively, so this is safe to script.
If the workflow has already finished, `gh run list --workflow=publish.yml` shows
the outcome instead.

Merging main requires no review, so a green preflight and `Build` are the only
gates before the merge. After it, the `verify` job re-runs formatting, lint, build
and tests against the release commit, and nothing is published unless it passes.
Once the workflow finishes, confirm both outputs landed:

```sh
gh release view "openaide-claude-agent-acp-v<version>"
npm view "@openaide/claude-agent-acp@<version>"
```

## How the version is chosen

The OpenAIDE package uses its own stable semantic version independent of the
upstream adapter. The `openaideUpstream` package field and each sync commit
record the upstream tag used for that release.

- `1.0.0` is the first OpenAIDE-owned production release.
- Compatible upstream syncs and bug fixes increment the patch number.
- New compatible adapter features increment the minor number.
- Breaking adapter changes increment the major number.

An upstream version update does not by itself determine the OpenAIDE package
version; it is evaluated under this policy and recorded as the release's
upstream base.

Squash merges use the PR title as the commit subject, so the PR title decides the
next version. [`conventional-prs.yml`](../.github/workflows/conventional-prs.yml)
rejects titles release-please would not understand.

| PR title prefix                                           | Effect                    |
| --------------------------------------------------------- | ------------------------- |
| `fix:`, `perf:`, `revert:`, `docs:`                       | patch, e.g. 1.1.4 → 1.1.5 |
| `feat:`                                                   | minor, e.g. 1.1.4 → 1.2.0 |
| any of the above with `!`, or BREAKING CHANGE             | major, e.g. 1.1.4 → 2.0.0 |
| `chore:`, `ci:`, `build:`, `test:`, `refactor:`, `style:` | no release on their own   |

The package is past 1.0.0, so a `!` really does ship a major version. Upstream is
still below 1.0.0 and marks breaking changes with a minor bump; decide the
OpenAIDE bump from the product impact when titling an upstream sync PR.

Note that `config-file` only takes effect while the workflow does **not** pass a
`release-type` input to the action — with `release-type` set, the action ignores
the config entirely. The release type is declared inside the config instead.

The config deliberately enables `include-component-in-tag` and uses the explicit
`openaide-claude-agent-acp` component. The fork inherits upstream `vX.Y.Z` tags,
so OpenAIDE releases use the distinct `openaide-claude-agent-acp-vX.Y.Z`
namespace. The manifest starts at `1.0.0`; release-please then advances the
independent OpenAIDE version from its own commit history.

If a specific version has to be forced, add `"release-as": "X.Y.Z"` to
`release-please-config.json` in its own PR, release, then remove it again.

## Recovering a stalled release

### The release PR merged but nothing was tagged

The preflight fails with `release-please is jammed`. While a merged release PR
still carries `autorelease: pending`, release-please refuses to open any new
release PR at all, so every later release stalls silently until this is cleared.

Take the release notes release-please already wrote into the changelog, create
the missing release, then move the label the way release-please would have:

```sh
awk '/^## \[<version>\]/{f=1;print;next} /^## \[/{f=0} f' CHANGELOG.md > notes.md
gh release create "openaide-claude-agent-acp-v<version>" --target <merge-commit-sha> --notes-file notes.md
gh pr edit <pr-number> --remove-label "autorelease: pending" \
  --add-label "autorelease: tagged"
```

Then publish the tag as described below.

### The tag exists but npm is missing

Re-run the publish workflow against the existing tag:

```sh
gh workflow run publish.yml --ref main -f ref="openaide-claude-agent-acp-v<version>"
```

This re-runs `verify` against that ref before publishing. npm versions are
immutable, so a version that already published cannot be published again.

### npm published but OpenAIDE was not asked to update

`trigger-openaide-update` waits until the exact version resolves on npm, then
dispatches `update-claude-acp.yml` in `OldKrab/OpenAIDE`. Re-run that failed job
alone, or dispatch the OpenAIDE workflow directly:

```sh
gh workflow run update-claude-acp.yml --repo OldKrab/OpenAIDE --ref main -f version=<version>
```

OpenAIDE also runs that workflow daily, so a lost dispatch only delays the pin.

## Upstream updates

`upstream-sync.yml` checks the latest `agentclientprotocol/claude-agent-acp`
GitHub release every day and opens one update PR per release. The PR branch
merges the immutable upstream release into the fork and resolves the
deterministic fork-owned conflicts before pushing: OpenAIDE package identity and
versioning, the release manifest, package lockfile, and publishing workflow.
Package fields changed only by upstream are imported; a field changed
differently on both sides fails explicitly instead of being guessed.

Upstream preview tags have no GitHub release, so the sync only follows stable
upstream releases.

Before merging an upstream update, review the resulting product changes and let
the normal PR CI pass. A closed update PR is treated as an intentional dismissal;
the next upstream release gets its own PR.

## Credentials and repository settings

| Secret                                             | Used for                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY` | App token for release PRs and tags, and the OpenAIDE pin dispatch |
| `NPM_TOKEN`                                        | npm publishing until Trusted Publishing is configured             |

The release-please and publish jobs run in the `release` environment.

The release GitHub App must be installed on this repository with `Contents:
write`, `Pull requests: write`, and `Workflows: write` permissions. The workflow
permission is required because an upstream release commit can update files under
`.github/workflows`. Its installation on `OldKrab/OpenAIDE` needs `Actions:
write` so the publish workflow can dispatch the pin update there.
