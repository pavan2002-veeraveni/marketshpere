#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../nginx/certs" && pwd)"
mkdir -p "${CERT_DIR}"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "${CERT_DIR}/server.key" \
  -out "${CERT_DIR}/server.crt" \
  -subj "/CN=marketsphere.local/O=MarketSphere Local Dev/C=US" \
  -addext "subjectAltName=DNS:localhost,DNS:marketsphere.local,IP:127.0.0.1"

chmod 600 "${CERT_DIR}/server.key"
echo "Generated local TLS certificate in ${CERT_DIR}/server.crt and server.key"
