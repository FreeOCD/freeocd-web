#!/usr/bin/env bash
set -euo pipefail

validator=$(realpath "$(dirname "$0")/validate_release.sh")
publisher=$(realpath "$(dirname "$0")/publish_release.sh")
version_check=$(realpath "$(dirname "$0")/../../scripts/check-version.js")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

git init -q
git -c user.name=Tester -c user.email=release@example.invalid commit --allow-empty -qm main
git update-ref refs/remotes/origin/main HEAD
GITHUB_SHA=$(git rev-parse HEAD)
export GITHUB_SHA
export GITHUB_EVENT_NAME=push GITHUB_REF_NAME=v1.2.3 GITHUB_REF=refs/tags/v1.2.3 GITHUB_REPOSITORY=test/test
export GITHUB_EVENT_PATH="$tmp/event.json"
printf '{"deleted":false}\n' > "$GITHUB_EVENT_PATH"
git -c tag.gpgSign=false tag v1.2.3

gh() {
  local arg response paginate=false slurp=false
  if [[ "$1" == release && "$2" == create ]]; then
    printf '%s\n' "$@"
    return
  fi
  case "$*" in
    *deployment-branch-policies*) response=$POLICIES ;;
    *'/releases?'*)
      [[ "${RELEASES:-}" != 'api-error' ]] || return 1
      response=$RELEASES
      ;;
    *'/environments/production') printf '%s\n' "$ENVIRONMENT"; return ;;
    *) return 1 ;;
  esac
  for arg in "$@"; do
    case "$arg" in
      --paginate) paginate=true ;;
      --slurp) slurp=true ;;
    esac
  done
  if [[ "$paginate" == true && "$slurp" == true ]]; then
    printf '%s\n' "$response"
  else
    jq -c '.[0]' <<< "$response"
  fi
}
export -f gh
export ENVIRONMENT='{"can_admins_bypass":false,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"protection_rules":[{"type":"required_reviewers","reviewers":[{}]}]}'
export POLICIES='[{"branch_policies":[{"type":"tag","name":"v*"}]}]'
export RELEASES='[[]]'

reject() {
  local message=$1 output
  shift
  if output=$("$@" 2>&1) || [[ "$output" != *"$message"* ]]; then
    printf 'Expected rejection: %s\n%s\n' "$message" "$output" >&2
    exit 1
  fi
}

bash "$validator"
git -c tag.gpgSign=false -c user.name=Tester -c user.email=release@example.invalid tag -a v1.2.4 -m test
GITHUB_REF_NAME=v1.2.4 GITHUB_REF=refs/tags/v1.2.4 bash "$validator"
git update-ref refs/tags/v1.2.5 refs/tags/v1.2.4
GITHUB_REF_NAME=v1.2.5 GITHUB_REF=refs/tags/v1.2.5 reject 'Annotated tag name does not match' bash "$validator"
GITHUB_REF_NAME=v1.2.4 reject 'Tag name does not match' bash "$validator"
GITHUB_EVENT_PATH=/dev/null reject 'non-deletion tag push' bash "$validator"
printf '{"deleted":true}\n' > "$GITHUB_EVENT_PATH"
reject 'non-deletion tag push' bash "$validator"
printf '{"deleted":false}\n' > "$GITHUB_EVENT_PATH"
git -c user.name=Tester -c user.email=release@example.invalid commit --allow-empty -qm off-main
reject 'push event, and checkout' bash "$validator"
git -c tag.gpgSign=false tag v1.2.6
GITHUB_REF_NAME=v1.2.6 GITHUB_REF=refs/tags/v1.2.6 GITHUB_SHA="$(git rev-parse HEAD)" \
  reject 'in main history' bash "$validator"
ENVIRONMENT="$(jq -c '.can_admins_bypass = true' <<< "$ENVIRONMENT")" \
  reject 'disallow administrator bypass' bash "$validator" --publish-check
ENVIRONMENT="$(jq -c '.protection_rules = []' <<< "$ENVIRONMENT")" \
  reject 'require reviewers' bash "$validator" --publish-check
POLICIES='[{"branch_policies":[{"type":"tag","name":"v*"}]},{"branch_policies":[{"type":"branch","name":"main"}]}]' \
  reject 'only the v* tag policy' bash "$validator" --publish-check
POLICIES='null' reject 'only the v* tag policy' bash "$validator" --publish-check
bash "$validator" --publish-check
RELEASES='[[],[{"tag_name":"v1.2.3","draft":false}]]' \
  reject 'no existing Release' bash "$validator" --publish-check
RELEASES='[[{"tag_name":"v1.2.3","draft":true}]]' \
  reject 'no existing Release' bash "$validator" --publish-check
RELEASES='api-error' reject 'no existing Release' bash "$validator" --publish-check
RELEASES='[]' reject 'no existing Release' bash "$validator" --publish-check
RELEASES='[{"unexpected":[]}]' reject 'no existing Release' bash "$validator" --publish-check

touch 'artifact file.zip'
check_publish() {
  local tag=$1 actual expected
  shift
  actual=$(GITHUB_REF_NAME="$tag" bash "$publisher" 'artifact file.zip')
  expected=$(printf '%s\n' release create "$tag" --verify-tag --generate-notes "$@" \
    'artifact file.zip')
  if [[ "$actual" != "$expected" ]]; then
    printf 'Unexpected release command for %s:\n%s\n' "$tag" "$actual" >&2
    exit 1
  fi
}

reject 'Invalid SemVer' bash "$publisher" --check-version 1.02.3
reject 'Invalid SemVer' bash "$publisher" --check-version 1.2.3-rc.01
bash "$publisher" --check-version 1.2.3-rc.1+linux
GITHUB_REF_NAME=v1.2.3-rc.1 bash "$publisher" --check-vsix-tag 1.2.3
GITHUB_REF_NAME=v1.2.4-rc.1 reject 'Tag does not match' bash "$publisher" --check-vsix-tag 1.2.3
check_publish v1.2.3
GITHUB_REF_NAME=v1.2.3+build-linux reject 'Invalid release tag' bash "$validator"
GITHUB_REF_NAME=v1.2.3+build-linux reject 'Invalid release tag' bash "$publisher" 'artifact file.zip'
check_publish v1.2.3-rc.1 --prerelease --latest=false
GITHUB_REF_NAME=v1.2.3-rc.1+build-linux reject 'Invalid release tag' bash "$validator" --publish-check

mkdir scripts
cp "$version_check" scripts/
printf '%s\n' '{"version":"1.2.3-rc.1"}' > package.json
printf '%s\n' '{"version":"1.2.3-rc.1","packages":{"":{"version":"1.2.3-rc.1"}}}' > package-lock.json
GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v1.2.3-rc.1 node scripts/check-version.js
GITHUB_REF_TYPE=tag reject 'does not match package.json' node scripts/check-version.js
printf '%s\n' '{"version":"1.2.3-rc.01"}' > package.json
reject 'is not valid SemVer' node scripts/check-version.js
printf 'Release policy tests passed.\n'
