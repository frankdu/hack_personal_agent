#!/usr/bin/env bash
# Install/enable a system service for the current user; sudo is used only for system files.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $EUID -eq 0 ]]; then
  echo 'Run as the intended non-root service user; the script invokes sudo itself.' >&2
  exit 1
fi
project_dir=$(pwd -P)
node_bin=$(command -v node)
service_user=$(id -un)
service_group=$(id -gn)
service_home=$(getent passwd "$service_user" | cut -d: -f6)
# Keep generated systemd syntax unambiguous; fail instead of silently misquoting paths.
for value in "$project_dir" "$node_bin" "$service_home" "$service_user" "$service_group"; do
  [[ $value =~ ^[a-zA-Z0-9_./@-]+$ ]] || { echo "Unsupported character in service user/path." >&2; exit 1; }
done
[[ -f .env.node ]] || {
  echo 'Run bash scripts/setup-node.sh first to create .env.node.' >&2; exit 1;
}
chmod 600 .env.node
unit_file=$(mktemp)
trap 'rm -f "$unit_file"' EXIT
cat > "$unit_file" <<EOF
[Unit]
Description=Curilo GPU agent node
Wants=network-online.target ollama.service
After=network-online.target ollama.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$service_user
Group=$service_group
WorkingDirectory=$project_dir
Environment=HOME=$service_home
Environment=PATH=$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin
ExecCondition=/usr/bin/test -f $project_dir/apps/node-agent/dist/index.js
ExecCondition=$node_bin --env-file=$project_dir/.env.node $project_dir/scripts/check-node-config.mjs
ExecStart=$node_bin --env-file=$project_dir/.env.node $project_dir/apps/node-agent/dist/index.js
Restart=always
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
sudo install -m 644 "$unit_file" /etc/systemd/system/curilo-node.service
sudo systemctl daemon-reload
sudo systemctl enable curilo-node.service
if [[ -f apps/node-agent/dist/index.js ]] && "$node_bin" --env-file=.env.node scripts/check-node-config.mjs; then
  sudo systemctl restart curilo-node.service
  echo 'Node service started. Inspect: journalctl -u curilo-node -f'
else
  # Stop an old instance too, so a rerun cannot leave it using stale credentials.
  sudo systemctl stop curilo-node.service
  echo 'Service installed and enabled, but left stopped until build and configuration are complete.'
  echo 'Complete setup-node.sh and edit .env.node, then run: sudo systemctl restart curilo-node'
fi
