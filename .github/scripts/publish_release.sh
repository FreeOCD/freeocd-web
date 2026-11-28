#!/usr/bin/env bash
set -euo pipefail

number='(0|[1-9][0-9]*)'
pre_id="$number|[0-9]*[A-Za-z-][0-9A-Za-z-]*"
tag_semver="$number\\.$number\\.$number(-($pre_id)(\\.($pre_id))*)?"

case "${1:-}" in
  --check-version)
    [[ "$2" =~ ^$tag_semver$ ]] || { printf 'Invalid release version: %s\n' "$2" >&2; exit 1; }
    exit 0
    ;;
  --check-vsix-tag)
    [[ "$GITHUB_REF_NAME" =~ ^v$tag_semver$ ]] || { printf 'Invalid release tag\n' >&2; exit 1; }
    [[ "${GITHUB_REF_NAME%%-*}" == "v$2" ]] || { printf 'Tag does not match package version v%s\n' "$2" >&2; exit 1; }
    exit 0
    ;;
esac

[[ "$GITHUB_REF_NAME" =~ ^v$tag_semver$ ]] || { printf 'Invalid release tag\n' >&2; exit 1; }
[[ "${1:-}" != --check-tag ]] || exit 0
[[ "$#" -gt 0 ]] || { printf 'No release assets\n' >&2; exit 1; }
flags=(--verify-tag --generate-notes)
if [[ "$GITHUB_REF_NAME" == *-* ]]; then
  flags+=(--prerelease --latest=false)
fi
gh release create "$GITHUB_REF_NAME" "${flags[@]}" "$@"
