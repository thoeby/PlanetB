# The world's cash, as one image (PLAN-money.md §1): GNU Taler's issuer
# (taler-exchange), libeufin-bank and wallet-core — the very builds
# tools/taler-step0.sh was proven against, pinned by their Nix store paths and
# fetched from the Nix binary cache — plus walletd. infra/compose.yml runs it
# twice: as `cash` (issuer and bank) and as `walletd`.
#
# Neither the issuer nor wallet-core's socket server runs on Windows itself;
# this is how a Windows machine runs them, under Docker Desktop.
FROM nixos/nix:2.24.9 AS taler
RUN nix-env -i \
      /nix/store/9sc42nm9lq15wm08199wa5380ii5h6v2-taler-exchange-1.3.0 \
      /nix/store/c4frklddl48p360bn4wbx601qv8ivvvv-taler-wallet-core-1.5.10 \
      /nix/store/impawclqkdq0qka7iqgla0vzqs96jqc8-libeufin-1.3.0 \
 && nix-store --gc

FROM ubuntu:24.04
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-psycopg \
      postgresql-client curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=taler /nix /nix
ENV PATH=/nix/store/9sc42nm9lq15wm08199wa5380ii5h6v2-taler-exchange-1.3.0/bin:/nix/store/c4frklddl48p360bn4wbx601qv8ivvvv-taler-wallet-core-1.5.10/bin:/nix/store/impawclqkdq0qka7iqgla0vzqs96jqc8-libeufin-1.3.0/bin:$PATH
WORKDIR /world
COPY server/ server/
COPY tools/taler-conf.sh tools/taler-up.sh tools/
COPY infra/taler/ infra/taler/
# walletd finds its checkout by db/ and client/ (server/splatworld/config.py).
RUN mkdir -p db client
RUN pip3 install --no-cache-dir --break-system-packages --no-deps -e server/
ENV USER=root
CMD ["bash", "tools/taler-up.sh", "serve"]
