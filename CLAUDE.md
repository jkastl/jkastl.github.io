# Working in this repo

## Always start from the latest code

Before any development work (and again when resuming a session, before committing, and before
opening a pull request), make sure the work sits on the latest code:

1. `git fetch origin` for the default branch (`main`) and the working branch.
2. Check:
   - Is the working branch behind `origin/main`? (`git log HEAD..origin/main`)
   - Does the remote working branch have commits that aren't local?
   - Has the working branch's pull request already been merged?
3. If anything is behind, bring the branch up to date before writing code: merge `origin/main`
   in, or, if the branch's PR has merged, start the work again from the latest `main`.
4. If the fetch or update fails, hits conflicts, or would need a force push or other history
   rewrite: stop and raise it with the user before going on. Don't build on code that may be
   stale.
5. Say briefly what the check found (e.g. "up to date with main", or "main had 3 new commits,
   merged them in").
