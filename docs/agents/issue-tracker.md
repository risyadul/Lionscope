# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `risyadul/Lionscope`.
Use the `gh` CLI from this repository.

## Conventions

- Before the first issue creation in a session, verify the target with
  `gh repo view --json nameWithOwner`. It must be `risyadul/Lionscope`;
  resolve a mismatch with the user before publishing.
- Create: `gh issue create --title "..." --body-file <file>`.
  Write multiline bodies to a temporary file with actual newlines.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,assignees`.
  Add appropriate label and state filters.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."`,
  or `--remove-label "..."`.
- Close: post the explanation as a comment, then run `gh issue close <number>`.
  Post explanations separately even when the issue is already closed.

## Parent issues and blockers

Use GitHub native sub-issues and issue dependencies when available.
Consult the installed `gh` command help for supported operations.

If unavailable, put `Part of #<parent>` and `Blocked by: #<n>, #<n>`
at the top of the child body, and list children in the parent's task list.
A ticket is unblocked when every blocker is closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the GitHub issue.
