# Hello Roku

A complete standalone consumer with a normal React component and
`roku.config.json`. It builds from its own source and configuration.

With Node 24.18.1 and pnpm 11.23.0:

```sh
pnpm install
pnpm run doctor
pnpm typecheck
pnpm dev
pnpm build
```

The browser Canvas preview watches and reloads successful changes on port 9389;
compile errors keep the last good app visible. This is full reload, not React
Fast Refresh. The finite build writes `dist/roku-app.zip`. The generated `.roku/`
project owns SDK Scene/Main/anchor files and native helpers; edit your component
or config instead. No command installs a channel or deploys to a device.

Before publication, create this template through the platform repository's
`react-native-roku init` command with an explicit `--package=file:/absolute/path/to/platform.tgz`.
See its getting-started guide. The template uses Inter; retain that dependency's
font license when redistributing assets. Browser/SDK checks do not qualify
physical Roku rendering, networking, focus, video or sustained performance.

## Browse the catalog

Set `entry` to `src/Catalog.tsx` in `roku.config.json` and run the same preview
or build commands. The example uses a bundled image and 72 routes in a
four-column virtualized list. Card 2 is disabled. Move down past the initial
viewport, open a route, then use Back to return to the same card and scroll
offset. Route information opens a modal. Dismiss it to return focus to the
information button.
