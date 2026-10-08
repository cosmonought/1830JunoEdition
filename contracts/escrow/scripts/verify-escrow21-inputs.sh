#!/usr/bin/env bash
# Escrow 2.1.0 canonical artifact c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219
# (641,842 B) was certified at e2a67c3ec567328b9cd5d533b80cbdb4f38997e2.
#
# Adoption check: run inside any clone that has both commits.
#   verify-escrow21-inputs.sh <candidate-commit>
# Exit 0 = every escrow artifact-build input on <candidate> is byte-identical to e2a67c3,
#          so the certified checksum may be adopted for <candidate>.
# Exit 1 = something differs (or could not be judged): the artifact must be rebuilt and recertified.
# Exit 2 = usage / a commit is missing.
#
# PHASE 3 ESCROW 2.1 RELEASE READINESS (2026-10-08): the in-repository copy of the certification kit's script (kit SHA-256
# e162bb6c...098e), with ONE correction and nothing weakened. The kit compared the inputs' text/eol attributes with
# `git check-attr --source`, which needs Git >= 2.40: on an older Git both calls failed on stderr, both outputs were empty,
# and their hashes were EQUAL -- a false "SAME". Now:
#   - the attributes are read PORTABLY (any Git): each commit's tree is read into a TEMPORARY index and
#     `git check-attr --cached` answers from exactly that tree's .gitattributes -- what `--source` does, on Git 2.34 too;
#   - where `--source` is supported it is ALSO run, and the two readings must agree;
#   - every call's exit status is checked, and each reading must carry exactly two lines (text, eol) per input file:
#     an empty, failed or partial reading is a DIFF, never a SAME.
#   - `git diff` runs with --no-ext-diff --no-textconv (a local diff driver can never mask a change).
# The REQUIRED object ids, the excluded paths, the absent-file rules and the advisory lines are the kit's, unchanged.
# test-verify-escrow21-inputs.sh (beside this file) proves an unsupported Git cannot produce a false PASS.
set -uo pipefail
CERT=e2a67c3ec567328b9cd5d533b80cbdb4f38997e2
NEW="${1:?usage: $0 <candidate-commit>}"
git cat-file -e "$CERT^{commit}" || { echo "missing $CERT (git fetch origin first)"; exit 2; }
NEW=$(git rev-parse --verify "$NEW^{commit}") || exit 2
echo "info  $(git --version)"
fail=0
expect() { # path expected-object-id
  local got; got=$(git rev-parse -q --verify "$NEW:$1" 2>/dev/null || echo ABSENT)
  if [ "$got" = "$2" ]; then echo "SAME  $1  $got"; else echo "DIFF  $1  certified=$2 candidate=$got"; fail=1; fi
}
absent() { # path that must not exist (a toolchain / cargo-config override the optimizer would honour)
  if git cat-file -e "$NEW:$1" 2>/dev/null; then echo "DIFF  $1 now exists on candidate"; fail=1; else echo "SAME  $1 absent"; fi
}
# The optimizer mounts the repo at /code, resolves the workspace from the root manifest and
# builds the only member, contracts/escrow (`cargo build --release --lib --locked`), then wasm-opt.
# REQUIRED (can change the wasm bytes): root Cargo.toml / Cargo.lock, and everything under
# contracts/ except the escrow crate's README, tests, testdata, schema, scripts and the
# stand-alone gasbench workspace (none is compiled into the lib; src has no include_str!/
# include_bytes! of files outside src). A new contracts/<dir>, a build.rs or a .cargo/ under
# contracts/escrow is therefore caught here.
expect Cargo.toml          f07686d2b506fd61fef2304a3f0cd7a6bc6cec02   # workspace manifest + release profile (overflow-checks)
expect Cargo.lock          e34610fad15554f093e99054bbc00f0b3f6687a2   # resolution (base64ct 1.7.3 / zeroize 1.8.2 pins)
expect contracts/escrow/Cargo.toml e780c7ce540e95383ae22634a005fa516b15378a   # version 2.1.0, rust-version 1.81
expect contracts/escrow/src        131d0a9c6fb9ee6663e8f9b2b87fd5a4250ab42e   # contract source
if git diff --no-ext-diff --no-textconv --quiet "$CERT" "$NEW" -- contracts/ \
     ':(exclude)contracts/escrow/README.md' ':(exclude)contracts/escrow/tests' \
     ':(exclude)contracts/escrow/testdata' ':(exclude)contracts/escrow/schema' \
     ':(exclude)contracts/escrow/scripts' ':(exclude)contracts/escrow/gasbench'; then
  echo "SAME  contracts/ (all build-relevant paths)"
