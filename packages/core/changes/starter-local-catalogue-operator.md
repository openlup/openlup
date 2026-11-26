### Run the catalogue demonstration on a free local port

Export `OPENLUP_STARTER_PORT` before starting the demonstration and running
`catalogue:apply`. An unset or empty value uses 4319. Choose a decimal port
from 1024 to 65535 that Fetch permits. Startup refuses an invalid value before
starting Compose. Direct host startup reports how to correct `--port`.

The upgrade replaces pristine managed Compose, host, lifecycle and README files.
If upgrade refuses a locally edited managed file, save your edits and restore
the predecessor bytes before applying the upgrade. Move a local port edit to
`OPENLUP_STARTER_PORT` in your launch environment. Reconcile other edits with
the updated files before startup and keep unrelated owned overrides. If startup
refuses following an interrupted upgrade, complete the managed upgrade and use
the startup remedy before retrying. There is no installed business-policy step.
