# Contributing & release process

Small project, light process — but everything now goes through a branch and a PR
so `master` stays releasable and CI-green.

## Branching

`master` is the always-deployable trunk. Don't commit to it directly — branch off it:

```bash
git switch master && git pull
git switch -c feat/short-description   # or fix/… or chore/…
```

Prefixes: `feat/` (new feature), `fix/` (bug fix), `chore/` (tooling/docs/deps),
`refactor/`, `docs/`. Keep branches short-lived and focused.

## Pull requests

1. Push the branch and open a PR against `master` (`gh pr create --fill`).
2. CI (`.github/workflows/ci.yml`) runs `npm run typecheck` and `npm test` on every
   PR — it must be green to merge.
3. Fill in the PR template, and add a line to **CHANGELOG.md** under `[Unreleased]`
   if the change is user-facing.
4. Merge with **Squash and merge** so `master` keeps one tidy commit per PR.

Recommended: protect `master` so it can only change via a green PR. Easiest in
the GitHub UI — **Settings → Branches → Add branch ruleset**, targeting `master`:
enable *Require a pull request before merging* and *Require status checks to pass*
with the `test` check selected.

Or via the API with a JSON payload (avoids the flaky inline-field escaping):

```bash
gh api -X PUT repos/taberno/taberno/branches/master/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["test"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null
}
JSON
```

## Versioning & releases

Versioning is **automated** — do **not** run `npm version` by hand. On every merge
to `master`, [`.github/workflows/version-bump.yml`](.github/workflows/version-bump.yml)
bumps `package.json` + `package-lock.json`, commits `chore(release): vX.Y.Z`, creates
the `vX.Y.Z` tag, and pushes it all back. Follows
[Semantic Versioning](https://semver.org) (pre-1.0: minor = features, patch = fixes).

The bump **size** comes from the merged branch's prefix. Merge-commit merges (the
default here) carry the branch name in the commit message, so this just works — name
the branch accordingly:

| Merged branch                              | Bump  |
| ------------------------------------------ | ----- |
| `feat/*`, `feature/*`                      | minor |
| `fix/*`, `chore/*`, `docs/*`, other        | patch |
| `feat!/*`, or `BREAKING CHANGE` in the body | major |

If you switch to **Squash and merge**, the classifier falls back to the squash
commit's subject, so keep PR titles in `type: summary` form (`feat: …`, `fix: …`).

**CHANGELOG.md is still updated by hand** — move the `[Unreleased]` notes under a new
version heading as part of the PR (the workflow only touches the version + tag).

### One-time setup

The workflow pushes the release commit to `master`, so:

1. **Settings → Actions → General → Workflow permissions** must be **Read and write
   permissions** (so `GITHUB_TOKEN` can push).
2. If `master` is protected with *Require a pull request before merging* (as
   recommended above), `GITHUB_TOKEN` can't push directly. Either add a **bypass
   actor** for the `github-actions` bot in the branch ruleset, or run the workflow's
   checkout with a fine-grained PAT / GitHub App token that's on the bypass list
   (set it as the `token:` on `actions/checkout`). A PAT push *does* re-trigger
   workflows, which is why the release commit carries `[skip ci]` and the job skips
   its own `chore(release):` commits.

CI runs on every push to `master` and every PR, so each release commit is built on
already-tested code.
