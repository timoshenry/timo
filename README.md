# TIMO — Ticket & Invoice Management Onchain

**Event tickets paid in tUSD8 on the Aevum testnet, with escrow-protected refunds.**

Built for the [Aevum Builder Challenge #1](https://dorahacks.io/hackathon/qday) (QDay).

**Live demo:** https://timo-blush.vercel.app — connect a wallet on the Aevum testnet to explore events, buy a ticket, or try the organizer flow.

## The problem

Buying an event ticket with crypto today usually means sending money straight to the
organizer's wallet. If the event is cancelled, refunds depend on the organizer's goodwill —
buyers chase chats and spreadsheets, and there is no verifiable record of who paid what.
Paper/QR tickets are just as fragile: a static barcode can be screenshotted and reused.

## The solution

TIMO is a single smart contract that acts as a neutral escrow for ticket sales:

1. **Organizers** create an event (price in tUSD8, capacity, sales window, start time).
2. **Buyers** pay the exact ticket price — by approve + buy, or gaslessly with one
   EIP-3009 signature. Funds go into **per-event escrow**, not to the organizer.
   Each payment mints an **ERC-721 ticket** and emits `TicketPurchased`, the onchain
   invoice/receipt tying event, buyer, and amount.
3. **If the event is cancelled**, every *current* ticket owner claims a full refund
   (pull-based, one claim burns the ticket). Refunds follow resale automatically.
4. **If the event happens**, the organizer withdraws the escrow 24 hours after the
   start time. Check-in uses a **dynamic QR**: the owner's wallet signs a payload that
   expires in 60 seconds; the organizer verifies it against `ownerOf` and calls
   `checkIn`, which permanently locks the ticket against reuse or transfer.

Tickets are freely transferable before check-in, so a secondary market works — while
refunds and check-in always follow the current owner.

## Live on Aevum testnet

| Item | Value |
|---|---|
| Network | QDay Aevum Testnet, chain ID `44005` |
| RPC | `https://rpc-test.qday.info` |
| Explorer | https://explorer-test.qday.info |
| tUSD8 | `0x456569838f1d43009A91ebA4263147Afd7233483` (6 decimals) |
| **TIMO contract** | **`0xF66B82e1D8aa5C888A986A08238d90d9D62F30B6`** |
| Deploy tx | `0xcfb23d7622a5f5337abdadbb10f344fa3f7eb4b8bedfba1b1f44e6e2eec49e5d` |

> Contract verification on the Aevum explorer is not available yet (see the starter-kit
> docs), so the deployed source is exactly `contracts/src/TIMO.sol` in this repository.

### Proof transactions (full lifecycle)

| Step | Tx hash |
|---|---|
| Create event “TIMO Launch Night” | `0x78fc90ea163372570ffc8c6e3ba5faf11720146efb9b9722954626021c1ee443` |
| Buy ticket (escrow funded) | `0xee2e90edb7ed4c99a1d075ae9efa43d9941acdca03ece8f860e6693b8404e501` |
| Create + buy “Cancelled Demo Event” | `0x4b2cf7d326521e2d9a1d45aeb66684652bd1eed3ffacece085a05e836400ba6c` / `0x4852ad56d6c94fdbc3d213aad73e55723e8eaa5c756f2e895bd02bc9c97d9616` |
| Cancel event | `0x01aa464512e634a504e062ef9338f127869424981e54ed1fc672507a541197cc` |
| Claim full refund | `0xb67c32c9fa3dcb8e310a1386683603c580d4bf1ab69018af768b6c5beeb50c4d` |

## Architecture

```
Buyer ──approve + buyTicket──────────► TIMO (escrow per event) ──► ERC-721 ticket
Buyer ──EIP-3009 signature──► Relayer ─► buyTicketGasless ────────► ERC-721 ticket
Organizer ──cancelEvent──► owners claimRefund (burn + full refund)
Organizer ──checkIn──────► ticket locked onchain (dynamic-QR verified)
Organizer ──withdraw─────► escrow released at startsAt + 24h
```

- `contracts/src/TIMO.sol` — the whole product: escrow accounting, ERC-721 tickets,
  gasless purchases with per-buyer/per-event bound EIP-3009 nonces, pull refunds,
  check-in locking, delayed organizer withdrawal.
- `contracts/test/TIMO.t.sol` — 20 Foundry tests covering every rule above.
- `web/` — Next.js app (Explore, Event Detail, My Tickets with dynamic check-in QR,
  Organizer dashboard) built on the official Aevum starter kit.
- `e2e-local.sh` — scripted end-to-end run against a local Shanghai anvil.

### Safety properties

- Exact-amount payments only; `sold <= capacity` always.
- Checks-effects-interactions + `ReentrancyGuard` on all fund-moving functions.
- Pull refunds (no push loops), no admin keys, no pauser; the organizer can never
  touch the escrow of a cancelled event.
- Shanghai EVM only — bytecode is checked with the starter kit's Shanghai checker.

## Run it locally

Requirements: Node 22+, pnpm, Foundry.

```bash
git clone https://github.com/timoshenry/timo.git && cd timo

# Contract dependencies (not vendored): OpenZeppelin + forge-std
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts contracts/lib/openzeppelin-contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std

pnpm install
cd contracts && forge test    # 31 tests: 20 TIMO + 11 starter-kit Checkout
cd ..

# Local end-to-end demo (anvil, MockUSD8):
bash e2e-local.sh

# Web app against a local fork of Aevum:
make fork             # terminal 1
# terminal 2: deploy TIMO to the fork and start the app
cd contracts && forge script script/DeployTIMO.s.sol --rpc-url http://127.0.0.1:8555 --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
cp web/.env.example web/.env.local   # set NEXT_PUBLIC_TIMO_FORK=<address printed above>, NEXT_PUBLIC_NETWORKS=fork,aevum
make dev
```

### Environment variables (web)

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_NETWORKS` | `aevum`, `fork`, `local` (comma-separated) |
| `NEXT_PUBLIC_TIMO_AEVUM` / `_FORK` / `_LOCAL` | TIMO contract address per network |
| `NEXT_PUBLIC_CHECKOUT_*` | Starter-kit Checkout addresses (kit pages) |
| `RELAYER_PRIVATE_KEY` | Optional test wallet for the kit's gasless checkout relayer |

## Roadmap

- Gasless ticket purchase in the UI (contract already supports it; needs a TIMO-aware relayer).
- Tiered tickets (VIP/regular) and seat maps.
- Resale price caps / organizer royalties as an organizer option.
- Push notifications for cancellation, powered by contract events.

## License & credits

MIT. Built on the MIT-licensed [Aevum starter kit](https://github.com/qday-io/aevum-starter-kit)
by QDay; OpenZeppelin Contracts (MIT) for ERC-721 and security primitives.
