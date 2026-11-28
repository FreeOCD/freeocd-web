#!/usr/bin/env bash
set -euo pipefail

number='(0|[1-9][0-9]*)'
pre_id="$number|[0-9]*[A-Za-z-][0-9A-Za-z-]*"
semver="$number\\.$number\\.$number(-($pre_id)(\\.($pre_id))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?"

case "${1:-}" in
  --check-version)
    [[ "$2" =~ ^$semver$ ]] || { printf 'Invalid SemVer: %s\n' "$2" >&2; exit 1; }
    exit 0
    ;;
  --check-vsix-tag)
    [[ "$GITHUB_REF_NAME" =~ ^v$semver$ ]] || { printf 'Invalid release tag\n' >&2; exit 1; }
    core=${GITHUB_REF_NAME%%+*}
    [[ "${core%%-*}" == "v$2" ]] || { printf 'Tag does not match package version v%s\n' "$2" >&2; exit 1; }
    exit 0
    ;;
esac

[[ "$GITHUB_REF_NAME" =~ ^v$semver$ ]] || { printf 'Invalid release tag\n' >&2; exit 1; }
[[ "$#" -gt 0 ]] || { printf 'No release assets\n' >&2; exit 1; }
flags=(--verify-tag --generate-notes)
if [[ "${GITHUB_REF_NAME%%+*}" == *-* ]]; then
  flags+=(--prerelease --latest=false)
fi
gh release create "$GITHUB_REF_NAME" "${flags[@]}" "$@"
