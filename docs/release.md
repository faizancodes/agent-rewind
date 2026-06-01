# Releasing AgentRewind

This workspace publishes seven packages:

- `@agentrewind/sdk`
- `@agentrewind/core`
- `@agentrewind/cli`
- `@agentrewind/test`
- `@agentrewind/codec-openai`
- `@agentrewind/codec-openrouter`
- `@agentrewind/codec-anthropic`

Use `pnpm` for publishing. The package manifests intentionally use
`workspace:*` internally during development; `pnpm pack` and `pnpm publish`
rewrite those dependencies to the current package version in the published
tarballs.

Before publishing:

```sh
pnpm release:check
pnpm check
pnpm publish:dry-run
```

`pnpm check` includes typecheck, split unit/CLI tests, build, examples, and a
packed-package import/bin smoke test. Inspect `.npm-pack/*.tgz` if you need to
verify exact package contents.

When the dry run is clean and the npm account has access to the `@agentrewind`
scope:

```sh
npm login
pnpm publish:npm
```

`publish:npm` runs the npm version gate before publishing and passes npm
provenance metadata. Tagged GitHub Actions releases run the same publish command
with `id-token: write`.

For the first scoped release, the npm account must own or have publish access
to the `@agentrewind` scope. The scoped packages include
`publishConfig.access=public` so first publication does not require passing
`--access public` by hand.
