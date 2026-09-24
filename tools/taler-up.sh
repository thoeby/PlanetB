#!/usr/bin/env bash
# Starts the world's cash (PLAN-money.md §1) from the Taler binaries on PATH:
# libeufin-bank, and the issuer (taler-exchange-httpd, its two key helpers,
# wirewatch and expire). What infra/compose.yml runs as `bank` and `issuer`,
# for a machine without Docker. Nothing here computes anything for the world.
#
#   tools/taler-up.sh          start what is not running; print <<READY>>
#   tools/taler-up.sh stop     stop what this script started
#   tools/taler-up.sh reset    stop, drop both databases and the keys
set -euo pipefail
cd "$(dirname "$0")/.."
TALER_HOME=${TALER_HOME:-$PWD/data/taler}; export TALER_HOME
export USER=${USER:-$(id -un)}
RUN=$TALER_HOME/run
EXCHANGE_URL=${TALER_EXCHANGE_URL:-http://localhost:${TALER_EXCHANGE_PORT:-8091}/}
BANK_URL=${TALER_BANK_URL:-http://localhost:${TALER_BANK_PORT:-8092}/}
ISSUER_PASSWORD=${TALER_ISSUER_PASSWORD:-issuer-password}
EXCHANGE_BANK_PASSWORD=${TALER_EXCHANGE_BANK_PASSWORD:-exchange-password}
PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A -d postgres"

stop () {
    for f in "$RUN"/*.pid; do
        [ -e "$f" ] || continue
        kill "$(cat "$f")" 2>/dev/null || true
        rm -f "$f"
    done
}
case ${1:-} in
    stop) stop; exit 0 ;;
    reset)
        stop
        $PSQL -c 'DROP DATABASE IF EXISTS taler_exchange WITH (FORCE)'
        $PSQL -c 'DROP DATABASE IF EXISTS libeufin WITH (FORCE)'
        rm -rf "$TALER_HOME"
        exit 0 ;;
esac

up () { curl -sf -o /dev/null --max-time 2 "$1"; }
wait_for () { # url what
    for _ in $(seq 1 120); do up "$1" && return 0; sleep 0.5; done
    echo "taler-up: $2 did not answer at $1" >&2; exit 1
}
if up "${EXCHANGE_URL}keys" && up "${BANK_URL}config"; then echo '<<READY>>'; exit 0; fi

conf=$(bash tools/taler-conf.sh)
mkdir -p "$RUN"
start () { # name command...
    local name=$1; shift
    "$@" > "$RUN/$name.log" 2>&1 &
    echo $! > "$RUN/$name.pid"
}

# ------------------------------------------------------------------ the bank
if [ -z "$($PSQL -c "SELECT 1 FROM pg_database WHERE datname = 'libeufin'")" ]; then
    $PSQL -c 'CREATE DATABASE libeufin'
fi
libeufin-bank dbinit -c "$conf" > "$RUN/bank-dbinit.log" 2>&1
if ! up "${BANK_URL}config"; then
    start bank libeufin-bank serve -c "$conf"
fi
wait_for "${BANK_URL}config" bank
# "admin" is where the world issues from: it may go into debt, and that debt
# is all the cash there is. "exchange" is the issuer's own account.
currency=$(taler-exchange-config -c "$conf" -s taler -o CURRENCY)
libeufin-bank passwd -c "$conf" admin "$ISSUER_PASSWORD" > "$RUN/bank-setup.log" 2>&1
libeufin-bank edit-account -c "$conf" --debit_threshold="$currency:1000000000" admin >> "$RUN/bank-setup.log" 2>&1
libeufin-bank create-account -c "$conf" --username exchange --password "$EXCHANGE_BANK_PASSWORD" \
    --name Issuer --exchange --payto_uri "$(taler-exchange-config -c "$conf" -s exchange-account-1 -o PAYTO_URI)" \
    >> "$RUN/bank-setup.log" 2>&1 || libeufin-bank passwd -c "$conf" exchange "$EXCHANGE_BANK_PASSWORD" >> "$RUN/bank-setup.log" 2>&1

# ---------------------------------------------------------------- the issuer
if [ -z "$($PSQL -c "SELECT 1 FROM pg_database WHERE datname = 'taler_exchange'")" ]; then
    $PSQL -c 'CREATE DATABASE taler_exchange'
fi
taler-exchange-dbinit -c "$conf" > "$RUN/exchange-dbinit.log" 2>&1
if ! up "${EXCHANGE_URL}config"; then
    start secmod-rsa taler-exchange-secmod-rsa -c "$conf"
    start secmod-eddsa taler-exchange-secmod-eddsa -c "$conf"
    start secmod-cs taler-exchange-secmod-cs -c "$conf"
    sleep 1
    start exchange taler-exchange-httpd -c "$conf"
    start wirewatch taler-exchange-wirewatch -c "$conf"
    start expire taler-exchange-expire -c "$conf"
fi
wait_for "${EXCHANGE_URL}management/keys" issuer

# The offline key signs the coins, the zero fees for this year and the next,
# and the issuer's account. Signing again what is already signed is harmless.
payto=$(taler-exchange-config -c "$conf" -s exchange-account-1 -o PAYTO_URI)
year=$(date +%Y)
taler-exchange-offline -c "$conf" download sign \
    wire-fee now x-taler-bank "$currency:0" "$currency:0" \
    wire-fee $((year + 1)) x-taler-bank "$currency:0" "$currency:0" \
    global-fee now "$currency:0" "$currency:0" "$currency:0" 1h 10years 1000 \
    global-fee $((year + 1)) "$currency:0" "$currency:0" "$currency:0" 1h 10years 1000 \
    enable-account "$payto" \
    upload > "$RUN/offline.log" 2>&1 || true
wait_for "${EXCHANGE_URL}keys" "issuer's /keys"
echo '<<READY>>'
