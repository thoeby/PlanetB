#!/usr/bin/env bash
# PLAN-money.md §6, step 0 — see tools/taler-step0.py for what is proven.
# Starts the issuer and the bank (tools/taler-up.sh) if they are not up; needs
# taler-wallet-cli on PATH and `pip install -e server/`.
set -euo pipefail
cd "$(dirname "$0")/.."
bash tools/taler-up.sh > /dev/null
exec python3 tools/taler-step0.py "${TALER_HOME:-$PWD/data/taler}/taler.conf"
