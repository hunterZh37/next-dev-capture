#!/bin/zsh
# Install next-dev-capture into a Next.js (App Router) or Vite project, local only.
#   ~/next-dev-capture/install.sh <project-dir>
# Adds untracked files, git-excludes them (.git/info/exclude, never committed). Nothing tracked by git is edited.
set -e
HERE=${0:A:h}
P=${1:-.}; P=${P:A}
[[ -f $P/package.json ]] || { print "no package.json in $P"; exit 1; }

# git-exclude each path given (relative to the project), once
exclude() {
  [[ -d $P/.git ]] || return 0
  local EX=$P/.git/info/exclude line
  mkdir -p ${EX:h}; touch $EX
  for line in "$@"; do grep -qxF "$line" $EX || print -r -- "$line" >> $EX; done
}

if grep -q '"next"' $P/package.json; then
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
  exclude "${CLIENT#$P/}" "${ROUTE#$P/}" ".dev-captures/"
  grep -q '^NEXT_PUBLIC_DEV_CAPTURE=' $P/.env.local 2>/dev/null || printf '\n# next-dev-capture (local only)\nNEXT_PUBLIC_DEV_CAPTURE=1\n' >> $P/.env.local
  print "installed in $P ($REL, Next.js): restart the dev server, then Cmd+Shift+L (capture) / Cmd+Shift+K (record)."
elif grep -q '"vite"' $P/package.json; then
  WRAP=$P/vite.config.dev-capture.mjs
  if [[ -f $WRAP ]] && ! grep -q "next-dev-capture" $WRAP; then print "$WRAP exists and is not ours: not touching it"; exit 1; fi
  BASE=""
  for f in vite.config.ts vite.config.mts vite.config.js vite.config.mjs vite.config.cts vite.config.cjs; do
    [[ -f $P/$f ]] && { BASE=$f; break; }
  done
  cp $HERE/template/instrumentation-client.ts $P/dev-capture.client.ts
  cp $HERE/template/vite-plugin.mjs $P/dev-capture.vite.mjs
  if [[ -n $BASE ]]; then sed "s#__BASE__#$BASE#" $HERE/template/vite.config.dev-capture.mjs > $WRAP
  else cp $HERE/template/vite.config.dev-capture.nobase.mjs $WRAP; fi
  exclude dev-capture.client.ts dev-capture.vite.mjs vite.config.dev-capture.mjs ".dev-captures/"
  print "installed in $P (Vite${BASE:+, wraps $BASE})."
  print "start the dev server with:  npx vite --config vite.config.dev-capture.mjs  (add your usual flags)"
  print "then Cmd+Shift+L (capture) / Cmd+Shift+K (record). Plain \`npm run dev\` stays exactly as before."
else
  print "neither Next.js nor Vite in $P/package.json"; exit 1
fi
print "captures go to $P/.dev-captures/"
