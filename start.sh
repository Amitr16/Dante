#!/usr/bin/env bash
set -euo pipefail

# Start Tailscale in userspace mode (works in many container environments)
# Requires env: TAILSCALE_AUTHKEY

if [[ -z "${TAILSCALE_AUTHKEY:-}" ]]; then
  echo "TAILSCALE_AUTHKEY is not set" >&2
  exit 1
fi

# Start tailscaled (userspace networking)
mkdir -p /tmp/tailscale

echo "Starting tailscaled..."
# --tun=userspace-networking avoids needing /dev/net/tun
# --socks5-server is optional; handy for debugging
/usr/sbin/tailscaled \
  --state=/tmp/tailscale/tailscaled.state \
  --socket=/tmp/tailscale/tailscaled.sock \
  --tun=userspace-networking \
  --port=41641 \
  >/tmp/tailscaled.log 2>&1 &

# Wait for daemon
for i in $(seq 1 30); do
  if /usr/bin/tailscale --socket=/tmp/tailscale/tailscaled.sock status >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "Bringing up tailscale..."
/usr/bin/tailscale --socket=/tmp/tailscale/tailscaled.sock up \
  --authkey="${TAILSCALE_AUTHKEY}" \
  --hostname="${TAILSCALE_HOSTNAME:-dante-render}" \
  --accept-dns=false \
  --reset \
  >/tmp/tailscale-up.log 2>&1 || {
    echo "tailscale up failed" >&2
    cat /tmp/tailscale-up.log >&2 || true
    exit 1
  }

/usr/bin/tailscale --socket=/tmp/tailscale/tailscaled.sock status || true

# Expose socket path to the Node app so it can use `tailscale curl` in userspace networking mode.
export TAILSCALE_SOCKET=/tmp/tailscale/tailscaled.sock

echo "Starting web server..."
exec node server.js
