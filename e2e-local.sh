#!/usr/bin/env bash
# TIMO end-to-end flow against a local anvil chain (Shanghai, MockUSD8).
# Covers: create event -> buy -> cancel -> refund, and
#         create event -> buy -> check-in (transfer locked) -> withdraw.
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
RPC=http://127.0.0.1:8545
cd "$(dirname "$0")/contracts"

ORG_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0 organizer
BUYER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d # anvil #1 buyer
ORG=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
BUYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
PRICE=25000000

anvil --hardfork shanghai --port 8545 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
sleep 2

send() { cast send --rpc-url $RPC --private-key "$1" "$2" "$3" "${@:4}" >/dev/null; }
call() { cast call --rpc-url $RPC "$1" "$2" "${@:3}"; }

TOKEN=$(forge create --broadcast --rpc-url $RPC --private-key $ORG_KEY src/mocks/MockUSD8.sol:MockUSD8 2>/dev/null | grep -i "Deployed to" | awk '{print $NF}')
TIMO=$(forge create --broadcast --rpc-url $RPC --private-key $ORG_KEY src/TIMO.sol:TIMO --constructor-args $TOKEN 2>/dev/null | grep -i "Deployed to" | awk '{print $NF}')
echo "MockUSD8: $TOKEN"
echo "TIMO:     $TIMO"

send $ORG_KEY $TOKEN "mint(address,uint256)" $BUYER 100000000

NOW=$(date +%s); SALES_END=$((NOW+86400)); STARTS=$((NOW+172800))

# ── Flow A: buy -> cancel -> refund ─────────────────────────────────────────
send $ORG_KEY $TIMO "createEvent(uint256,uint32,uint64,uint64,string)" $PRICE 2 $SALES_END $STARTS "ipfs://e2e-a"
send $BUYER_KEY $TOKEN "approve(address,uint256)" $TIMO $PRICE
send $BUYER_KEY $TIMO "buyTicket(uint256)" 1
echo "A: ticket 1 owner = $(call $TIMO 'ownerOf(uint256)(address)' 1) (expect buyer)"
echo "A: escrow after buy = $(call $TIMO 'eventOf(uint256)(address,uint256,uint256,uint32,uint32,uint64,uint64,uint8,bool,string)' 1 | sed -n 3p) (expect 25000000)"
send $ORG_KEY $TIMO "cancelEvent(uint256)" 1
BAL_BEFORE=$(call $TOKEN "balanceOf(address)(uint256)" $BUYER)
send $BUYER_KEY $TIMO "claimRefund(uint256)" 1
BAL_AFTER=$(call $TOKEN "balanceOf(address)(uint256)" $BUYER)
echo "A: buyer balance $BAL_BEFORE -> $BAL_AFTER (expect +25000000)"

# ── Flow B: buy -> check-in locks transfer -> withdraw ──────────────────────
send $ORG_KEY $TIMO "createEvent(uint256,uint32,uint64,uint64,string)" $PRICE 2 $SALES_END $STARTS "ipfs://e2e-b"
send $BUYER_KEY $TOKEN "approve(address,uint256)" $TIMO $PRICE
send $BUYER_KEY $TIMO "buyTicket(uint256)" 2
cast rpc evm_increaseTime 172800 --rpc-url $RPC >/dev/null; cast rpc evm_mine --rpc-url $RPC >/dev/null
send $ORG_KEY $TIMO "checkIn(uint256)" 2
if send $BUYER_KEY $TIMO "transferFrom(address,address,uint256)" $BUYER $ORG 2 2>/dev/null; then
  echo "B: ERROR transfer of checked-in ticket succeeded"; exit 1
else
  echo "B: transfer of checked-in ticket correctly reverted"
fi
cast rpc evm_increaseTime 86401 --rpc-url $RPC >/dev/null; cast rpc evm_mine --rpc-url $RPC >/dev/null
ORG_BEFORE=$(call $TOKEN "balanceOf(address)(uint256)" $ORG)
send $ORG_KEY $TIMO "withdraw(uint256)" 2
ORG_AFTER=$(call $TOKEN "balanceOf(address)(uint256)" $ORG)
echo "B: organizer balance $ORG_BEFORE -> $ORG_AFTER (expect +25000000)"
echo "E2E OK"
