#!/bin/zsh
# Remove next-dev-capture from a project (keeps .dev-captures/).
#   ~/Desktop/next-dev-capture/uninstall.sh <project-dir>
P=${1:-.}; P=${P:A}
for R in $P/src $P; do
  for f in $R/instrumentation-client.ts $R/dev-capture.client.ts; do
    [[ -f $f ]] && grep -q "next-dev-capture" $f && rm $f && print "removed $f"
  done
  [[ -f $R/app/api/dev-capture/route.ts ]] && grep -q "next-dev-capture" $R/app/api/dev-capture/route.ts && rm -r $R/app/api/dev-capture && print "removed $R/app/api/dev-capture"
done
[[ -f $P/.env.local ]] && sed -i '' '/^# next-dev-capture (local only)$/d;/^NEXT_PUBLIC_DEV_CAPTURE=1$/d' $P/.env.local
print "done (exclude lines in .git/info/exclude left in place, harmless)"
