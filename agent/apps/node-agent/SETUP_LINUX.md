# Linux GPU node setup

Run from the repository root as the non-root account that should run agent tools.
Requires Node >=24.12 and <25, npm 11, systemd, working NVIDIA drivers and local
Ollama with downloaded models. The frontend, backend and database run elsewhere.

```bash
bash scripts/setup-node.sh
nano .env.node
bash scripts/install-node-service.sh
```

Setup installs workspace dependencies and builds only contracts and the node.
It preserves existing configuration and creates new `.env.node` files with mode 0600. Use `--configure-only` to create configuration without installing packages.
The installer uses sudo for the service file and runs the node as the invoking
user. It enables boot startup, but leaves the service stopped if the build or
enrollment configuration is missing. Startup conditions also prevent launch on
reboot until those prerequisites exist. Re-run the installer if Node or the
checkout moves. Ollama must be installed separately.

## Required manual configuration

Set these values in the private, git-ignored `.env.node`:

- `BACKEND_URL`: remote backend origin reachable from this machine.
- `NODE_ENDPOINT`: this node's private origin reachable from the backend,
  e.g. `http://192.168.4.103:3101`. Use a stable private IP or DNS name.
- `NODE_SHARED_TOKEN`: copy the backend's existing token exactly (32+ characters).

The example IP is not a substitute for checking your network. The default listener
is `0.0.0.0:3101`; optionally set `HOST` to a private interface address. Restrict
inbound TCP 3101 to the backend using your firewall. Allow outbound connections
to the backend. Ollama remains local on port 11434.

On the backend, add the exact node endpoint to `NODE_ENDPOINT_ALLOWLIST`, preserve
existing comma-separated entries, and restart the backend. If it runs in Docker,
verify reachability from inside its container. No database or Jev credentials are
needed on this node.

```bash
node --env-file=.env.node scripts/check-node-config.mjs
sudo systemctl enable --now ollama
sudo systemctl restart curilo-node
systemctl status curilo-node --no-pager
journalctl -u curilo-node -n 100 --no-pager
curl -fsS http://127.0.0.1:3101/health/live
curl -fsS http://127.0.0.1:3101/v1/node/status
curl -fsS http://127.0.0.1:3101/health/ready
```

If HOST is a private interface address, use that address for curl. From the
backend, also request `http://<node-address>:3101/health/live`. Configuration
validation checks syntax, not connectivity or credential agreement.

Readiness requires enrollment, a warmed model, a free execution slot and no
unresolved execution. Initial discovery benchmarks may take several minutes.
Automatic model selection requires suitable capabilities and at least 20 tokens/s;
use the remote frontend to manually activate a downloaded model if needed.
Installation itself does not download models or invoke inference.

## Maintenance

```bash
# Logs
journalctl -u curilo-node -f
# Configuration changes
sudo systemctl restart curilo-node
# After updating the checkout
sudo systemctl stop curilo-node
bash scripts/setup-node.sh
bash scripts/install-node-service.sh
# Disable without deleting data
sudo systemctl disable --now curilo-node
```

State defaults to `~/.curilo-agent/node-agent`; chat workspaces default to
`~/.curilo/workspace/chat_sessions`, under the service user's home. Optionally
set `AGENT_WORKSPACE_DIR` to an existing project. Keep private state outside tool
workspaces. Shell tools execute with the service user's permissions, without an
OS sandbox. Restarted executions are retained as unknown for reconciliation,
not replayed automatically.
