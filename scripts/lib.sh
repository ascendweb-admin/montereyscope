#!/usr/bin/env bash
# Shared helpers for scope launcher scripts. Not meant to be run directly.
# Sourced by scripts/launch and scripts/server.
#
# Runtime artifacts (all project-local, all git-ignored):
#   logs/launcher.log        non-sensitive launcher/server log
#   data/run/localtube.pid   pid of the server started by scripts/launch

# shellcheck shell=bash

set -euo pipefail

LOCALTUBE_HOST="127.0.0.1"
LOCALTUBE_PORT="3000"
LOCALTUBE_URL="http://${LOCALTUBE_HOST}:${LOCALTUBE_PORT}"
LOCALTUBE_HEALTH_URL="${LOCALTUBE_URL}/api/health"

# Resolve the project root from this file's own location so the scripts work
# from any working directory and survive symlinked invocations.
localtube_script_dir() {
  local source="${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"
  while [ -L "$source" ]; do
    local target
    target="$(readlink "$source")"
    case $target in
      /*) source="$target" ;;
      *) source="$(dirname "$source")/$target" ;;
    esac
  done
  cd "$(dirname "$source")" && pwd -P
}

LOCALTUBE_ROOT="$(cd "$(localtube_script_dir)/.." && pwd -P)"
readonly LOCALTUBE_ROOT LOCALTUBE_HOST LOCALTUBE_PORT LOCALTUBE_URL LOCALTUBE_HEALTH_URL

LOCALTUBE_LOG_DIR="${LOCALTUBE_ROOT}/logs"
LOCALTUBE_LOG_FILE="${LOCALTUBE_LOG_DIR}/launcher.log"
LOCALTUBE_RUN_DIR="${LOCALTUBE_ROOT}/data/run"
LOCALTUBE_PID_FILE="${LOCALTUBE_RUN_DIR}/localtube.pid"

localtube_log() {
  mkdir -p "$LOCALTUBE_LOG_DIR"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOCALTUBE_LOG_FILE"
}

# Keep the launcher log bounded: rotate once it passes ~1 MiB.
localtube_rotate_log() {
  if [ -f "$LOCALTUBE_LOG_FILE" ]; then
    if [ "$(wc -c <"$LOCALTUBE_LOG_FILE")" -gt 1048576 ]; then
      mv -f "$LOCALTUBE_LOG_FILE" "${LOCALTUBE_LOG_FILE}.old"
      localtube_log "rotated launcher.log to launcher.log.old"
    fi
  fi
}

# True when something at the health endpoint identifies itself as scope.
# Accepts 200 (healthy) and 503 (degraded, e.g. yt-dlp missing): both prove a
# scope server is serving and that database access (and therefore
# idempotent migrations) has happened. Any other outcome is not ready.
localtube_probe_ready() {
  local body
  body="$(curl -fsS --max-time 2 "$LOCALTUBE_HEALTH_URL" 2>/dev/null || true)"
  [ -n "$body" ] && printf '%s' "$body" | grep -q '"scope"'
}

# True only when the health endpoint reports fully healthy (HTTP 200).
localtube_probe_healthy() {
  local code
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 2 \
    "$LOCALTUBE_HEALTH_URL" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

localtube_read_pid() {
  [ -f "$LOCALTUBE_PID_FILE" ] || return 1
  local pid
  pid="$(cat "$LOCALTUBE_PID_FILE" 2>/dev/null || true)"
  case $pid in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$pid"
}

localtube_pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Strict ownership check before any signal is ever sent: the recorded PID must
# belong to a scope Next.js server of this exact project checkout.
# Next.js rewrites its process title to "next-server (vX.Y.Z)", so both the
# original "next start" argv and the rewritten form are accepted. The
# executable path, working directory, or command line must additionally
# resolve inside this project directory. Guards against PID reuse and never
# matches unrelated processes by name or port.
localtube_pid_is_ours() {
  local pid="$1"
  [ -r "/proc/${pid}/cmdline" ] || return 1

  local cmdline cwd exe
  cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
  cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)"
  exe="$(readlink "/proc/${pid}/exe" 2>/dev/null || true)"

  case $cmdline in
    *next*start* | *next-server*) ;;
    *) return 1 ;;
  esac

  case "$exe $cwd $cmdline" in
    *"$LOCALTUBE_ROOT"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Find this project's server PID when the pidfile is missing or stale.
# Looks up who owns the 127.0.0.1:3000 listener socket (exact, not a name or
# port-based kill), then requires full /proc ownership proof before adopting.
# Prints the verified PID and returns 0 only for exactly one verified owner.
localtube_find_owned_server_pid() {
  command -v ss >/dev/null 2>&1 || return 1
  local pids adopted=0 pid
  pids="$(ss -ltnpH "sport = :${LOCALTUBE_PORT}" 2>/dev/null |
    grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  [ -n "$pids" ] || return 1
  for pid in $pids; do
    if localtube_pid_is_ours "$pid"; then
      adopted=$((adopted + 1))
      verified_pid="$pid"
    fi
  done
  [ "$adopted" -eq 1 ] || return 1
  printf '%s' "$verified_pid"
}
