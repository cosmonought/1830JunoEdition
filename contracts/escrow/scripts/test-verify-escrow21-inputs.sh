#!/usr/bin/env bash
# Regression proof for verify-escrow21-inputs.sh: an unsupported or broken `git check-attr` can NEVER produce a false
# PASS, the portable reading is as precise as `--source`, and the real inputs still read IDENTICAL.
#
#   bash contracts/escrow/scripts/test-verify-escrow21-inputs.sh        (any clone that has e2a67c3 and HEAD)
#
# Nothing in the repository is changed: the synthetic candidate commits are written to a SCRATCH object directory
# (GIT_OBJECT_DIRECTORY; the repository's objects are read through GIT_ALTERNATE_OBJECT_DIRECTORIES), no ref is moved,
# no index or working-tree file is touched, and the scratch directory is removed at the end.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/verify-escrow21-inputs.sh"
repo=$(git -C "$here" rev-parse --show-toplevel) || exit 2
cd "$repo" || exit 2
git cat-file -e e2a67c3ec567328b9cd5d533b80cbdb4f38997e2^{commit} 2>/dev/null || { echo "SKIP: e2a67c3 is not in this clone (git fetch origin)"; exit 2; }
realgit=$(command -v git)
objects=$(cd "$(git rev-parse --git-path objects)" && pwd)
head=$(git rev-parse HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/objects" "$tmp/oldgit" "$tmp/brokengit"
export GIT_OBJECT_DIRECTORY="$tmp/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"

# Git 2.34-like: `check-attr --source` is an unknown option (stderr, exit 129), everything else is the real Git.
cat > "$tmp/oldgit/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do if [ "\$a" = "--source" ]; then echo "error: unknown option \\\`source'" >&2; exit 129; fi; done
exec "$realgit" "\$@"
EOF
# Broken: every check-attr "succeeds" and prints nothing.
cat > "$tmp/brokengit/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "check-attr" ]; then exit 0; fi
exec "$realgit" "\$@"
EOF
chmod +x "$tmp/oldgit/git" "$tmp/brokengit/git"

# A candidate commit: HEAD with ONE path replaced by the given content (in a scratch index; nothing else touched).
candidate() { # path content
  local idx="$tmp/index.$RANDOM" blob tree
  GIT_INDEX_FILE="$idx" git read-tree "$head" || return 1
  blob=$(printf '%s' "$2" | git hash-object -w --stdin) || return 1
  GIT_INDEX_FILE="$idx" git update-index --cacheinfo "100644,$blob,$1" || return 1
  tree=$(GIT_INDEX_FILE="$idx" git write-tree) || return 1
  git commit-tree "$tree" -p "$head" -m "test candidate: $1" </dev/null
}
attrs=$(git show "$head:.gitattributes")
c_attr=$(candidate .gitattributes "$attrs
Cargo.lock -text
contracts/escrow/src/** eol=crlf
") || exit 2
c_unrelated=$(candidate .gitattributes "$attrs
frontend/** linguist-documentation
") || exit 2
c_src=$(candidate contracts/escrow/src/lib.rs "$(git show "$head:contracts/escrow/src/lib.rs")
// a source change
") || exit 2

pass=0 failed=0
check() { # label, PATH prefix ("" = the real Git), candidate, expected exit, expected output pattern
  local out rc
  if [ -n "$2" ]; then out=$(PATH="$2:$PATH" bash "$script" "$3" 2>&1); rc=$?; else out=$(bash "$script" "$3" 2>&1); rc=$?; fi
  if [ "$rc" = "$4" ] && printf '%s\n' "$out" | grep -q -- "$5"; then
    pass=$((pass + 1)); echo "ok    $1 (exit $rc)"
  else
    failed=$((failed + 1)); echo "FAIL  $1: exit $rc (expected $4), pattern '$5'"; printf '%s\n' "$out" | sed 's/^/        /'
  fi
}
check "real Git: HEAD's inputs are IDENTICAL"                         ""               "$head"        0 "SAME  gitattributes (text/eol) on the build inputs"
check "old Git (no --source): HEAD still IDENTICAL, by the portable reading" "$tmp/oldgit"  "$head"        0 "portable reading (this Git has no check-attr --source"
check "real Git: an attribute change ON the inputs is CHANGED"          ""               "$c_attr"      1 "DIFF  gitattributes (text/eol)"
check "old Git: the same attribute change is CHANGED (never a false PASS)" "$tmp/oldgit"  "$c_attr"      1 "DIFF  gitattributes (text/eol)"
check "real Git: an attribute change elsewhere is still IDENTICAL"      ""               "$c_unrelated" 0 "ARTIFACT INPUTS: IDENTICAL"
check "old Git: an attribute change elsewhere is still IDENTICAL (as precise as --source)" "$tmp/oldgit" "$c_unrelated" 0 "ARTIFACT INPUTS: IDENTICAL"
check "broken Git (check-attr silent): never a PASS"                   "$tmp/brokengit" "$head"        1 "could not be read completely"
check "a contract source change is CHANGED"                            "$tmp/oldgit"    "$c_src"       1 "DIFF  contracts/escrow/src"
check "the verdict line refuses adoption on a change"                  "$tmp/oldgit"    "$c_attr"      1 "do NOT adopt"
echo "test-verify-escrow21-inputs: $pass passed, $failed failed"
[ "$failed" = 0 ]