else
  echo "DIFF  contracts/ build-relevant paths:"; git diff --no-ext-diff --no-textconv --stat "$CERT" "$NEW" -- contracts/ \
     ':(exclude)contracts/escrow/README.md' ':(exclude)contracts/escrow/tests' \
     ':(exclude)contracts/escrow/testdata' ':(exclude)contracts/escrow/schema' \
     ':(exclude)contracts/escrow/scripts' ':(exclude)contracts/escrow/gasbench'; fail=1
fi
for p in .cargo rust-toolchain rust-toolchain.toml; do absent "$p"; done
# ADVISORY (reported, never fails the check): not compiled into the wasm.
adv() { local got; got=$(git rev-parse -q --verify "$NEW:$1" 2>/dev/null || echo ABSENT)
  if [ "$got" = "$2" ]; then echo "info  same      $1"; else echo "info  changed   $1 (not a wasm input; review separately)"; fi; }
adv contracts/escrow       d5158b4c0c6ac3f13965a4bdbeb80c83088960ab
adv contracts/escrow/schema   b7721e231fa5c2e03467f64095a9d8c15b9eec46
adv contracts/escrow/testdata 028fc964c65e4eae031539c74d013d269dc9ff0b
adv src                    61d6c4738c7b8d4732c2a6ee1c385dc3ce8c274c

# Checkout line endings of the inputs: the attributes that apply must be unchanged.
files=$(git ls-tree -r --name-only "$CERT" -- Cargo.toml Cargo.lock contracts/escrow/Cargo.toml contracts/escrow/src) || { echo "DIFF  gitattributes: the certified input list could not be read"; fail=1; files=""; }
nfiles=$(printf '%s\n' "$files" | grep -c .)
want_lines=$((2 * nfiles))
# One commit's text/eol attributes for the inputs, from THAT commit's .gitattributes (any Git version): its tree in a
# temporary index, `check-attr --cached`. Prints the reading; fails on any error, or a reading that is not complete.
attrs_portable() {
  local dir rc out
  dir=$(mktemp -d) || return 1
  GIT_INDEX_FILE="$dir/index" git read-tree "$1" 2>/dev/null || { rm -rf "$dir"; return 1; }
  # shellcheck disable=SC2086
  out=$(GIT_INDEX_FILE="$dir/index" git check-attr --cached text eol -- $files 2>/dev/null); rc=$?
  rm -rf "$dir"
  [ "$rc" = 0 ] || return 1
  [ "$(printf '%s\n' "$out" | grep -c .)" = "$want_lines" ] || return 1
  printf '%s\n' "$out"
}
# The same through `--source` (Git >= 2.40), when this Git has it.
attrs_source() {
  local out rc
  # shellcheck disable=SC2086
  out=$(git check-attr --source "$1" text eol -- $files 2>/dev/null); rc=$?
  [ "$rc" = 0 ] || return 1
  [ "$(printf '%s\n' "$out" | grep -c .)" = "$want_lines" ] || return 1
  printf '%s\n' "$out"
}
if [ "$nfiles" -lt 1 ]; then
  echo "DIFF  gitattributes: no certified input files were listed"; fail=1
elif ! a=$(attrs_portable "$CERT") || ! b=$(attrs_portable "$NEW"); then
  echo "DIFF  gitattributes: the inputs' text/eol attributes could not be read completely (never assumed equal)"; fail=1
else
  verdict=SAME
  [ "$a" = "$b" ] || verdict=DIFF
  if git check-attr --source "$CERT" text -- Cargo.toml >/dev/null 2>&1; then
    if ! sa=$(attrs_source "$CERT") || ! sb=$(attrs_source "$NEW"); then
      echo "DIFF  gitattributes: check-attr --source is supported here but answered incompletely"; fail=1; verdict=ERR
    elif [ "$sa" != "$a" ] || [ "$sb" != "$b" ]; then
      echo "DIFF  gitattributes: the --source reading and the portable reading disagree"; fail=1; verdict=ERR
    fi
    how="portable reading, confirmed by check-attr --source"
  else
    how="portable reading (this Git has no check-attr --source; Git >= 2.40 adds a cross-check)"
  fi
  if [ "$verdict" = SAME ]; then echo "SAME  gitattributes (text/eol) on the build inputs ($how; $nfiles files)"
  elif [ "$verdict" = DIFF ]; then echo "DIFF  gitattributes (text/eol) on the build inputs ($how)"; fail=1
  fi
fi
if [ $fail = 0 ]; then
  echo "ESCROW 2.1 ARTIFACT INPUTS: IDENTICAL to e2a67c3 -- certified c3bd0618...8219 applies to $NEW"
else
  echo "ESCROW 2.1 ARTIFACT INPUTS: CHANGED -- rebuild and recertify; do NOT adopt c3bd0618...8219"
fi
exit $fail
