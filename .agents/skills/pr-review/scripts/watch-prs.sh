#!/usr/bin/env bash
# Usage: watch-prs.sh <since ISO-8601 UTC, e.g. 2026-10-10T10:00:00Z> <deadline epoch seconds> <pr>:<head sha>...
# Polls every 60 s for human activity on the PRs after <since>: issue comments, review comments,
# submitted reviews, and new commits (head SHA differs from the one given). Ignores bots and
# anything carrying the tangow-auto-review marker.
# Exit 0: new activity, printed as one JSON object per line. Exit 2: no news in this
# 9-minute slice, call again with the same arguments. Exit 3: deadline reached.
set -euo pipefail
repo=${PR_REVIEW_REPO:-tangow-ai/tangow-bot}
since=$1 deadline=$2; shift 2
slice_end=$(( $(date +%s) + 540 ))
filter='.[]
  | select(.state != "PENDING")
  | select(.state != "COMMENTED" or ((.body // "") != ""))
  | select(((.created_at // .submitted_at) // "") > $since)
  | select(.user.type != "Bot")
  | select((.body // "") | contains("<!-- tangow-auto-review -->") | not)
  | {kind: "comment", pr: ($pr | tonumber), author: .user.login, at: (.created_at // .submitted_at),
     state, path, line, in_reply_to_id, url: .html_url, body}'
while :; do
  (( $(date +%s) >= deadline )) && { echo "deadline reached"; exit 3; }
  news=""
  for arg in "$@"; do
    pr=${arg%%:*} sha=${arg#*:}
    news+=$( {
      gh api --paginate "repos/$repo/issues/$pr/comments?since=$since"
      gh api --paginate "repos/$repo/pulls/$pr/comments?since=$since"
      gh api --paginate "repos/$repo/pulls/$pr/reviews"
    } | jq -c --arg since "$since" --arg pr "$pr" "$filter" )$'\n'
    head=$(gh api "repos/$repo/pulls/$pr" --jq .head.sha)
    [[ "$head" != "$sha" ]] && news+=$(jq -nc --arg pr "$pr" --arg old "$sha" --arg new "$head" \
      '{kind: "push", pr: ($pr | tonumber), old_head: $old, new_head: $new}')$'\n'
  done
  news=$(printf '%s' "$news" | sed '/^$/d')
  [[ -n "$news" ]] && { printf '%s\n' "$news"; exit 0; }
  (( $(date +%s) + 60 >= slice_end )) && { echo "no news yet"; exit 2; }
  sleep 60
done
