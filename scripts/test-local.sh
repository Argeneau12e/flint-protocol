#!/usr/bin/env bash
# Runs the Anchor test suite against a local validator.
#
# Why this exists instead of plain `anchor test`:
#
# `init_config` verifies that its signer is this program's *upgrade authority*.
# Anchor deploys to the local validator with `--bpf-program`, which sets the
# authority to `None` — with no authority address to compare against, the check
# rejects every signer and the suite could only ever prove the negative half.
#
# So this script deploys the same binary with `--upgradeable-program`, naming a
# dedicated test keypair as the authority, and runs the same ts-mocha suite
# against it. The positive path — the genuine upgrade authority succeeds — is
# then exercised for real rather than mocked, and "wrong signer is rejected" is
# a comparison against a different key rather than an accident of which wallet
# is loaded.
#
# Usage (from the repo root):
#   scripts/test-local.sh
#
# It starts and stops its own validator; nothing here touches devnet.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# `wsl.exe` starts a non-login shell, so ~/.profile never runs and the Solana
# toolchain is not on PATH. Add it explicitly rather than relying on the caller
# having exported it — the script has to work standalone as well as under a
# wrapper.
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
[[ -d "$SOLANA_BIN" ]] && export PATH="$SOLANA_BIN:$PATH"

# --- Node must resolve to a *Linux* binary -----------------------------------------------------
# nvm4w puts a Windows `npx` on the WSL PATH. A Windows node.exe launched from bash does not
# receive this script's exported ANCHOR_* variables (cmd.exe does not inherit the WSL
# environment), so the suite died at load time with "ANCHOR_PROVIDER_URL is not defined".
# Force the WSL-installed Node instead, and refuse to continue on anything else.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 20 > /dev/null 2>&1 || nvm use --silent default > /dev/null 2>&1 || true
fi

NODE_BIN="$(command -v node || true)"
case "$NODE_BIN" in
  /mnt/*)
    echo "ERROR: resolving a Windows node via $NODE_BIN — WSL Node is not active" >&2
    exit 1
    ;;
  "") ;;
esac
echo "node: $NODE_BIN ($($NODE_BIN --version 2>/dev/null))"
echo "npx: $(command -v npx)"
# ---------------------------------------------------------------------------------------------

PROGRAM_ID="ziZiaCVcDaenoUP7jHdEPk4R2XJ8zeY5UbMPKFuqZxE"
SO="target/deploy/flint_escrow.so"
# Deterministic, throwaway, localnet-only. The upgrade authority for the test
# deployment. It holds no value and exists only to sign on a local validator.
TEST_AUTHORITY_KEY="target/localnet-upgrade-authority.json"

if [[ ! -f "$SO" ]]; then
  echo "missing $SO - run 'anchor build' first" >&2
  exit 1
fi

if [[ ! -f "$TEST_AUTHORITY_KEY" ]]; then
  echo "creating localnet upgrade authority keypair"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$TEST_AUTHORITY_KEY"
fi

AUTHORITY_PUBKEY="$(solana-keygen pubkey "$TEST_AUTHORITY_KEY")"
echo "localnet upgrade authority: $AUTHORITY_PUBKEY"

# The suite needs to sign as that authority, so point the provider at it.
export ANCHOR_WALLET="$ROOT/$TEST_AUTHORITY_KEY"
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_CLUSTER=localnet

LOG="$(mktemp)"
solana-test-validator \
  --reset \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$AUTHORITY_PUBKEY" \
  > "$LOG" 2>&1 &
VALIDATOR_PID=$!

cleanup() {
  echo "stopping validator (pid $VALIDATOR_PID)"
  kill "$VALIDATOR_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

# Wait for the RPC to answer before handing over to the suite: a race here
# fails as a confusing "fetch failed" in the first test rather than a clear
# "validator never came up".
for _ in $(seq 1 60); do
  if solana --url "$ANCHOR_PROVIDER_URL" cluster-version > /dev/null 2>&1; then
    echo "validator up"
    break
  fi
  sleep 1
done

if ! solana --url "$ANCHOR_PROVIDER_URL" cluster-version > /dev/null 2>&1; then
  echo "validator failed to start:" >&2
  cat "$LOG" >&2
  exit 1
fi

solana --url "$ANCHOR_PROVIDER_URL" --keypair "$TEST_AUTHORITY_KEY" airdrop 100 \
  > /dev/null 2>&1 || true

# Surface the deployed authority, so the suite's own assumption is visible in the
# run output rather than silently failing deep inside a test.
solana --url "$ANCHOR_PROVIDER_URL" program show "$PROGRAM_ID" | sed -n '1,8p'

npx ts-mocha -p ./tsconfig.json -t 1000000 "programs/flint-escrow/tests/**/*.ts"