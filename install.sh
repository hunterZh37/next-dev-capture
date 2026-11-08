#!/bin/zsh
# Install next-dev-capture into a Next.js (App Router) project, local only.
#   ~/Desktop/next-dev-capture/install.sh <project-dir>
# Adds two untracked files, git-excludes them (.git/info/exclude, never committed), and turns
# the tool on in .env.local. Nothing tracked by git is edited.
set -e
HERE=${0:A:h}
P=${1:-.}; P=${P:A}
[[ -f $P/package.json ]] || { print "no package.json in $P"; exit 1; }
grep -q '"next"' $P/package.json || { print "not a Next.js project: $P"; exit 1; }
if [[ -d $P/src/app ]]; then ROOT=$P/src; REL=src; elif [[ -d $P/app ]]; then ROOT=$P; REL=.; else print "no app/ or src/app/ (App Router) in $P"; exit 1; fi
CLIENT=$ROOT/instrumentation-client.ts
ROUTE=$ROOT/app/api/dev-capture/route.ts
for f in $CLIENT $ROOT/instrumentation-client.js; do
  if [[ -f $f ]] && ! grep -q "next-dev-capture" $f; then
    print "$f already exists and is not ours. Add this line to it instead:"
    print "  import \"./dev-capture.client\";"
    cp $HERE/template/instrumentation-client.ts $ROOT/dev-capture.client.ts
    CLIENT=$ROOT/dev-capture.client.ts
    break
  fi
done
[[ $CLIENT == $ROOT/instrumentation-client.ts ]] && cp $HERE/template/instrumentation-client.ts $CLIENT
mkdir -p ${ROUTE:h} && cp $HERE/template/route.ts $ROUTE
if [[ -d $P/.git ]]; then
  EX=$P/.git/info/exclude
  touch $EX
  for line in "${CLIENT#$P/}" "${ROUTE#$P/}" ".dev-captures/"; do
    grep -qxF "$line" $EX || print -r -- "$line" >> $EX
  done
fi
grep -q '^NEXT_PUBLIC_DEV_CAPTURE=' $P/.env.local 2>/dev/null || printf '\n# next-dev-capture (local only)\nNEXT_PUBLIC_DEV_CAPTURE=1\n' >> $P/.env.local
print "installed in $P ($REL): restart the dev server, then Cmd+Shift+L (capture) / Cmd+Shift+K (record)."
print "captures go to $P/.dev-captures/"
