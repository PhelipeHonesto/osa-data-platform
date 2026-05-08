#!/bin/bash
# Bulk orchestration helper for the operator profile-builder.
#
# Claude Code drives 10-way parallel agent batches. This script handles
# the bookkeeping between batches: cohort selection, batch preparation,
# batch commit, state tracking, halt-condition checks, progress logs.
#
# State file: .work/profile-builder/bulk-state.json
# Status log: .work/profile-builder/bulk-status.log (append-only)
# Errors log: .work/profile-builder/bulk-errors.jsonl (append-only)
#
# Subcommands:
#   init [--cost-cap=150] [--cost-warn=100]
#   prepare-batch [N]   (default N=10)
#   commit-batch <cert1> <cert2> ... <certN>
#   status

set -u
set -o pipefail

DRIVER="npx tsx scripts/profile-builder/operator-profile.ts"
WORK_ROOT=".work/profile-builder"
STATE_FILE="$WORK_ROOT/bulk-state.json"
STATUS_LOG="$WORK_ROOT/bulk-status.log"
ERRORS_LOG="$WORK_ROOT/bulk-errors.jsonl"

DB_URL_LINE=$(grep '^SUPABASE_DATABASE_URL=' .env)
DB_URL="${DB_URL_LINE#SUPABASE_DATABASE_URL=}"

die() { echo "ERROR: $*" >&2; exit 1; }
now_iso() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
require_state() { [ -f "$STATE_FILE" ] || die "no state file at $STATE_FILE — run 'init' first"; }
read_state() { jq -r "$1" "$STATE_FILE"; }
write_state() {
  local tmp; tmp=$(mktemp)
  echo "$1" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

# ─────────────────────────────────────────────────────────────────────────────
# init
# ─────────────────────────────────────────────────────────────────────────────
cmd_init() {
  local cost_cap=150 cost_warn=100
  for a in "$@"; do
    case "$a" in
      --cost-cap=*)  cost_cap="${a#--cost-cap=}" ;;
      --cost-warn=*) cost_warn="${a#--cost-warn=}" ;;
      *) die "unknown init flag: $a" ;;
    esac
  done
  mkdir -p "$WORK_ROOT"
  touch "$STATUS_LOG" "$ERRORS_LOG"

  local n_already
  n_already=$(psql "$DB_URL" -A -t -c "SELECT count(*) FROM public.operator_profiles;" | tr -d ' ')
  local n_total
  n_total=$(psql "$DB_URL" -A -t -c "
    SELECT count(*) FROM canonical.certificates
     WHERE status = 'active_operating' AND faa_cert_number IS NOT NULL;" | tr -d ' ')

  jq -n \
    --arg started_at "$(now_iso)" \
    --argjson cost_cap "$cost_cap" \
    --argjson cost_warn "$cost_warn" \
    --argjson n_already "$n_already" \
    --argjson n_total "$n_total" \
    '{
      started_at: $started_at,
      cost_cap_usd: $cost_cap,
      cost_warn_usd: $cost_warn,
      n_total_cohort: $n_total,
      n_pre_done: $n_already,
      n_completed_this_run: 0,
      n_failed_this_run: 0,
      consecutive_validation_failures: 0,
      consecutive_parse_failures: 0,
      total_spent_usd: 0,
      cost_warn_announced: false,
      last_cert: null,
      halted: false,
      halted_reason: null
    }' > "$STATE_FILE"

  echo "[$(now_iso)] init n_total=$n_total n_pre_done=$n_already cost_cap=\$$cost_cap cost_warn=\$$cost_warn" >> "$STATUS_LOG"
  jq '.' "$STATE_FILE"
}

