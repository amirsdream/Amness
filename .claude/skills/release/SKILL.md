---
name: release
description: cut and stage a new npm release of amness (version bump, changelog, tag, CI staging, approval)
---
CI stages the package; a human approves it with 2FA. Never run a direct `npm publish`, and never push a tag without the user's go-ahead.

1. Working tree clean, on `main`, up to date. Run the `check` skill.
2. Bump: `npm version <patch|minor> --no-git-tag-version`, so `package.json` and the tag will match. The workflow stages the version in `package.json`, whatever the tag says.
3. `CHANGELOG.md`: give the new version a heading with today's date and list user-visible changes.
4. Local proof: `npm run build`, `npm pack`, install the tarball in an empty folder, run `node_modules/.bin/amness --version` and `--help`. Also `npm stage publish --dry-run --access public`.
5. Commit, then (only with the user's OK) `git push`, `git tag -a vX.Y.Z -m "amness X.Y.Z"`, `git push origin vX.Y.Z`, and `gh release create vX.Y.Z --notes-file <changelog section>`.
6. Watch `gh run watch` on the "Publish to npm" run (typecheck, tests, `npm stage publish --provenance`).
7. Tell the user to finish: `npm stage list amness`, `npm stage download <id>`, then `npm stage approve <id>` (2FA) or `npm stage reject <id>`.

The `NPM_TOKEN` repo secret is a stage-only token. It cannot publish directly.
