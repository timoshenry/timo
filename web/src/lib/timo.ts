import { getLogsChunked } from "@aevum-kit/aevum";
import { formatUnits, getAbiItem, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { timoAbi } from "./timoAbi";

export { timoAbi };

/** tUSD8 always has 6 decimals, on Aevum and on the local MockUSD8. */
export const TUSD8_DECIMALS = 6;

export function formatTUSD8(value: bigint): string {
  return formatUnits(value, TUSD8_DECIMALS);
}

/** Parse a user-typed tUSD8 amount like "2.50" into base units. Throws on invalid input. */
export function parseTUSD8(text: string): bigint {
  return parseUnits(text.trim(), TUSD8_DECIMALS);
}

export const EVENT_STATUS_LABELS = ["Open", "Cancelled", "Completed"] as const;
export type EventStatusLabel = (typeof EVENT_STATUS_LABELS)[number];

export interface TimoEvent {
  id: bigint;
  organizer: Address;
  price: bigint;
  escrow: bigint;
  capacity: number;
  sold: number;
  salesEnd: bigint;
  startsAt: bigint;
  /** 0 = Open, 1 = Cancelled, 2 = Completed (mirrors the contract enum). */
  status: number;
  statusLabel: EventStatusLabel;
  withdrawn: boolean;
  metadataURI: string;
}

export interface TimoTicket {
  tokenId: bigint;
  eventId: bigint;
  checkedIn: boolean;
  refunded: boolean;
  event: TimoEvent;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** eventOf returns a struct; viem exposes it with both positional and named fields. Read defensively. */
function toTimoEvent(id: bigint, raw: any): TimoEvent {
  const status = Number(raw.status ?? raw[7] ?? 0);
  return {
    id,
    organizer: (raw.organizer ?? raw[0]) as Address,
    price: BigInt(raw.price ?? raw[1]),
    escrow: BigInt(raw.escrow ?? raw[2]),
    capacity: Number(raw.capacity ?? raw[3]),
    sold: Number(raw.sold ?? raw[4]),
    salesEnd: BigInt(raw.salesEnd ?? raw[5]),
    startsAt: BigInt(raw.startsAt ?? raw[6]),
    status,
    statusLabel: EVENT_STATUS_LABELS[status] ?? "Open",
    withdrawn: Boolean(raw.withdrawn ?? raw[8]),
    metadataURI: String(raw.metadataURI ?? raw[9] ?? ""),
  };
}

export async function readEvent(client: PublicClient, timo: Address, eventId: bigint): Promise<TimoEvent> {
  const raw = await client.readContract({ address: timo, abi: timoAbi, functionName: "eventOf", args: [eventId] });
  return toTimoEvent(eventId, raw as any);
}

export async function readTicket(client: PublicClient, timo: Address, tokenId: bigint): Promise<{ eventId: bigint; checkedIn: boolean; refunded: boolean }> {
  const raw = (await client.readContract({ address: timo, abi: timoAbi, functionName: "ticketOf", args: [tokenId] })) as any;
  return {
    eventId: BigInt(raw.eventId ?? raw[0]),
    checkedIn: Boolean(raw.checkedIn ?? raw[1]),
    refunded: Boolean(raw.refunded ?? raw[2]),
  };
}

/**
 * Where event scanning starts. Aevum serves at most 1,000 blocks per eth_getLogs call, and a full
 * scan from block 0 is impractical on the real testnet, so without a known deploy block we scan
 * the most recent blocks. Set NEXT_PUBLIC_DEPLOY_BLOCK_* for an exact range.
 */
export function scanFromBlock(head: bigint, deployBlock?: bigint): bigint {
  if (deployBlock !== undefined) return deployBlock;
  const WINDOW = 50_000n;
  return head > WINDOW ? head - WINDOW + 1n : 0n;
}

/** All events created on this TIMO contract, oldest first, with their current on-chain state. */
export async function fetchEvents(client: PublicClient, timo: Address, deployBlock?: bigint): Promise<TimoEvent[]> {
  const head = await client.getBlockNumber();
  const logs = await getLogsChunked(client, {
    address: timo,
    event: getAbiItem({ abi: timoAbi, name: "EventCreated" }),
    fromBlock: scanFromBlock(head, deployBlock),
    toBlock: head,
  });
  const ids = [...new Set(logs.map((l) => (l.args as any).eventId as bigint))];
  const events: TimoEvent[] = [];
  for (const id of ids) events.push(await readEvent(client, timo, id));
  return events;
}

/**
 * Tickets the wallet currently owns. Found from TicketPurchased logs where it was the buyer,
 * then confirmed with ownerOf — a ticket that was resold or refunded (burned) drops out.
 */
export async function fetchMyTickets(client: PublicClient, timo: Address, owner: Address, deployBlock?: bigint): Promise<TimoTicket[]> {
  const head = await client.getBlockNumber();
  const logs = await getLogsChunked(client, {
    address: timo,
    event: getAbiItem({ abi: timoAbi, name: "TicketPurchased" }),
    args: { buyer: owner },
    fromBlock: scanFromBlock(head, deployBlock),
    toBlock: head,
  });
  const tokenIds = [...new Set(logs.map((l) => (l.args as any).tokenId as bigint))];
  const tickets: TimoTicket[] = [];
  for (const tokenId of tokenIds) {
    try {
      const current = (await client.readContract({ address: timo, abi: timoAbi, functionName: "ownerOf", args: [tokenId] })) as Address;
      if (current.toLowerCase() !== owner.toLowerCase()) continue;
      const t = await readTicket(client, timo, tokenId);
      tickets.push({ tokenId, ...t, event: await readEvent(client, timo, t.eventId) });
    } catch {
      // Burned (refunded) or otherwise unreadable ticket: skip it.
    }
  }
  return tickets;
}

/**
 * Display title for an event. A plain-string metadataURI *is* the title (that is what the
 * Organizer form stores). An http(s)/ipfs URI is fetched and its JSON `name`/`title` used;
 * anything that fails falls back to "Event #<id>".
 */
export async function resolveEventTitle(metadataURI: string, eventId: bigint): Promise<string> {
  const fallback = `Event #${eventId.toString()}`;
  const uri = metadataURI.trim();
  if (!uri) return fallback;
  if (/^(https?:\/\/|ipfs:\/\/)/i.test(uri)) {
    try {
      const url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}` : uri;
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return fallback;
      const data = (await res.json()) as { name?: unknown; title?: unknown };
      const name = typeof data.name === "string" ? data.name : typeof data.title === "string" ? data.title : "";
      return name.trim() || fallback;
    } catch {
      return fallback;
    }
  }
  return uri;
}

export function formatDateTime(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- Check-in payloads (dynamic QR) ---------- */

/** How long a signed check-in payload stays valid, in seconds. */
export const CHECK_IN_TTL_SECONDS = 90;

/** The canonical message the ticket owner's wallet signs with personal_sign. */
export function checkInMessage(tokenId: bigint, expiry: number): string {
  return `TIMO check-in\nToken: ${tokenId.toString()}\nExpires: ${expiry}`;
}

export interface CheckInPayload {
  tokenId: string;
  expiry: number;
  message: string;
  signature: Hex;
}

export function encodeCheckInPayload(tokenId: bigint, expiry: number, signature: Hex): string {
  const payload: CheckInPayload = { tokenId: tokenId.toString(), expiry, message: checkInMessage(tokenId, expiry), signature };
  return JSON.stringify(payload);
}

/** Parse a pasted/scanned payload. Returns null unless every field is present and the message is the canonical one for its tokenId + expiry. */
export function parseCheckInPayload(raw: string): CheckInPayload | null {
  try {
    const p = JSON.parse(raw) as Partial<CheckInPayload>;
    if (typeof p.tokenId !== "string" || !/^\d+$/.test(p.tokenId)) return null;
    if (typeof p.expiry !== "number" || !Number.isFinite(p.expiry)) return null;
    if (typeof p.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(p.signature)) return null;
    if (p.message !== checkInMessage(BigInt(p.tokenId), p.expiry)) return null;
    return p as CheckInPayload;
  } catch {
    return null;
  }
}
