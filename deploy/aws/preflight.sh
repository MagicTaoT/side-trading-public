#!/usr/bin/env bash
set -euo pipefail

side_env_file="${SIDE_ENV_FILE:-/etc/side/side.env}"
side_data_root="${SIDE_DATA_ROOT:-/srv/side/data}"
side_min_free_gb="${SIDE_MIN_FREE_GB:-50}"
side_http_port="${SIDE_HTTP_PORT:-8088}"
side_runtime_uid="${SIDE_RUNTIME_UID:-1000}"
failures=0

ok() { printf 'OK   %s\n' "$1"; }
warn() { printf 'WARN %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

arch="$(uname -m)"
case "$arch" in
  aarch64|arm64) ok "ARM64 host ($arch)" ;;
  *) fail "expected t4g ARM64 host, found $arch" ;;
esac

memory_kib="$(awk '/MemTotal:/ {print $2}' /proc/meminfo)"
if (( memory_kib >= 3500000 )); then
  ok "memory is at least 3.5 GiB"
else
  fail "less than 3.5 GiB RAM is visible"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "Docker daemon is available"
else
  fail "Docker daemon is unavailable to the current user"
fi

if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose plugin is available"
else
  fail "Docker Compose plugin is unavailable"
fi

disk_probe="$side_data_root"
while [[ ! -e "$disk_probe" && "$disk_probe" != "/" ]]; do disk_probe="$(dirname "$disk_probe")"; done
available_kib="$(df -Pk "$disk_probe" | awk 'NR==2 {print $4}')"
required_kib=$((side_min_free_gb * 1024 * 1024))
if (( available_kib >= required_kib )); then
  ok "at least ${side_min_free_gb} GiB free for retained recorder data"
else
  fail "less than ${side_min_free_gb} GiB free at $disk_probe"
fi

if [[ -d "$side_data_root" ]]; then
  data_uid="$(stat -c '%u' "$side_data_root")"
  [[ "$data_uid" == "$side_runtime_uid" ]] \
    && ok "data root is owned by runtime uid $side_runtime_uid" \
    || fail "data root owner uid $data_uid does not match SIDE_RUNTIME_UID=$side_runtime_uid"
fi

if [[ -f "$side_env_file" ]]; then
  mode="$(stat -c '%a' "$side_env_file")"
  [[ "$mode" == "600" ]] && ok "secret env file mode is 600" || fail "secret env file must be chmod 600"
else
  fail "missing secret env file: $side_env_file"
fi

env_value() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$side_env_file" 2>/dev/null || true
}

for key in SIDE_DB_PASSWORD SIDE_ADMIN_PASSCODE SIDE_ACCESS_PASSWORD_HASH BITQUERY_TOKEN ZEROEX_API_KEY; do
  value="$(env_value "$key")"
  # Compose single-quoted values preserve bcrypt dollar signs.
  value="${value#\'}"
  value="${value%\'}"
  if [[ -z "$value" || "$value" == replace-* ]]; then
    fail "$key is missing or still a placeholder"
  elif [[ "$key" == "SIDE_DB_PASSWORD" || "$key" == "SIDE_ADMIN_PASSCODE" ]] && (( ${#value} < 24 )); then
    fail "$key must contain at least 24 characters"
  elif [[ "$key" == "SIDE_ACCESS_PASSWORD_HASH" ]] && [[ ! "$value" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]]; then
    fail "$key must be a bcrypt hash"
  else
    ok "$key is configured"
  fi
done

if command -v ss >/dev/null 2>&1 && ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)${side_http_port}$"; then
  fail "host port $side_http_port is already in use"
else
  ok "host port $side_http_port is available"
fi

if command -v timedatectl >/dev/null 2>&1; then
  ntp="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  [[ "$ntp" == "yes" ]] && ok "host clock is NTP synchronized" || warn "NTP synchronization is not confirmed"
fi

if (( failures > 0 )); then
  printf '\n%d deployment preflight check(s) failed.\n' "$failures"
  exit 1
fi

printf '\nAWS host preflight passed.\n'
