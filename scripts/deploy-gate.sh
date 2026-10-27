#!/usr/bin/env bash
# Production deploy gate: the NFL blackout window, Thu 5:00 PM ET → Tue 2:00 AM ET.
# Railway's production services wait for GitHub checks ("wait for CI"), so a
# failing gate holds the deploy. Staging is not gated.
#
#   scripts/deploy-gate.sh [epoch-seconds] [commit-message]
#
# Emergency override (on-call authorization required): put [blackout-override]
# in the commit message. The override is printed in the job log.
set -euo pipefail
at="${1:-$(date +%s)}"
msg="${2:-}"
dow=$(TZ=America/New_York date -d "@$at" +%u)   # 1 = Mon … 7 = Sun
hm=$(TZ=America/New_York date -d "@$at" +%H%M)
hm=$((10#$hm))
stamp=$(TZ=America/New_York date -d "@$at" '+%a %Y-%m-%d %H:%M %Z')

blackout=0
case "$dow" in
  4) (( hm >= 1700 )) && blackout=1 ;;   # Thu from 5:00 PM
  5|6|7|1) blackout=1 ;;                 # Fri, Sat, Sun, Mon
  2) (( hm < 200 )) && blackout=1 ;;     # Tue until 2:00 AM
esac

if (( blackout == 0 )); then
  echo "Deploy window open ($stamp)."
  exit 0
fi
if [[ "$msg" == *"[blackout-override]"* ]]; then
  echo "::warning::BLACKOUT OVERRIDE at $stamp — commit message carries [blackout-override]."
  exit 0
fi
echo "::error::Production blackout (Thu 5:00 PM ET → Tue 2:00 AM ET). It is $stamp. Railway will not deploy this commit to production."
echo "After the window, re-run this job or press Redeploy in Railway."
exit 1
