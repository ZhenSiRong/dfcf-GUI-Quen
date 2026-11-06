#!/usr/bin/env bash
# 交易主入口（cron / systemd 调这个）
# 用法：scripts/daily.sh [--live] [--max-orders N] ...
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p logs
exec flock -n logs/runner.lock node src/runner.mjs "$@" >> logs/cron.log 2>&1
