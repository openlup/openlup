- `@openlup/platform/catalog` releases the secondary snapshot probe connection in the catalog admission fence immediately after its visibility probe settles instead of holding it through the checkout read and commit.

Migration: None. Existing callers require no code or schema changes.
