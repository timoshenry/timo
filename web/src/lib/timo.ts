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

/** Display metadata carried in the event's metadataURI document (JSON, URL, or data URI). */
export interface EventMeta {
  venue: string;
  description: string;
  link: string;
}

export interface TimoEvent {
  id: bigint;
  /** BossOrganizer: event owner and sole payout recipient (not an operator). */
  boss: Address;
  price: bigint;
  escrow: bigint;
  capacity: number;
  sold: number;
  /** Service fee in basis points (100 = 1%), fixed at creation. */
  feeBps: number;
  salesEnd: bigint;
  checkInOpensAt: bigint;
  startsAt: bigint;
  /** End of the voluntary refund window opened by a reschedule; 0 = none. */
  refundWindowUntil: bigint;
  /** 0 = Open, 1 = Cancelled, 2 = Completed (mirrors the contract enum). */
  status: number;
  statusLabel: EventStatusLabel;
  withdrawn: boolean;
  name: string;
  imageUrl: string;
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

/** eventOf returns a struct; viem exposes it with both positional and named fields. Read defensively.
 *  Struct order: boss, price, escrow, capacity, sold, feeBps, salesEnd, checkInOpensAt, startsAt,
 *  refundWindowUntil, status, withdrawn, name, imageUrl, metadataURI. */
function toTimoEvent(id: bigint, raw: any): TimoEvent {
  const status = Number(raw.status ?? raw[10] ?? 0);
  return {
    id,
    boss: (raw.boss ?? raw[0]) as Address,
    price: BigInt(raw.price ?? raw[1]),
    escrow: BigInt(raw.escrow ?? raw[2]),
    capacity: Number(raw.capacity ?? raw[3]),
    sold: Number(raw.sold ?? raw[4]),
    feeBps: Number(raw.feeBps ?? raw[5]),
    salesEnd: BigInt(raw.salesEnd ?? raw[6]),
    checkInOpensAt: BigInt(raw.checkInOpensAt ?? raw[7]),
    startsAt: BigInt(raw.startsAt ?? raw[8]),
    refundWindowUntil: BigInt(raw.refundWindowUntil ?? raw[9] ?? 0),
    status,
    statusLabel: EVENT_STATUS_LABELS[status] ?? "Open",
    withdrawn: Boolean(raw.withdrawn ?? raw[11]),
    name: String(raw.name ?? raw[12] ?? ""),
    imageUrl: String(raw.imageUrl ?? raw[13] ?? ""),
    metadataURI: String(raw.metadataURI ?? raw[14] ?? ""),
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

/** 0 = no role, 1 = AdminOrganizer, 2 = GuardOrganizer for `account` at `eventId`. */
export async function readRole(client: PublicClient, timo: Address, eventId: bigint, account: Address): Promise<number> {
  const raw = await client.readContract({ address: timo, abi: timoAbi, functionName: "roleOf", args: [eventId, account] });
  return Number(raw);
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
 * plus ERC-721 Transfer logs where it received a ticket, then confirmed with ownerOf — a ticket
 * that was transferred away or refunded (burned) drops out.
 */
export async function fetchMyTickets(client: PublicClient, timo: Address, owner: Address, deployBlock?: bigint): Promise<TimoTicket[]> {
  const head = await client.getBlockNumber();
  const fromBlock = scanFromBlock(head, deployBlock);
  const buyLogs = await getLogsChunked(client, {
    address: timo,
    event: getAbiItem({ abi: timoAbi, name: "TicketPurchased" }),
    args: { buyer: owner },
    fromBlock,
    toBlock: head,
  });
  const inLogs = await getLogsChunked(client, {
    address: timo,
    event: getAbiItem({ abi: timoAbi, name: "Transfer" }),
    args: { to: owner },
    fromBlock,
    toBlock: head,
  });
  const tokenIds = [
    ...new Set([
      ...buyLogs.map((l) => (l.args as any).tokenId as bigint),
      ...inLogs.map((l) => (l.args as any).tokenId as bigint),
    ]),
  ];
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

/** Parse the event's metadataURI into venue/description/link. Accepts raw JSON, a data URI, or an http(s)/ipfs URL. */
export async function resolveEventMeta(ev: TimoEvent): Promise<EventMeta> {
  const empty: EventMeta = { venue: "", description: "", link: "" };
  const uri = ev.metadataURI.trim();
  if (!uri) return empty;
  const pick = (d: any): EventMeta => ({
    venue: typeof d?.venue === "string" ? d.venue : "",
    description: typeof d?.description === "string" ? d.description : "",
    link: typeof d?.link === "string" ? d.link : "",
  });
  try {
    if (uri.startsWith("{")) return pick(JSON.parse(uri));
    if (uri.startsWith("data:application/json;base64,")) {
      return pick(JSON.parse(atob(uri.slice("data:application/json;base64,".length))));
    }
    if (/^(https?:\/\/|ipfs:\/\/)/i.test(uri)) {
      const url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}` : uri;
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return pick(await res.json());
    }
  } catch {
    // Fall through to empty metadata.
  }
  return empty;
}

/** Decode the on-chain base64 tokenURI into its NFT metadata. */
export async function readTicketNft(client: PublicClient, timo: Address, tokenId: bigint): Promise<{ name: string; image: string; status: string } | null> {
  try {
    const uri = (await client.readContract({ address: timo, abi: timoAbi, functionName: "tokenURI", args: [tokenId] })) as string;
    const json = JSON.parse(atob(uri.split(",")[1])) as any;
    const statusAttr = (json.attributes as any[] | undefined)?.find((a) => a.trait_type === "Status");
    return { name: String(json.name ?? ""), image: String(json.image ?? ""), status: String(statusAttr?.value ?? "") };
  } catch {
    return null;
  }
}

/** Whether tickets on this event can currently be refunded (cancelled, or inside the reschedule window). */
export function isRefundable(ev: TimoEvent, nowSeconds: number): boolean {
  if (ev.withdrawn) return false;
  if (ev.status === 1) return true;
  return ev.refundWindowUntil > 0n && BigInt(Math.floor(nowSeconds)) <= ev.refundWindowUntil;
}

export function formatDateTime(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- Check-in payloads (dynamic QR) ---------- */

/** How long a signed check-in payload stays valid, in seconds (the contract enforces <= 60). */
export const CHECK_IN_TTL_SECONDS = 60;

/** The canonical message the ticket owner's wallet signs with personal_sign. Must match TIMOv2.checkInMessage. */
export function checkInMessage(tokenId: bigint, expiry: number): string {
  return `TIMO check-in\nToken: ${tokenId.toString()}\nExpires: ${expiry}`;
}

/** The canonical message a staff wallet signs to authorize a relayed check-in. Must match TIMOv2.staffCheckInMessage. */
export function staffCheckInMessage(tokenId: bigint, expiry: number): string {
  return `TIMO staff check-in\nToken: ${tokenId.toString()}\nExpires: ${expiry}`;
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