# ─────────────────────────────────────────────────────────────────────────────
# prepare-batch [N] — select next N unprofiled certs, prepare each, return JSON
# ─────────────────────────────────────────────────────────────────────────────
cmd_prepare_batch() {
  require_state
  local n="${1:-10}"

  # Halt checks BEFORE doing work
  if [ "$(read_state '.halted')" = "true" ]; then
    jq -n --arg r "$(read_state '.halted_reason')" '{halted: true, reason: $r, batch: []}'
    return 0
  fi

  # Select next N unprofiled certs (NOT in operator_profiles).
  # Larger fleets first so most-impactful operators get profiled early.
  local certs
  certs=$(psql "$DB_URL" -A -t -c "
    WITH counts AS (
      SELECT c.faa_cert_number AS cert,
             COALESCE((SELECT count(*) FROM canonical.aircraft_on_certificate aoc WHERE aoc.cert_id = c.cert_id), 0) AS fleet
        FROM canonical.certificates c
       WHERE c.status = 'active_operating' AND c.faa_cert_number IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.operator_profiles p WHERE p.faa_cert_number = c.faa_cert_number)
    )
    SELECT cert FROM counts ORDER BY fleet DESC, cert LIMIT $n;" | grep -v '^$')

  if [ -z "$certs" ]; then
    jq -n '{batch: [], complete: true}'
    return 0
  fi

  # Prepare each cert (writes prompt.txt + claim.json under .work/profile-builder/<cert>/)
  local prepared=()
  local prep_failed=()
  while IFS= read -r cert; do
    [ -z "$cert" ] && continue
    cert=$(echo "$cert" | tr -d ' ')
    local out
    out=$($DRIVER prepare --cert="$cert" 2>&1) || true
    local st
    st=$(echo "$out" | jq -r '.status // "error"' 2>/dev/null)
    if [ "$st" = "prepared" ]; then
      prepared+=("$cert")
    else
      prep_failed+=("$cert")
      jq -n --arg ts "$(now_iso)" --arg cert "$cert" --arg out "$out" \
        '{ts: $ts, cert: $cert, phase: "prepare", error: $out}' >> "$ERRORS_LOG"
      echo "[$(now_iso)] PREP_FAIL cert=$cert" >> "$STATUS_LOG"
    fi
  done <<< "$certs"

  # Echo the JSON batch list for Claude Code to spawn agents on
  jq -n \
    --argjson prepared "$(printf '%s\n' "${prepared[@]:-}" | grep -v '^$' | jq -R . | jq -s .)" \
    --argjson failed   "$(printf '%s\n' "${prep_failed[@]:-}" | grep -v '^$' | jq -R . | jq -s .)" \
    --argjson n_done "$(read_state '.n_pre_done')" \
    --argjson n_run  "$(read_state '.n_completed_this_run')" \
    --argjson n_total "$(read_state '.n_total_cohort')" \
    --argjson spent "$(read_state '.total_spent_usd')" \
    '{
      batch: $prepared,
      prepare_failed: $failed,
      progress: {
        n_done_total: ($n_done + $n_run),
        n_remaining: ($n_total - ($n_done + $n_run)),
        total_spent_usd: $spent
      }
    }'
}

