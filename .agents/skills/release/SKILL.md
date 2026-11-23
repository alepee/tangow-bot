---
name: release
description: Release Tangow clients with automatic Home Assistant style calendar versions based on changes, production iOS EAS build and submission, desktop packaging and installation, and a GitHub Release with the IPA, the DMG and the macOS update feed. Use for /release, release desktop, or release mobile. With no argument, release both clients.
---

# Release

Run this workflow from the Tangow checkout on macOS. Invoking it authorizes the
selected version changes and their release commit, builds, iOS submission, local
desktop installation, tag push, and GitHub Release publication. A request to
create or edit this skill does not run a release.

## Select the targets

| Invocation | Targets | GitHub assets |
| --- | --- | --- |
| `/release` | Desktop and iOS | Fresh DMG, update feed and IPA |
| `/release desktop` | Desktop | Fresh DMG and update feed |
| `/release mobile` | iOS only | Fresh IPA |

Accept the same arguments when invoked as `$release` or in natural language.
Reject an unknown target before running builds. Never build Android. Always
produce native release artifacts, even when an OTA update would be possible.

## Establish the release revision

- Read `apps/desktop/package.json`, `apps/mobile/package.json`, `apps/mobile/app.json`,
  `apps/mobile/eas.json`, and [mobile release guidance](../../../docs/mobile-release.md).
  Use the current scripts and configuration as the source of truth.
- Require a clean checkout and record the full `git rev-parse HEAD` as
  `source_sha`. Stop on pre-existing uncommitted changes rather than committing them.
  Confirm the revision is intended for release from the request and branch context.
- Resolve the GitHub repository from the checkout with `gh repo view`. Verify
  `gh auth status`, dependencies, and signing credentials through the existing
  private configuration. For mobile, verify EAS authentication with
  `npx eas-cli@latest whoami` from `apps/mobile` and run
  `pnpm --filter @tangow/mobile exec expo install --check` from the root.
  Do not print credentials, disable signing or notarization, or commit build outputs.
- Record which output files already exist. Use only artifacts produced by this run,
  never an old IPA or a DMG selected merely because it is the newest in a directory.

## Determine and commit versions

