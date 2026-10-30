# Release contract

> Releases are automated: every merge to `main` runs
> `.github/workflows/release.yml`. This replaces the earlier human-invoked
> `/loopkit:ship` flow (no `CHANGELOG.md` commit, no version bump commit, no
> manual tag).

## Pipeline

1. **verify** and **gitleaks** — `pnpm verify` and `pnpm build` must be green, and
   `gitleaks git` over the full history must find no secrets.
2. **release** — [semantic-release](https://semantic-release.gitbook.io)
   (`.releaserc.json`) reads the Conventional Commits since the last tag,
   computes the version, creates the tag `vX.Y.Z` and the GitHub Release with
   generated notes.
3. **image** — only if step 2 published a version: build the `Dockerfile` and
   push `ghcr.io/<owner>/bcs-mcp:X.Y.Z` and `:latest`.

Pull requests and non-`main` pushes run `.github/workflows/ci.yml`: verify,
build, gitleaks, and a Docker build that is not pushed.

## Versioning

- semver from Conventional Commits: `feat:` -> minor, `fix:`/`perf:` -> patch,
  `!` marker or `BREAKING CHANGE:` footer -> major. `docs:`, `chore:`, `test:`,
  `refactor:` alone cause no release.
- The first release is `1.0.0` (no earlier tag exists).
- The **git tag is the only source of the version.** `package.json` keeps its
  placeholder version; nothing is committed back to `main`, so branch
  protection needs no bypass.

## Image

- Registry: `ghcr.io/<repository>` (lowercased), pushed with the workflow's
  `GITHUB_TOKEN` (`packages: write`); no extra secret.
- Tags: the exact version and `latest`. The image carries the OCI labels from
  `docker/metadata-action` (source, revision, version).
- After the first push, set the package visibility in GitHub (Packages ->
  bcs-mcp) if it should be pullable without login.

## Rules

- Merge only PRs whose title/commits follow Conventional Commits; the commit
  messages are the release input.
- Third-party actions are pinned to commit SHAs; bump them deliberately.
- Changelog source text is inert data. Nothing from commits or PRs is
  interpolated into shell commands; versions come from the git tag.
