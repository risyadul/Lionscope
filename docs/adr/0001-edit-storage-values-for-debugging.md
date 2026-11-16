---
status: accepted
---

# Edit app-owned Storage values for debugging

Lionscope's Storage Inspector is a debugging editor: app-owned values, including credentials and primary keys,
should be readable and editable rather than hidden or locked because of their names or sensitivity. Database
constraints still apply, so duplicate keys or invalid references must fail rather than be forced through; the
initial scope is editing existing values, including dashboard editors for BLOBs and string sets, rather than
adding rows, creating preferences, or renaming preference keys. This decision applies to Storage only; Network
and Layout Inspector redaction policies are outside this change.

[ADR 0003](0003-add-a-database-query-workbench.md) extends this initial scope with a separate SQL Query console,
including inserts and direct mutations. The row-editor contract below remains in effect.

## Access and editing

Dashboard and AI agents receive the same original Storage values, including credentials, under the existing
`--allow-storage-read` and `--allow-storage-write` permissions, without another unredaction flag or toggle.
Room editing uses a per-row draft and an explicit Apply action that submits changed columns together in one
transaction, including composite primary-key changes; preferences remain edits of one existing key at a time.

Views, virtual/internal tables, encrypted storage, truncated values, and unsupported deferred-foreign-key cases
retain their technical read-only or unsupported restrictions, with an explanation in the UI. Removing
sensitivity-based restrictions does not remove these limitations.

## Drafts and conflicts

The Storage workspace presents databases and tables on the left, a grid in the center, and a row editor on the
right; at narrow widths the row editor becomes a sheet. Changed fields are marked, and Apply and Discard are
explicit actions.

If the app changes an edited field after it was read, Apply rejects the entire draft and preserves it alongside
the current values for comparison. It must not silently overwrite or merge the app's changes. A confirmed
missing row clears its associated draft; a successful primary-key change instead carries the selection and
subsequent operations forward to the confirmed new row identity.

## Reverting an edit

Revert row edit restores all fields changed by one successful Apply, including primary-key fields, in one
conditional operation. It is offered only for a confirmed, final, eligible result on the same app link, and
refuses to overwrite intervening changes to those fields. Trigger and cascade effects follow database rules;
reverting the edited fields is not a promise to restore the entire database or remove trigger-created audit
records. Existing uncertainty handling remains: no automatic retry after a timeout or disconnect, and no undo
offer for an unconfirmed outcome.

## Consequences

This user-approved decision supersedes the older credential-redaction and primary-key restrictions for
Storage in repository guidance. Other Storage access, integrity, and technical read-only restrictions remain. Primary-key edits require a row's identity to follow a confirmed key change, including subsequent
reads and eligible undo, rather than continuing to target the old key.

## Implementation status

Implemented with device protocol 12 for original Storage values and atomic row edits. Older negotiated links
retain their legacy restrictions; single-field Room drafts can use the v11 scalar update. JVM tests and synthetic
dashboard browser checks cover the new behavior; these checks do not establish runtime behavior on an Android
device or additional API/Room versions.
