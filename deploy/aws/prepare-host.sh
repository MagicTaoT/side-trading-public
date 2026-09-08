#!/usr/bin/env bash
set -euo pipefail

side_owner="${SUDO_USER:-$USER}"
side_postgres_uid="${SIDE_POSTGRES_UID:-999}"
side_postgres_gid="${SIDE_POSTGRES_GID:-999}"

sudo install -d -m 0750 -o "$side_owner" -g "$side_owner" /opt/side
sudo install -d -m 0750 -o "$side_owner" -g "$side_owner" /srv/side
sudo install -d -m 0750 -o "$side_owner" -g "$side_owner" /srv/side/data
sudo install -d -m 0750 -o "$side_owner" -g "$side_owner" /srv/side/data/recordings
sudo install -d -m 0750 -o "$side_owner" -g "$side_owner" /srv/side/data/recording-archives
sudo install -d -m 0750 -o "$side_owner" -g "$side_owner" /srv/side/data/backtests
sudo install -d -m 0700 -o "$side_postgres_uid" -g "$side_postgres_gid" /srv/side/postgres
sudo install -d -m 0700 -o "$side_owner" -g "$side_owner" /etc/side

printf 'Prepared /opt/side, /srv/side, and /etc/side.\n'
printf 'Next: install /etc/side/side.env with mode 600, then run preflight.sh.\n'
