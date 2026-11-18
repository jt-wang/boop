# Build or upload TestFlight from a cloud agent

An agent with **Actions: write** access to this repository can request a signed iOS build without holding an Apple private key. Signing happens on a disposable GitHub macOS runner. The repository owner first configures the `testflight` environment below.

From the default branch, select the current commit, the version already in `mobile/nsh.json`, and an unused build number. For example, this builds version 0.1.4 with native build number 4:

```sh
sha=$(gh api repos/jt-wang/boop/commits/main --jq .sha)
gh workflow run testflight.yml --repo jt-wang/boop --ref main \
  -f source_sha="$sha" -f version=0.1.4 -f build=4 -f upload=false
gh run list --repo jt-wang/boop --workflow testflight.yml
gh run view RUN_ID --repo jt-wang/boop --log-failed
```

`upload=false` is the default: it builds a signed IPA, checks its ZIP contents, bundle identifier, version, build number and code signature. It does **not** inject an ASC key or contact App Store Connect. The IPA stays on the runner; no signing files or build artifacts are published by this workflow.

To send a build to TestFlight, use `upload=true` and a build number not already used for that app version. Only then does the workflow use the ASC key, validate the IPA with Apple, and upload after validation succeeds. An upload receipt means Apple received the package; processing and availability to testers are separate. This workflow does not submit App Store review, create external tester groups or publish a public link.

## Owner setup, once

Create the GitHub environment **`testflight`**. Under deployment branches and tags, choose selected branches and allow only the repository's default branch, currently `main`. Do this **before adding secrets**. A required reviewer is optional; it is not needed for the agent-triggered flow.

Put these secrets in that environment, not at repository scope:

| Name | Value and use |
|---|---|
| `APPLE_TEAM_ID` | Team owning `io.jingtao.boop`; checked against the profile and passed to Xcode. |
| `IOS_DISTRIBUTION_P12_BASE64` | Base64 of an exported Apple Distribution certificate **with its private key**; imported into a temporary keychain. |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Password used when exporting that p12. |
| `IOS_PROVISION_PROFILE_BASE64` | Base64 of an unexpired App Store distribution profile for `io.jingtao.boop`, with production push; its certificate must match the p12. |
| `ASC_KEY_ID` | App Store Connect team API key ID; used only with `upload=true`. |
| `ASC_ISSUER_ID` | Issuer for that API key; used only with `upload=true`. |
| `ASC_PRIVATE_KEY_P8` | The complete p8 file text, not base64; used only with `upload=true`. |

The first four secrets suffice for a local-check build. Uploads require all seven and an existing App Store Connect app record for the bundle identifier. An ASC API key does not supply the private signing identity: export the Distribution identity to p12 and use its matching App Store profile. Do not put these files or values in a checkout, issue, agent prompt or workflow input.

Use a fine-grained GitHub credential scoped to this repository with Actions write for the cloud agent. The job itself has only Contents read permission. Keep environment administration and Apple key management with the owner.

## Source and dependencies

Only `workflow_dispatch` is configured. There is no push or PR upload trigger. The job and environment accept only the default branch. The input SHA must match `GITHUB_SHA` and `GITHUB_WORKFLOW_SHA`; `GITHUB_WORKFLOW_REF` must identify this workflow on that branch. Checkout uses that exact SHA. A branch moving between reading its SHA and dispatching makes the check fail; read its new SHA before retrying.

The workflow uses the standard arm64 `macos-15` runner and Xcode 26.3. Dependency preparation also checks the runtime architecture. See GitHub's [runner label table](https://github.com/actions/runner-images#available-images) and [macOS 15 arm64 image](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md). It builds the committed Xcode project; xcodegen is not used.

`scripts/testflight-deps.py` pins the stock NSH 0.4.0 macOS CLI and iOS framework to release asset SHA-256 values, matching this app's NSH 0.4 API. TailPocket is checked out at `3c19dca9e2e1ea1208deedc705fb7e4e9bf6fa83`, the revision used for the iOS 27 pairing and recovery checks, and built with the Go toolchain in its `go.mod`; Node 24 is prepared for the existing app build. No Apple secret is passed to the dependency step.

The runner uses a temporary signing keychain and profile, manual archive/export settings and the existing `ios-build.sh`/`ios-upload.sh` scripts. Cleanup runs after success or failure, with an `always()` step for cancellation and retryable cleanup failures. The standalone `scripts/ios-upload.sh` keeps its existing behavior: invoking it validates and then uploads.

## Failure and local checks

Missing configuration, an untrusted ref/SHA, an invalid profile, an unmatched certificate, build failures and package-check failures stop the job. No upload runs after a failed validation. Secret-bearing subprocess arguments and exception values are not printed. The phase and exit status identify the failing boundary; a successful local check is not an Apple validation result.

Maintainers can check the control flow without Xcode or Apple credentials:

```sh
python3 -B -m unittest discover -s test -p testflight_ci_test.py
node --test test/ios-release.test.ts
```

These tests use synthetic signing material and a small Go process fixture. They cover refusals, explicit upload, failure propagation and cleanup. A hosted `upload=false` run is still required to verify the real dependency, compiler and signing chain.