Follow [Home Assistant calendar versioning](https://contributors.home-assistant.io/releases/reference/versions/):
`YYYY.M.PATCH`, with an unpadded month and patch starting at `0`. Determine the
year and month at invocation using the operator's timezone. Do not choose a SemVer
major or minor bump from the size of a feature, and never invent a future month.
This adopts the version format, not Home Assistant's release-day schedule.

For each selected client, find its last published stable release, tag, version,
and source commit. Inspect GitHub Release assets and notes, not just tag names,
because older releases may use generic tags. Compare its commit with `source_sha`
using the actual diff, merged PRs, and changelog. Include shared dependencies,
configuration, and bundled assets. Desktop includes the bundled web app; iOS
includes mobile and the shared packages it imports. Distinguish features, fixes,
and breaking changes for release notes. Ignore docs-only, test-only, and version-only
changes when deciding whether a client changed. Do not infer impact from commit
prefixes alone. On the first release, use the existing client version as the
migration baseline and inspect the available history rather than claiming no changes.

Choose the version separately for desktop and iOS:

- A changed client with no published release in the current month starts at
  `YYYY.M.0`. This also migrates existing `0.x` or `1.x` versions to CalVer.
- A changed client already released this month uses the highest reserved patch
  for that client and month plus one. Include published releases, tags, and any
  already uploaded App Store Connect version when checking reservations. Compare
  numeric components, not strings. Never decrease a client version.
- An unchanged client keeps its published version. When both targets are selected
  and only one changed, still rebuild both artifacts as requested and describe
  the unchanged client as a rebuild. Its iOS build number must still increase.
- If no selected client changed, report that there is nothing new to release and
  stop before version changes, builds, submission, or publication. Resume an
  interrupted attempt instead of allocating another version for the same attempt.

For example, in November 2026, desktop `2026.11.2` with fixes becomes
`2026.11.3`; a changed iOS client last released as `2026.10.4` becomes
`2026.11.0`. A feature does not turn either version into `2027.0.0`.

Write the chosen desktop version to `apps/desktop/package.json`. Write the iOS
marketing version to `expo.version` in `apps/mobile/app.json` and keep
`apps/mobile/package.json` aligned. Leave unselected clients and unrelated
workspace package versions alone. Preserve `runtimeVersion.policy: appVersion`;
the new mobile marketing version intentionally establishes its own OTA runtime.
Keep `eas.json`'s remote version source and production `autoIncrement: true`.
EAS manages `ios.buildNumber` separately from the marketing version. Inspect the
remote build number with `eas build:version:get --platform ios --profile production`
and verify the resulting IPA has a higher build number before submission.

Use a supplied release tag, otherwise `desktop-<version>`, `mobile-<version>`, or
`desktop-<version>-mobile-<version>` for both. Check it locally and remotely before
building. If it already exists, inspect the matching release and resume only if
it belongs to this attempt; never repoint it or manufacture an empty release.

Use the change analysis to write public release notes per client, including old
and new versions, changes, and any migration steps for breaking changes. Update
`CHANGELOG.md` only for user-visible outcomes not already recorded, following the
repository's dated Unreleased format; do not duplicate entries just for a version
bump. Review `git status` and the exact staged diff, then commit only the intended
version, necessary lockfile metadata, and changelog changes. Do not bypass hooks.
Record this commit as `release_sha`; build and tag that exact revision. If a
retry finds an existing release preparation commit, reuse it and its versions.

## Build and submit iOS

Skip this section for `desktop`.

Use the existing local production build, which leaves the IPA available for GitHub.
Run from `apps/mobile`, stopping immediately on either command's failure:

```sh
mkdir -p builds
npx eas-cli@latest build --platform ios --profile production --local --output builds/tangow-production.ipa
npx eas-cli@latest submit --platform ios --profile production --path builds/tangow-production.ipa --wait
```

Before building, move an existing `builds/tangow-production.ipa` into an ignored
backup location so a failed build cannot be mistaken for a fresh artifact.
Require the new IPA to be nonempty before submission. Inspect its
`CFBundleShortVersionString` and `CFBundleVersion` to verify the chosen marketing
version and fresh build number before uploading it. Submit that exact file,
never `--latest`. Wait for the submission result and retain its reference.
The production profile increments the remote iOS build number. Do not submit
twice or rebuild automatically after a submission failure. Inspect the existing
submission before resuming.

EAS submission uploads to App Store Connect for TestFlight processing. It does
not itself publish the app on the App Store, and a production IPA cannot be
installed directly on an iPhone. Report those states accurately.

## Package and install desktop

Skip this section for `mobile`.

Run from `apps/desktop`:

```sh
npm run release
```

The `release` script builds the web app and packages only for the host, macOS:
no Windows or Linux build. Do not replace it with `pack` or `pack:dir` or silently
change the package scripts. Its `--publish never` reserves GitHub publication for
the final step.

Identify the fresh DMG under the configured `build.directories.output`, currently
`apps/desktop/out`. Check its app version against the package and its architecture
against the host. If the run produces several DMGs, keep the host-compatible one
for installation and attach all fresh DMGs for the requested architectures.
Do not pick an older file left in `out`.

From the same `out` run, also select the macOS update feed that installed
desktop apps read through electron-updater: `latest-mac.yml`, every `-mac.zip` it
names (one per architecture), and each ZIP's `.blockmap` when present. Require the yml's `version` to
equal the desktop version and every `files[].url` and `path` it lists to exist
next to it in `out`. Leave any `latest.yml`, `latest-linux.yml` or Windows and
Linux artifacts left in `out` by other runs out of the release. A missing
blockmap only costs clients a full download and must not fail the release.

Mount the selected DMG read-only with `hdiutil attach -readonly -nobrowse` and
record the mount point. Locate the `.app` inside it and read its bundle identifier,
name, and version rather than assuming the product is named Tangow. The current
desktop product name is Tangow.

Quit that app gracefully if running. Install the mounted `.app` into `/Applications`
using `ditto`, preserving its bundle metadata. Before replacing an existing app,
move it to a temporary backup outside the destination so removed files cannot
survive the upgrade. If copying fails, restore the backup and stop. If permissions
prevent installation, report the failure rather than silently installing elsewhere.
Detach the DMG even on failure.

Verify the installed bundle identifier and version match the mounted build, then
open the installed app and verify it launches. Keep the backup until verification
succeeds. Do not run the desktop Playwright suite on the maintainer's machine.

## Publish the GitHub Release

Publish only after every selected build, submission, and installation succeeds.
Confirm `HEAD` still equals `release_sha` and the tracked checkout is still clean.
Stage a copy of each selected artifact under the ignored `artifacts/` directory
with distinct release filenames. Keep the update feed files under their exact
electron-builder names: `latest-mac.yml` refers to each ZIP by name and checksum,
so a renamed file breaks every installed client's update. Require every file to
be nonempty. The default release requires the IPA, the DMG, `latest-mac.yml` and
every ZIP it lists; a desktop release requires all but the IPA. Never publish a partial release.

Push the recorded commit to the resolved GitHub remote if it is not already
available there, without force-pushing or merging branches. Create an annotated
tag at exactly `release_sha`, then push only that tag. Never move an existing tag.

Create one GitHub Release for this tag with `gh release create --verify-tag` and
the explicit artifact paths as positional arguments. Installed desktop apps only
look at the release marked Latest, so pass `--latest` when the release includes
desktop and `--latest=false` for an iOS-only release. Use `--repo` for the resolved
repository and `--notes-file` for concise public release notes describing the
selected clients, their versions, and the iOS submission status. Keep local paths,
account details, credentials, and raw tool logs out of release notes.

On interruption, inspect the remote tag and release before retrying. Reuse only
artifacts verified to belong to this revision. Resume a matching draft with
`gh release upload` and publish it only after all expected assets are present.
Do not replace published assets with `--clobber`, delete a release, move its tag,
or repeat an iOS submission without establishing what already succeeded.

Verify the remote tag resolves to `release_sha` and use `gh release view` to check
the published state and asset names and sizes against the local files. For a
desktop release, also confirm it is the Latest release and that the published
`latest-mac.yml` names the desktop version and only ZIPs attached to this release. Return
the release URL, tag, attached artifacts, installed desktop version, and iOS
submission result as applicable. If any stage fails, report the successful stages
and the precise stage to resume; do not claim the release is complete.
