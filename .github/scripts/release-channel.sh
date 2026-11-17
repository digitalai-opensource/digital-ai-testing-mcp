#!/usr/bin/env bash
# Decides what a release run publishes, and refuses runs that would ship a branch build to `latest`.
#
# Inputs (environment):
#   INPUT_VERSION  optional; the workflow_dispatch `version` input (a leading "v" is ignored)
#   RELEASE_REF    the git ref being built (github.ref), e.g. refs/heads/main, refs/tags/v2.4.0
#   GITHUB_OUTPUT  file the step outputs are appended to (printed to stdout when unset)
#
# Rules:
#   - The version is INPUT_VERSION if given, else package.json's version.
#   - A version with a prerelease suffix (2.4.0-beta.1) goes to the `next` channel. It may be built from any
#     branch; package.json (and package-lock.json) are rewritten to that version in the runner only, so the
#     published package and image report it. Nothing is committed.
#   - A stable version (2.4.0) goes to the `latest` channel. It must equal package.json's version and may only
#     be built from main or a v* tag.
#
# Outputs: version, channel (latest|next), majorminor (stable only; empty for prereleases)
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

pkg_version=$(node -p "require('./package.json').version")
input="${INPUT_VERSION:-}"
input="${input#v}"
version="${input:-$pkg_version}"
ref="${RELEASE_REF:-}"

semver_re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'
[[ $version =~ $semver_re ]] || fail "\"$version\" is not a version like 2.4.0 or 2.4.0-beta.1"

if [[ $version == *-* ]]; then
  channel=next
  majorminor=
  if [[ $version != "$pkg_version" ]]; then
    npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
    echo "package.json set to $version for this run only (was $pkg_version)" >&2
  fi
else
  channel=latest
  [[ $version == "$pkg_version" ]] ||
    fail "stable version $version does not match package.json ($pkg_version); bump package.json on main instead"
  case "$ref" in
    refs/heads/main | refs/tags/v*) ;;
    *) fail "a stable release ($version) can only be built from main or a v* tag, not ${ref:-an unknown ref}; use a prerelease version such as $version-beta.1 for a branch build" ;;
  esac
  majorminor=$(echo "$version" | cut -d. -f1,2)
fi

out="${GITHUB_OUTPUT:-/dev/stdout}"
{
  echo "version=$version"
  echo "channel=$channel"
  echo "majorminor=$majorminor"
} >> "$out"
echo "Publishing $version to the '$channel' channel" >&2
