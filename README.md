# TIMO — Ticket & Invoice Management Onchain

**Event tickets paid in tUSD8 on the Aevum testnet, sold by an official ticket agent with escrow-protected refunds.**

Built for the [Aevum Builder Challenge #1](https://dorahacks.io/hackathon/qday) (QDay).

**Live demo:** https://timo-blush.vercel.app — connect a wallet on the Aevum testnet to explore events and buy a ticket gas-free.

## The problem

Buying an event ticket with crypto today usually means sending money straight to the
organizer's wallet. If the event is cancelled, refunds depend on the organizer's goodwill —
buyers chase chats and spreadsheets, and there is no verifiable record of who paid what.
Paper/QR tickets are just as fragile: a static barcode can be screenshotted and reused.
And anyone being able to publish events on a platform invites fraud.

## The solution — TIMO v2, an official ticket agent

TIMO is not an open marketplace. TIMO is the **official ticket agent**: organizers are
vetted **offline** by the TIMO team (venue, date, price, capacity, deal), and only TIMO
publishes their events on-chain. A single smart contract holds all sales money in
**per-event escrow** and enforces the rules for everyone:

1. **Event creation (platform only).** `createEvent` is `onlyOwner`. Each event records,
   immutably: price and capacity (the deal's allocation — they can never be changed),
   a service fee (default 1%), one **BossOrganizer** wallet (event owner and sole payout
   recipient — not an operator), **1–3 AdminOrganizer** wallets (sales/transaction/
   check-in lists + scanning) and **5–25 GuardOrganizer** wallets (scanning only).
   Roles are per event and can never be replaced.
2. **Buying is relayed.** The buyer signs one EIP-3009 authorization; the TIMO relayer
   submits `buyTicketGasless` and pays the gas — buyers need no tQDAY at all. The signed
   nonce binds event + buyer + purchase count, so a relayer cannot replay it, change the
   amount (always the event's immutable price) or redirect it. A standard approve + buy
   flow remains as fallback. Every purchase mints an **ERC-721 ticket** whose metadata is
   generated **on-chain** (base64 `tokenURI`: event name, image, date, live status) and
   emits `TicketPurchased`, the onchain invoice/receipt.
3. **Check-in is relayed and verified on-chain.** The attendee shows a **dynamic QR**
   (owner-signed payload, 60-second expiry). Staff scan it and sign the check-in; the
   relayer submits `checkInRelayed`. The contract verifies **both** signatures — the
   owner's against `ownerOf`, and the staff member's role for that event — so no one can
   lock a ticket without the attendee present, and staff of one event are powerless at
   another. Checked-in tickets are locked against transfer.
4. **Refunds always work.** If TIMO cancels an event (the organizer's off-chain decision),
   every *current* ticket owner claims a full refund — pull-based, one claim burns the
   ticket. If an event is **rescheduled** (schedule edits keep the same event and the same
   tickets; the NFT date updates automatically), a **7-day voluntary refund window** opens
   for buyers who cannot attend the new date.
5. **Settlement.** After a successful event (start + 24h), the platform withdraws the
   escrow in one transaction, split by the event's fee: **99% to the BossOrganizer
   wallet, 1% to the TIMO fundwallet** (defaults). The fee is taken at withdraw time only,
   so refunds are always payable in full.

Tickets are ERC-721 and transferable outside the app (TIMO shows no transfer button —
off-platform transfers are the owner's own business); My Tickets always reflects live
ownership, and refunds follow the current owner.

## Live on Aevum testnet

| Item | Value |
|---|---|
| Network | QDay Aevum Testnet, chain ID `44005` |
| RPC | `https://rpc-test.qday.info` |
| Explorer | https://explorer-test.qday.info |
| tUSD8 | `0x456569838f1d43009A91ebA4263147Afd7233483` (6 decimals) |
| **TIMO v2 contract** | **`0x8FE9b1b5f7769daf99737e4924A04e89d13260a1`** |
| v2 deploy tx | `0x315724c21900ac0a4ce3d6e10fb2e79a0d6756e37c572dbfd4b6b3087f0da687` (block 4013996) |
| Fee recipient (fundwallet) | `0x7580d1C234d70A8583D43c5e454B42ec78032D50` |
| Relayer | `0xCDce6844bA19e4a85Ad653a0eAF728485E67E981` |
| TIMO v1 contract (superseded) | `0xF66B82e1D8aa5C888A986A08238d90d9D62F30B6` |

> Contract verification on the Aevum explorer is not available yet (see the starter-kit
> docs), so the deployed source is exactly `contracts/src/TIMOv2.sol` in this repository.

### Proof transactions — v2 live flow (all relayed where the model says so)

| Step | Tx hash |
|---|---|
| Create event 1 “TIMO v2 Launch Night” (roles locked in) | `0x3068618836e0da33ab341911f89bb1e6be96cf8c57f088e0d006ebd5a0991242` |
| Create events 2 (reschedule proof) / 3 (cancel proof) | `0x6c75e4fda6fa2f294149d3f4b1a21674cc4fe70326b888eee68118f6f78ec8ee` / `0xf4304a14a4f0af7e8578501eb503e0a3e2dd241c3f9f4d55f46c503135b04207` |
| Buy ticket 1 — **relayed** (buyer only signed) | `0xe3bfb9da21ce2e97b02ba8ad12d0abef075aa687417ecbfaaa02e7d765a243f1` |
| Check in ticket 1 — **relayed, dual signature verified on-chain** | `0x250b568bef22de2524398baeeeee230e4a24b7ff4e5c5f0de6da4b7fbd810bf8` |
| Reschedule event 2 (same tickets stay valid) | `0x342cb04ca509017c8c97acdeb2f76aaae3c0808fd28fc6f3bbe6f02766c919b9` |
| Voluntary refund inside the 7-day window | `0x8112f4436e7ccebc3ae2d7ea20e08c94e1bd822b831d1d9283d3765d374e2416` |
| Cancel event 3 → claim full refund | `0x61cf4348a60b96c6c2c397289f26e9dc3ece323670aad6c6b7519dd1f3f1bd83` / `0xed06eeca3bd23bbe3309e4b71e5401a6cc37a05fc5a281b4d37136a3868b62ce` |

Withdraw splitting (99% boss / 1% fee) is covered by the Foundry suite with time travel
(`test_Withdraw_SplitsFeeToFundwallet`) — on the live testnet it unlocks 24h after an
event starts.

## Architecture

```
Buyer ──EIP-3009 signature──► TIMO Relayer ──► buyTicketGasless ──► ERC-721 ticket (on-chain metadata)
Buyer ──approve + buyTicket (fallback)─────► TIMO (escrow per event)
Attendee QR ──► Staff signs ──► TIMO Relayer ──► checkInRelayed (dual-signature, on-chain verified)
Platform ──createEvent / reschedule / cancel (owner only, per organizer's off-chain decision)
Platform ──withdraw at start + 24h ──► 99% BossOrganizer · 1% fundwallet
```

- `contracts/src/TIMOv2.sol` — the product: per-event escrow, immutable price/capacity/
  roles/fee, relayed purchases and check-ins, on-chain NFT metadata, reschedule refund
  window, split settlement. (`TIMO.sol` is the superseded v1.)
- `contracts/test/TIMOv2.t.sol` — 17 tests: role bounds, replay protection, rogue-guard
  and forged-signature rejection, refund windows, fee-split math, cross-event escrow
  accounting. Full suite: 48 unit tests + 3 Aevum fork tests, all passing.
- `contracts/script/DeployTIMOv2.s.sol`, `contracts/script/ProofV2.s.sol` — deployment
  and the live proof flow above.
- `web/` — Next.js app on the official Aevum starter kit: Explore (filters, ticket-stub
  cards), Event Detail (relayed purchase), My Tickets (event → tickets → NFT, dynamic
  QR), Activity, and a role-separated **Organizer Studio** with a camera QR scanner.
  `web/src/app/api/relay-timo/route.ts` is the relayer endpoint (whitelisted functions,
  simulation first, rate limits, daily cap).

### Safety properties

- **Escrow has exactly two exits** — `claimRefund` (to the current ticket owner, exact
  price, once) and `withdraw` (once, fixed split). There is deliberately **no admin
  sweep or emergency drain**, not even for the platform owner.
- Relayer hardening: signed payloads only (amount/recipient/nonce bound by EIP-3009),
  function whitelist, on-chain-state revalidation, per-IP/signer rate limits, in-flight
  guard, daily cap, small gas float.
- Checks-effects-interactions + `ReentrancyGuard` + `SafeERC20` on all fund paths.
- **No unbounded loops anywhere** (pull refunds; role arrays capped at 3 admins / 25
  guards), so gas stays bounded and predictable — no gas explosions.
- Accounting invariant (tested): contract tUSD8 balance == sum of all events'
  un-withdrawn, un-refunded escrow.
- Shanghai EVM only — bytecode is checked with the starter kit's Shanghai checker.

## Deployment governance

- **Tier 1 — Platform (rare, per version):** deploy the contract, configure the fee
  recipient and relayer, point the web app at the new address, repeat proof
  transactions, update this README and the DoraHacks Build page.
- **Tier 2 — Event (routine, per deal):** one `createEvent` transaction on the live
  contract carrying the vetted organizer's data package and role wallets. Every new
  organizer is Tier 2 only; Tier 1 never changes for them.

## Run it locally

Requirements: Node 22+, pnpm, Foundry.

```bash
git clone https://github.com/timoshenry/timo.git && cd timo

# Contract dependencies (not vendored): OpenZeppelin + forge-std
git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts contracts/lib/openzeppelin-contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std

pnpm install
cd contracts && forge test    # 48 unit tests (incl. 17 TIMOv2) — fork tests: forge test --fork-url https://rpc-test.qday.info
cd ..

cp web/.env.example web/.env.local   # set NEXT_PUBLIC_TIMO_AEVUM, NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM, RELAYER_PRIVATE_KEY
pnpm --filter web dev
```

### Environment variables (web)

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_NETWORKS` | `aevum`, `fork`, `local` (comma-separated) |
| `NEXT_PUBLIC_TIMO_AEVUM` / `_FORK` / `_LOCAL` | TIMO contract address per network |
| `NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM` | First block to scan for TIMO events |
| `NEXT_PUBLIC_CHECKOUT_*` | Starter-kit Checkout addresses (kit pages) |
| `RELAYER_PRIVATE_KEY` | TIMO relayer wallet key (server-only; small tQDAY float). Powers gas-free buys and check-ins via `/api/relay-timo` |

## Roadmap

- Tiered tickets (VIP/regular) and seat maps.
- x402 agent purchases with settlement on Aevum.
- Resale price caps / organizer royalties as a per-event option.
- Push notifications for cancellation and reschedules, powered by contract events.

## License & credits

MIT. Built on the MIT-licensed [Aevum starter kit](https://github.com/qday-io/aevum-starter-kit)
by QDay; OpenZeppelin Contracts (MIT) for ERC-721 and security primitives.
