#!/usr/bin/env bash
# T843: runs the wake loop's commands on a throwaway database and prints each with its output,
# for docs/commands.md. Run: scripts/wake-loop-demo.sh [checkout] (about five minutes: ordinary mail settles for two). Touches no live database.
set -u
REPO=${1:-$(cd "$(dirname "$0")/.." && pwd)}
DIR=$(mktemp -d) && [ -d "$DIR" ] || { echo "no temporary directory" >&2; exit 1; }
trap 'rm -rf "$DIR"' EXIT
FAILED=0
export SASSATO_ROLE= SASSATO_WORKSPACE= SASSATO_DB=
s() { node "$REPO/bin/sassato.js" --db "$DIR/state.db" --workspace team "$@"; }
# show EXPECTED_EXIT ARGS...: prints the command (quoted as typed) and its output; a different exit fails the run.
show() {
  local want=$1 line='$ sas' a; shift
  for a in "$@"; do [[ -z $a || $a =~ [[:space:]\'] ]] && a="\"$a\""; line+=" $a"; done
  echo "$line"; s "$@" 2>&1; local got=$?; echo "[exit $got]"; echo
  [ "$got" = "$want" ] || { echo "UNEXPECTED: exit $got, wanted $want: $line" >&2; FAILED=1; }
}
quiet() { s "$@" >/dev/null 2>&1 || { echo "setup failed: sas $*" >&2; exit 1; }; }
quiet init --config "$(dirname "$0")/wake-loop-team.json"
quiet add "Fix the parser" --for builder --as lead
quiet add "Write the release notes" --for builder --as lead
quiet add "Update the changelog" --for lead --as lead
show 0 context --as builder --brief
show 4 wake --idle-minutes 1 --as builder
show 0 progress save --cursor 4 --expect 0 --as builder
show 0 take T1 --as builder
show 0 send builder "T1: the parser change blocks my merge, please look first" --urgent --as lead
show 0 wake --idle-minutes 1 --as builder
show 3 take T3 --as builder
show 0 note T1 "Fixed the tokenizer; tests in test/parse.test.mjs" --as builder
show 0 done T1 --as builder
show 2 done T2 --note "x" --as builder
show 0 take T2 --as builder
show 0 block T2 "Waits on lead's choice of wording" --kind other --waits-on lead --as builder
show 0 blockers --task T2 --as builder
show 0 send lead "T2: which wording, short or long?" --needs-reply --as builder
show 0 tasks --status open,doing,blocked --as builder
show 0 wip show --as builder
show 0 checkpoint save --current "T2 parked on lead" --next "Resume T2 when lead answers" --notes "T1 done" --expect 0 --as builder
show 2 checkpoint save --current "T2 parked on lead" --next "Resume T2 when lead answers" --notes "" --expect 1 --as builder
quiet send builder "T2: the short wording" --as lead
show 0 wake --since 8 --idle-minutes 1 --ack M1 --as builder
exit $FAILED
