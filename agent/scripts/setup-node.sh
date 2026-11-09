#!/usr/bin/env bash
# Run as the non-root service user. --configure-only skips dependency installation.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ $# -eq 0 || ( $# -eq 1 && $1 == --configure-only ) ]] || { echo 'Usage: setup-node.sh [--configure-only]' >&2; exit 1; }
if [[ $EUID -eq 0 ]]; then
  echo 'Run as the non-root account that will run the node.' >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a!==24 || b<12) throw Error("Node >=24.12 and <25 is required")'
[[ $(npm --version) == 11.* ]] || { echo 'npm 11 is required.' >&2; exit 1; }
if [[ ! -e .env.node ]]; then
  (umask 077; set -o noclobber; cat > .env.node <<'EOF'
MODE=PROD
NODE_ENV=production
HOST=0.0.0.0
PORT=3101
# Required: backend origin reachable from this machine.
BACKEND_URL=
# Required: this node's private origin reachable from the backend.
NODE_ENDPOINT=
# Required: copy the backend's NODE_SHARED_TOKEN (at least 32 characters).
NODE_SHARED_TOKEN=
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_AUTO_DISCOVER=true
ENABLED_TOOLS=read,bash,edit,write,grep,find,ls
# Defaults use the service user's home, keeping state outside chat workspaces.
# NODE_NAME=my-gpu-node
# NODE_STATE_DIR=/absolute/private/state/path
# AGENT_WORKSPACE_DIR=/absolute/existing/project
# RUNTIME_CONFIG=/absolute/runtime-manifest.json
EOF
  )
  echo 'Created private .env.node; fill in the three required enrollment settings.'
else
  echo 'Preserved existing .env.node.'
fi
chmod 600 .env.node
[[ ${1:-} != --configure-only ]] || exit 0
npm ci
npm run build:packages
npm run build -w @agent/node-agent
echo 'Build complete. Next: bash scripts/install-node-service.sh'
