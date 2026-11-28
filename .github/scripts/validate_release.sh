#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

if [[ "${1:-}" != --publish-check ]]; then
  [[ "$GITHUB_EVENT_NAME" == push && "$GITHUB_REF" == refs/tags/v* ]] ||
    fail "Expected a v* tag push"
  jq -es 'length == 1 and .[0].deleted == false' "$GITHUB_EVENT_PATH" >/dev/null ||
    fail "Expected a non-deletion tag push"
  [[ "$GITHUB_REF" == "refs/tags/$GITHUB_REF_NAME" ]] || fail "Tag name does not match the ref"
  if [[ "$(git cat-file -t "$GITHUB_REF")" == tag ]]; then
    tag_name=$(git cat-file tag "$GITHUB_REF" | sed -n '3s/^tag //p')
    [[ "$tag_name" == "$GITHUB_REF_NAME" ]] || fail "Annotated tag name does not match the ref"
  fi
  commit=$(git rev-parse --verify "$GITHUB_REF^{commit}") || fail "The tag must resolve to a commit"
  [[ "$commit" == "$(git rev-parse HEAD)" &&
     "$commit" == "$(git rev-parse "$GITHUB_SHA^{commit}")" ]] ||
    fail "Tag, push event, and checkout must point to the same commit"
  git merge-base --is-ancestor "$commit" refs/remotes/origin/main ||
    fail "The tagged commit must be in main history"
fi

endpoint="repos/$GITHUB_REPOSITORY/environments/production"
gh api "$endpoint" | jq -e '
  .can_admins_bypass == false and
  .deployment_branch_policy.protected_branches == false and
  .deployment_branch_policy.custom_branch_policies == true and
  any(.protection_rules[]; .type == "required_reviewers" and
    (.reviewers | type == "array" and length > 0))
' >/dev/null || fail "production must require reviewers and disallow administrator bypass"
gh api --paginate --slurp "$endpoint/deployment-branch-policies?per_page=100" | jq -e '
  length > 0 and
  all(.[]; .branch_policies | type == "array") and
  ([.[].branch_policies[] | {type, name}] == [{type: "tag", name: "v*"}])
' >/dev/null || fail "production must allow only the v* tag policy"

if [[ "${1:-}" == --publish-check ]]; then
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100" | jq -e --arg tag "$GITHUB_REF_NAME" '
    length > 0 and
    all(.[]; type == "array") and
    all(.[][]; (.tag_name | type == "string") and .tag_name != $tag)
  ' >/dev/null || fail "Cannot confirm there is no existing Release for $GITHUB_REF_NAME"
fi