# ─────────────────────────────────────────────────────────────────────────────
# commit-batch <cert1> <cert2> ... — commit each, update state, check halt
# ─────────────────────────────────────────────────────────────────────────────
cmd_commit_batch() {
  require_state
  [ $# -gt 0 ] || die "commit-batch requires ≥1 cert argument"

  local committed=()
  local validation_failures=()
  local parse_failures=()
  local other_failures=()

  for cert in "$@"; do
    local out rc
    out=$($DRIVER commit --cert="$cert" 2>&1)
    rc=$?
    local st
    st=$(echo "$out" | jq -r '.status // "error"' 2>/dev/null)

    if [ "$rc" -eq 0 ] && [ "$st" = "committed" ]; then
      committed+=("$cert")
      # Cost from the response.json metadata (if present)
      local case_cost
      case_cost=$(jq -r '.metadata.cost_usd // 0.04' ".work/profile-builder/$cert/response.json" 2>/dev/null || echo "0.04")

      # Update state: increment completed, reset both consecutive counters, add cost
      write_state "$(jq \
        --argjson cost "$case_cost" \
        --arg cert "$cert" \
        '.n_completed_this_run += 1
         | .consecutive_validation_failures = 0
         | .consecutive_parse_failures = 0
         | .total_spent_usd = (.total_spent_usd + $cost)
         | .last_cert = $cert' \
        "$STATE_FILE")"

      local total_done total_spent
      total_done=$(( $(read_state '.n_pre_done') + $(read_state '.n_completed_this_run') ))
      total_spent=$(read_state '.total_spent_usd')
      local n_total; n_total=$(read_state '.n_total_cohort')
      echo "[$(now_iso)] DONE $total_done/$n_total cert=$cert cost_running=\$$total_spent" >> "$STATUS_LOG"
    else
      # Classify failure
      local reason
      reason=$(echo "$out" | jq -r '.reason // "unknown"' 2>/dev/null)
      jq -n --arg ts "$(now_iso)" --arg cert "$cert" --arg reason "$reason" --arg out "$out" \
        '{ts: $ts, cert: $cert, phase: "commit", reason: $reason, output: $out}' >> "$ERRORS_LOG"

      if [ "$reason" = "quote_not_in_page" ] || [ "$reason" = "quote_url_not_in_pages" ]; then
        validation_failures+=("$cert")
        write_state "$(jq '.n_failed_this_run += 1 | .consecutive_validation_failures += 1 | .consecutive_parse_failures = 0' "$STATE_FILE")"
      elif [ "$reason" = "json_parse" ] || [ "$reason" = "response_missing" ]; then
        parse_failures+=("$cert")
        write_state "$(jq '.n_failed_this_run += 1 | .consecutive_parse_failures += 1' "$STATE_FILE")"
      else
        other_failures+=("$cert")
        write_state "$(jq '.n_failed_this_run += 1' "$STATE_FILE")"
      fi
      echo "[$(now_iso)] FAIL cert=$cert reason=$reason" >> "$STATUS_LOG"
    fi
  done

  # Halt checks AFTER processing
  local halted=false halted_reason=null
  local cost_cap; cost_cap=$(read_state '.cost_cap_usd')
  local total_spent; total_spent=$(read_state '.total_spent_usd')
  local cv_fails; cv_fails=$(read_state '.consecutive_validation_failures')
  local cp_fails; cp_fails=$(read_state '.consecutive_parse_failures')

  if awk "BEGIN{exit !($total_spent >= $cost_cap)}"; then
    halted=true; halted_reason="cost_cap_breached:\$$total_spent>=\$$cost_cap"
  elif [ "$cv_fails" -ge 5 ]; then
    halted=true; halted_reason="5_consecutive_validation_failures"
  elif [ "$cp_fails" -ge 10 ]; then
    halted=true; halted_reason="10_consecutive_parse_failures"
  fi

  if [ "$halted" = "true" ]; then
    write_state "$(jq --arg r "$halted_reason" '.halted=true | .halted_reason=$r' "$STATE_FILE")"
    echo "[$(now_iso)] HALT $halted_reason" >> "$STATUS_LOG"
  fi

  # Cost-warn milestone: announce once when crossing the threshold
  local cost_warn; cost_warn=$(read_state '.cost_warn_usd')
  local already_announced; already_announced=$(read_state '.cost_warn_announced')
  local milestone=null
  if [ "$already_announced" = "false" ] && awk "BEGIN{exit !($total_spent >= $cost_warn)}"; then
    write_state "$(jq '.cost_warn_announced = true' "$STATE_FILE")"
    milestone="cost_warn_threshold_crossed"
    echo "[$(now_iso)] MILESTONE cost passed \$$cost_warn (now \$$total_spent)" >> "$STATUS_LOG"
  fi

  # Every-100 progress milestone
  local n_done_total
  n_done_total=$(( $(read_state '.n_pre_done') + $(read_state '.n_completed_this_run') ))
  if [ "$milestone" = "null" ]; then
    if (( n_done_total % 100 == 0 )) && [ ${#committed[@]} -gt 0 ]; then
      milestone="every_100_done"
    fi
  fi

  jq -n \
    --argjson committed         "$(printf '%s\n' "${committed[@]:-}" | grep -v '^$' | jq -R . | jq -s .)" \
    --argjson validation_fails  "$(printf '%s\n' "${validation_failures[@]:-}" | grep -v '^$' | jq -R . | jq -s .)" \
    --argjson parse_fails       "$(printf '%s\n' "${parse_failures[@]:-}" | grep -v '^$' | jq -R . | jq -s .)" \
    --argjson other_fails       "$(printf '%s\n' "${other_failures[@]:-}" | grep -v '^$' | jq -R . | jq -s .)" \
    --argjson halted "$([ "$halted" = "true" ] && echo true || echo false)" \
    --arg     halted_reason "$halted_reason" \
    --argjson n_done "$n_done_total" \
    --argjson total_spent "$total_spent" \
    --argjson cv_fails "$cv_fails" \
    --argjson cp_fails "$cp_fails" \
    --arg milestone "$milestone" \
    '{
      committed: $committed,
      validation_failures: $validation_fails,
      parse_failures: $parse_fails,
      other_failures: $other_fails,
      halted: $halted,
      halted_reason: ($halted_reason | if . == "null" then null else . end),
      progress: {n_done_total: $n_done, total_spent_usd: $total_spent,
                 consecutive_validation_failures: $cv_fails,
                 consecutive_parse_failures: $cp_fails},
      milestone: ($milestone | if . == "null" then null else . end)
    }'
}

# ─────────────────────────────────────────────────────────────────────────────
# status
# ─────────────────────────────────────────────────────────────────────────────
cmd_status() {
  require_state
  local n_done_db
  n_done_db=$(psql "$DB_URL" -A -t -c "SELECT count(*) FROM public.operator_profiles;" | tr -d ' ')
  jq --argjson n_done_db "$n_done_db" \
     '. + {n_profiled_in_db: $n_done_db}' "$STATE_FILE"
}

# ─────────────────────────────────────────────────────────────────────────────
# dispatch
# ─────────────────────────────────────────────────────────────────────────────
sub="${1:-help}"
shift || true
case "$sub" in
  init)           cmd_init "$@"          ;;
  prepare-batch)  cmd_prepare_batch "$@" ;;
  commit-batch)   cmd_commit_batch "$@"  ;;
  status)         cmd_status             ;;
  help|*)
    cat <<USAGE
Bulk orchestrator for operator profile-builder.

Usage:
  $0 init [--cost-cap=150] [--cost-warn=100]
  $0 prepare-batch [N]                (default N=10)
  $0 commit-batch <cert1> <cert2> ... <certN>
  $0 status
USAGE
    ;;
esac
