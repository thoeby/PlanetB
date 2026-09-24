#!/usr/bin/env bash
# Writes $TALER_HOME/taler.conf from infra/taler/taler.conf.in and .env, and
# makes the issuer's offline master key once (PLAN-money.md §1). Idempotent:
# the key is kept, the file is rewritten. Prints the path of the file.
set -euo pipefail
cd "$(dirname "$0")/.."

CURRENCY=${TALER_CURRENCY:-PLANETB}
TALER_HOME=${TALER_HOME:-$PWD/data/taler}
EXCHANGE_PORT=${TALER_EXCHANGE_PORT:-8091}
BANK_PORT=${TALER_BANK_PORT:-8092}
EXCHANGE_URL=${TALER_EXCHANGE_URL:-http://localhost:$EXCHANGE_PORT/}
BANK_URL=${TALER_BANK_URL:-http://localhost:$BANK_PORT/}
BIND=${TALER_BIND:-127.0.0.1}
PGU=${PGUSER:-postgres}; PGW=${PGPASSWORD:-postgres}
PGH=${TALER_PGHOST:-${PGHOST:-localhost}}; PGP=${PGPORT:-5432}
EXCHANGE_DB=${TALER_EXCHANGE_DB:-postgres://$PGU:$PGW@$PGH:$PGP/${TALER_EXCHANGE_DBNAME:-taler_exchange}}
BANK_DB=${TALER_BANK_DB:-postgresql://$PGH:$PGP/${TALER_BANK_DBNAME:-libeufin}?user=$PGU&password=$PGW}
EXCHANGE_BANK_PASSWORD=${TALER_EXCHANGE_BANK_PASSWORD:-exchange-password}
TERMS_DIR=${TALER_TERMS_DIR:-$PWD/infra/taler/terms/}
SECRET=${TALER_SECRET:-${JWT_SECRET:-dev-secret-change-me-0123456789abcdef}}
# The issuer's account at the bank, named as libeufin-bank names it: by the
# host of its BASE_URL, without the port.
BANK_HOST=${BANK_URL#*://}; BANK_HOST=${BANK_HOST%%/*}; BANK_HOST=${BANK_HOST%%:*}
EXCHANGE_PAYTO="payto://x-taler-bank/$BANK_HOST/exchange?receiver-name=Issuer"

mkdir -p "$TALER_HOME"
conf=$TALER_HOME/taler.conf
# Values go into sed's replacement, where & and | mean something.
esc () { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
args=()
for v in CURRENCY TALER_HOME EXCHANGE_URL BANK_URL EXCHANGE_PORT BANK_PORT BIND \
         EXCHANGE_DB BANK_DB SECRET TERMS_DIR EXCHANGE_PAYTO EXCHANGE_BANK_PASSWORD; do
    args+=(-e "s|@$v@|$(esc "${!v}")|g")
done
sed "${args[@]}" -e "s|@MASTER_PUB@|UNSET|g" infra/taler/taler.conf.in > "$conf"

# Coins in a 1-2-5 series, like notes and coins, from 0.01 to 10000.
for v in 0.01 0.02 0.05 0.1 0.2 0.5 1 2 5 10 20 50 100 200 500 1000 2000 5000 10000; do
    cat >> "$conf" <<COIN

[coin_${CURRENCY}_${v/./_}]
VALUE = $CURRENCY:$v
DURATION_WITHDRAW = 30 days
DURATION_SPEND = 5 years
DURATION_LEGAL = 10 years
FEE_WITHDRAW = $CURRENCY:0
FEE_DEPOSIT = $CURRENCY:0
FEE_REFRESH = $CURRENCY:0
FEE_REFUND = $CURRENCY:0
CIPHER = RSA
RSA_KEYSIZE = 2048
COIN
done

MASTER_PUB=$(taler-exchange-offline -c "$conf" setup)
taler-exchange-config -c "$conf" -s exchange -o MASTER_PUBLIC_KEY -V "$MASTER_PUB"
echo "$conf"
