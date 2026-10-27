#!/usr/bin/env bash
# Stop this runner's Supabase stack (CI). All runners on a machine share one rootless Docker daemon, and Docker
# refuses a second container prune while another is running ("failed to prune containers"), so retry with backoff.
# Fails if the stack still can't be stopped after the last attempt.
set -uo pipefail

attempts="${SUPABASE_STOP_ATTEMPTS:-6}"
for attempt in $(seq 1 "$attempts"); do
  if supabase stop --no-backup; then
    exit 0
  fi
  if (( attempt < attempts )); then
    delay=$(( attempt * 5 ))
    echo "supabase stop failed (attempt ${attempt}/${attempts}); another job may be pruning on the shared daemon. Retrying in ${delay}s."
    sleep "$delay"
  fi
done
echo "supabase stop failed after ${attempts} attempts." >&2
exit 1
