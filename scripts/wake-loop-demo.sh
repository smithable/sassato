#!/usr/bin/env bash
# T843: runs the wake loop's commands on a throwaway database and prints each with its output,
# for docs/commands.md. Run: scripts/wake-loop-demo.sh [checkout] (about five minutes: ordinary mail settles for two). Touches no live database.
set -u
REPO=${1:-$(cd "$(dirname "$0")/.." && pwd)}; DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
export SASSATO_ROLE= SASSATO_WORKSPACE= SASSATO_DB=
s() { node "$REPO/bin/sassato.js" --db "$DIR/state.db" --workspace team "$@"; }
show() { echo "\$ sas $*"; s "$@" 2>&1; echo "[exit $?]"; echo; }
quiet() { s "$@" >/dev/null 2>&1; }
quiet init --config "$(dirname "$0")/wake-loop-team.json"
quiet add "Fix the parser" --for builder --as lead
quiet add "Write the release notes" --for builder --as lead
quiet add "Update the changelog" --for lead --as lead
show context --as builder --brief
show progress save --cursor 4 --expect 0 --as builder
show take T1 --as builder
show send builder "T1: the parser change blocks my merge, please look first" --urgent --as lead
show wake --idle-minutes 1 --as builder
show take T3 --as builder
show note T1 "Fixed the tokenizer; tests in test/parse.test.mjs" --as builder
show done T1 --as builder
show done T2 --note "x" --as builder
show take T2 --as builder
show block T2 "Waits on lead's choice of wording" --kind other --waits-on lead --as builder
show blockers --task T2 --as builder
show send lead "T2: which wording, short or long?" --needs-reply --as builder
show tasks --status open,doing,blocked --as builder
show wip show --as builder
show checkpoint save --current "T2 parked on lead" --next "Resume T2 when lead answers" --notes "T1 done" --expect 0 --as builder
show checkpoint save --current "T2 parked on lead" --next "Resume T2 when lead answers" --notes "" --expect 1 --as builder
quiet send builder "T2: the short wording" --as lead
show wake --since 8 --idle-minutes 1 --ack M1 --as builder
