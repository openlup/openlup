# OpenLup starter application

This application was extracted from the OpenLup starter. It uses the
`@openlup/core`, `@openlup/outbox` and `@openlup/platform` packages through their
public entries, with application-owned configuration, browser pages and a local
host. It is a development preview, not a supported production installation.

Read the OpenLup guide that ships with your installed packages before relying
on memory: `node_modules/@openlup/core/docs/guide/README.md`. Its page
`how-to/build/customize-the-starter.md` explains how to import the package
archives, run the local demonstration, edit and refresh, customize the
configuration and upgrade the files this application manages.

Candidate extraction uses local package archives; import them before installing
dependencies. Released or reconstructed extraction uses exact public npm pins;
install from its committed registry lockfile with `npm ci` (see `docs/proof.md`).

After installing dependencies, build and
serve the database-free demonstration with the `build` and `start` package
scripts; on macOS and Linux the `dev` script runs the watched edit loop.
This preview supplies one-time estimates; subscription prices require the
installed local demonstration. Its localized `host_binding_required` guidance
points to `./lifecycle up`. Installed quotes serve both purchase modes. Known
price refusals explain a repair using `owned/quote-copy.ts`; unknown failures
remain generic, and a failed refresh withholds the previous price.
After a successful candidate import prints `next: npm ci`, run `npm ci` before
starting the application.

`AGENTS.md` holds the instructions for coding agents working in this
application.
