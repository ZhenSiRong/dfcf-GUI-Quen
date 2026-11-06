#!/usr/bin/env bash
# 一次性规则执行入口（cron / systemd / 手动）
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p logs

# systemd 的 PATH 可能不含 nvm；优先用当前 PATH，找不到就用本机绝对路径
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$HOME/.nvm/versions/node/v24.21.0/bin/node"
fi

exec /usr/bin/flock -n logs/rule.lock "$NODE_BIN" scripts/run_rule.mjs "$@"
