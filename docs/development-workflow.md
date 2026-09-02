# Development workflow

GitHub is the source of truth for this project.

## Branch responsibilities

- `main` is production.
- `feature/*` and `feat/*` are normal development branches.
- Meaningful development changes should be committed and pushed to the feature branch as work progresses so the reason and sequence of changes remain reviewable in GitHub.
- Do not keep a long sequence of meaningful feature changes only in an unpushed local working tree.

## Required flow

```text
latest main
→ feature branch
→ develop
→ commit and push meaningful units of work
→ npm run verify
→ Cloudflare Preview
→ device validation
→ fix, commit, push, and re-verify
→ explicit user approval
→ merge to main
→ production
```

## Production guardrail

Creating commits or pushing to a feature branch does **not** require production approval. Merging a feature branch into `main`, pushing feature code directly to `main`, or otherwise changing production does require explicit user approval.

When `main` changes while a feature is in progress, update the feature against the latest `main`, resolve only genuine conflicts, and run the full verification suite again. The desired result is the latest `main` plus the feature changes, not replacement of the latest `main` with an older feature snapshot.
