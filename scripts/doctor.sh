#!/usr/bin/env bash
# 登录态巡检（建议每交易日 09:00 跑一次）
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p logs
exec flock -n logs/doctor.lock node scripts/doctor.mjs >> logs/cron.log 2>&1
