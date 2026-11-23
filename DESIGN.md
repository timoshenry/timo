# TIMO — Contract Design

**TIMO — Ticket & Invoice Management Onchain**

Submission for Aevum Builder Challenge #1 · Aevum testnet (chain 44005) · token tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483` (6 decimals)

> All submission-facing material (README, docs, UI copy, demo script, DoraHacks page) is written in English.

## Concept

Buyers pay for event tickets in tUSD8. Funds do **not** go straight to the organizer — the contract holds them in escrow. The ticket is issued as an ERC-721. If the event is cancelled, every ticket owner claims a full refund. If the event completes, the organizer withdraws the escrow and check-ins are recorded onchain.

The purchase doubles as the payment invoice: `TicketPurchased` is the onchain receipt tying event, buyer, and exact amount.

## Actors

- **Organizer**: creates events, cancels, checks in attendees, withdraws after completion.
- **Buyer / ticket owner**: buys, transfers (resale), claims refund on cancellation.
- **Relayer** (optional, gasless mode): submits the buyer's EIP-3009 signature, pays gas.

## Event lifecycle

```
Open ──(organizer cancels, before start)──► Cancelled ──► per-ticket refunds (pull)
  │
  └──(event time + grace period passes)──► Completed ──► organizer withdraws once
```

Rules:
- Cancellation only before `startsAt` and before withdrawal.
- Withdrawal only after `startsAt + 24 hours`, event not cancelled, exactly once.
- Refunds never expire while funds remain in escrow.

## Core data

```solidity
enum EventStatus { Open, Cancelled, Completed }

struct EventInfo {
    address organizer;
    uint256 price;        // tUSD8, 6 decimals
    uint32  capacity;
    uint32  sold;
    uint64  salesEnd;
    uint64  startsAt;
    EventStatus status;
    bool    withdrawn;
    string  metadataURI;  // name, description, image (IPFS/HTTPS)
}

struct TicketInfo {
    uint256 eventId;
    bool checkedIn;
    bool refunded;
}
```

Tickets are ERC-721 minted by `TIMO` itself (single contract, no separate NFT dependency). `tokenId` is globally unique; `TicketInfo` maps ticket → event.

## Core functions

| Function | Caller | Behavior |
|---|---|---|
| `createEvent(price, capacity, salesEnd, startsAt, metadataURI)` | anyone | Creates an `Open` event; requires `salesEnd < startsAt`, price & capacity > 0 |
| `buyTicket(eventId)` | buyer | `transferFrom` of exactly `price` into escrow, mints 1 NFT to the buyer. Requires prior approve |
| `buyTicketGasless(eventId, auth, v, r, s)` | relayer | Single EIP-3009 `receiveWithAuthorization` signature; nonce bound to `keccak256(eventId, buyer, randomNonce)` so it cannot be replayed for another event (starter-kit Checkout pattern) |
| `cancelEvent(eventId)` | organizer | Status → `Cancelled`; sales stop |
| `claimRefund(tokenId)` | ticket owner | Only when `Cancelled`; burns the NFT, returns full `price` to the current owner |
| `checkIn(tokenId)` | organizer | Only at/after `startsAt`; marks `checkedIn`; ticket becomes locked (no transfer, no refund) |
| `withdraw(eventId)` | organizer | After `startsAt + 24 hours`, not cancelled; sends the event's full escrow once |
| `transferFrom(...)` (ERC-721) | ticket owner | Free while not checked in and not refunded — resale is supported; refunds always go to the latest owner |

## Events (receipts & audit)

`EventCreated`, `TicketPurchased(eventId, tokenId, buyer, price)`, `EventCancelled`, `RefundClaimed(tokenId, owner, amount)`, `CheckedIn(tokenId)`, `Withdrawn(eventId, organizer, amount)`.

## Invariants & security

- `sold <= capacity` at all times; one ticket = one payment of exactly `price` (under/overpayment reverts).
- Per-event accounting: escrow of an event = `sold * price − refunds − withdrawal`.
- Checks-effects-interactions + `ReentrancyGuard` on every fund-moving function.
- Refunds are *pull* (claimed per ticket), never a push loop — safe for large events, gas-efficient.
- No admin/pauser functions; the organizer cannot touch escrow of a cancelled event.
- **Shanghai** EVM only (no Cancun opcodes); contract verified via README + exact commit link (explorer verification is not available yet).

## Check-in (anti double-entry)

No static barcodes — screenshots can be shared. Instead:

1. The "My Tickets" app creates a **dynamic QR**: payload `tokenId + 60-second expiry`, **signed by the owner's wallet** (EIP-191, gas-free).
2. The organizer's scanner verifies off-chain: signer == `ownerOf(tokenId)`, not expired, not yet checked in.
3. On success the organizer calls `checkIn(tokenId)`; that transaction locks the ticket permanently.
4. Proof of ownership stays in the wallet; the QR only shows a momentary signature.

## Transfer policy (Kay's decision, 24 Nov 2026)

**Free transfer — resale allowed.** Standard ERC-721, transferable before check-in. Accepted consequences:

- Refunds always go to the current owner (follows `ownerOf` automatically).
- Check-in stays safe: the QR signature is made by the *current* owner.
- Resale pricing is not enforced by the contract in v1 (sales happen externally / on marketplaces); noted as roadmap.

## Out of scope for v1

Platform fees, resale royalties, tiered tickets (VIP/regular), seat maps, partial payments. Listed as roadmap in the README.

## Web app plan

1. **Explore events** — list `Open` events from onchain events.
2. **Event detail** — buy ticket (standard/gasless), transparent escrow status.
3. **My Tickets** — owned NFTs, check-in QR, refund claim button when cancelled.
4. **Organizer dashboard** — create event, cancel, check-in scanner, withdraw.

## Required tests (Foundry)

- Successful purchase + mint; purchase when sold out / sales closed → revert.
- Wrong amount → revert. Gasless purchase: wrong/replayed nonce → revert.
- Cancel by non-organizer → revert; refund by rightful owner; double refund → revert.
- Early withdrawal / withdrawal on cancelled event → revert; double withdrawal → revert.
- Double check-in → revert; transfer after check-in → revert.
- Fork tests against the real tUSD8 (starter-kit pattern).

## Build order

1. Contract + unit tests (Foundry, based on the official starter kit).
2. Local fork deployment → full flow test.
3. Minimal web UI, 4 pages.
4. Aevum testnet deployment + proof transactions.
5. README, demo, DoraHacks submission before 11 Dec 2026, 15:00 WIB (internal target: 9 Dec).
