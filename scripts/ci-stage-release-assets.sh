#!/bin/sh
# Stage CI build outputs without consuming Actions artifact storage.
set -eu

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <draft-release-tag> <file>..." >&2
  exit 2
fi
tag=$1
shift
draft=$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft)
if [ "$draft" != true ]; then
  echo "Refusing to upload assets to non-draft release $tag" >&2
  exit 1
fi
gh release upload "$tag" --repo "$GITHUB_REPOSITORY" --clobber "$@"
