# Releasing Lionscope

The npm package, workspace packages, Android SDK/no-op, MCP metadata, plugin pins and packaged skill share one
release version. Device and dashboard protocol versions change only when their compatibility contracts change.
Run `npm run release:check` to check package/lockfile versions and active installation instructions together.

## Prepare

1. Agree the feature scope and merge its PRs into `main`. A local integration candidate is useful for testing,
   but is not a substitute for those reviewed merges. Exclude unrelated local work and research.
2. Bump all workspace manifest versions and internal dependencies, regenerate the lockfile without upgrading
   external dependencies, and update Android, MCP/plugin/skill metadata plus current SDK installation snippets.
   Leave historical fixtures and minimum-supported-version references unchanged.
3. Move `[Unreleased]` into the versioned changelog section, keep a fresh `[Unreleased]` section, update comparison
   links and prepare release notes. Set the date to the actual release date when publishing.
4. Run the CI contract, including `release:check`, TypeScript checks/tests, Chromium layout cases, CLI build,
   Android debug/release/OkHttp 5 tests, no-op/sample builds and the vendored UI-helper checksum comparison.
5. Pack the CLI after building, install that tarball in a temporary consumer directory, and smoke-test version,
   help, foreground serving and background start/status/logs/stop with isolated state and ports. Check Node
   22.12 compatibility. Record artifact checksums and any failed checks or unverified platforms.
6. Run JitPack's Gradle publication tasks into an isolated local Maven repository using `JITPACK=true` and
   `VERSION=<release-version>`. Check both AARs, POM coordinates and embedded SDK version. This does not publish
   to JitPack or npm. Keep the release commit separate from feature scopes.

## Publish after approval

Use the final reviewed `main` commit, not an integration candidate whose feature PRs are still open. Reapply
the prepared release commit after those PRs merge if needed, resolve conflicts, and rerun affected checks.

For 0.13.0, the tag convention is `0.13.0` (no `v` prefix), matching existing releases. Confirm that npm has not
already published it and that the tag is unused. Once publication is authorized:

1. Create and push the annotated version tag at the approved release commit. Never move a published tag.
2. Publish the exact tested npm tarball with `npm publish <tarball> --access public`; confirm the registry version,
   integrity and `latest` dist-tag. npm versions are immutable, so do not rebuild a different artifact under the
   same version after publication. See [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
3. Trigger/check the JitPack build for that tag and resolve both `lionscope` and `lionscope-noop` coordinates from
   a clean consumer. Local Maven publication does not prove remote JitPack availability. See
   [JitPack's build procedure](https://docs.jitpack.io/building/).
4. Create the GitHub release using the prepared notes and final commit/tag. Update the notes' preparation status.
5. Publish the updated `server.json` through the project's MCP registry publisher if that distribution is used;
   a GitHub tag alone does not update the registry. Verify plugin metadata points to the published npm version.
   See the [MCP registry publication guide](https://modelcontextprotocol.io/registry/quickstart).
6. Smoke-test a clean `npx -y lionscope@<version>` install and the matching debug/no-op SDK integration. Retain
   the evidence and close the release checklist. Do not overwrite a running user's profiling session to do this.

Version 0.13.0's [notes](releases/0.13.0.md) and [candidate verification](verification/release-0.13.0.md) list its
scope and current blockers.
