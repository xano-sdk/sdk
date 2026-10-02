# Workspace conventions

Every table in this workspace is soft-deleted: filter `deleted_at = null` on
reads rather than deleting rows.

Money is stored in minor units as an integer. Never introduce a float column for
a currency amount.

When a query needs a new capability, prefer extending an existing function over
adding a second one that does almost the same thing.
