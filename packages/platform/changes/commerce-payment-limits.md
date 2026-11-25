- Add experimental native PostgreSQL payment limits with owner installation, revisioned rollback and a restricted active reader.
- Discover `commerce.money_limits.v2` offline. Connected show requires an owner inspection binding and returns `money_limits_reader_unbound` when that binding is absent.

Migration: Apply the native PostgreSQL forward during the normal upgrade. Existing checkout requires no settings changes. To opt in to installed limits, install terms for a qualified rail and bind owner inspection in the settings app.
