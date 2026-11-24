import { NextResponse } from "next/server";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  parseSignature,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { aevumFork, isAnvilAccount, localAnvil } from "@aevum-kit/aevum";
import { defaultNetwork, networkByChainId, type Network } from "@/lib/env";
import { explain } from "@/lib/errors";
import { timoAbi } from "@/lib/timoAbi";

/**
 * The TIMO relayer. Buyers and door staff only sign; this route submits
 * TIMOv2.buyTicketGasless / TIMOv2.checkInRelayed and pays the gas from RELAYER_PRIVATE_KEY.
 *
 * Anyone on the internet can call this route, and every transaction it sends costs gas.
 * The rails, in the order they run:
 *  1. Only the configured TIMO contract, only those two functions. Never arbitrary calls.
 *  2. Buys: the EIP-3009 authorization binds payer, amount (the event's immutable price),
 *     recipient (the TIMO contract) and a one-time nonce — the relayer cannot alter any of it.
 *  3. Check-ins: both signatures are verified by the contract itself (owner + staff role).
 *  4. Simulated first, so a bad or expired signature costs nothing.
 *  5. Rate limits per IP and per signer, an in-flight guard, and a daily transaction cap.
 *
 * The limits live in this process's memory; on serverless each instance has its own copy.
 * Keep only a small tQDAY float in the relayer wallet.
 */
export const runtime = "nodejs";

const MAX_WINDOW_SECONDS = 3600n;
const PER_IP_PER_MINUTE = 20;
const PER_SIGNER_PER_MINUTE = 6;
const DAILY_TX_LIMIT = Number(process.env.RELAYER_DAILY_TX_LIMIT ?? 500);
const IN_FLIGHT_MS = 120_000;
const LOCAL_CHAINS = new Set<number>([localAnvil.id, aevumFork.id]);

let cachedAccount: PrivateKeyAccount | null | undefined;
function relayer(): PrivateKeyAccount | undefined {
  if (cachedAccount !== undefined) return cachedAccount ?? undefined;
  const raw = process.env.RELAYER_PRIVATE_KEY?.trim();
  const key = (raw?.startsWith("0x") ? raw : `0x${raw ?? ""}`) as Hex;
  cachedAccount = raw && isHex(key) && key.length === 66 ? privateKeyToAccount(key, { nonceManager }) : null;
  return cachedAccount ?? undefined;
}

function usable(account: PrivateKeyAccount | undefined, net: Network): PrivateKeyAccount | undefined {
  if (!account) return undefined;
  if (isAnvilAccount(account.address) && !LOCAL_CHAINS.has(net.chain.id)) return undefined;
  return account;
}

const hits = new Map<string, number[]>();
function limited(bucket: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(bucket, recent);
  if (hits.size > 10_000) {
    for (const [k, times] of hits) if (times.every((t) => now - t >= 60_000)) hits.delete(k);
  }
  return recent.length > max;
}

let day = "";
let sentToday = 0;
function overDailyLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
  }
  return sentToday >= DAILY_TX_LIMIT;
}

const inFlight = new Map<string, number>();
function claimInFlight(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of inFlight) if (now - t > IN_FLIGHT_MS) inFlight.delete(k);
  if (inFlight.has(key)) return false;
  inFlight.set(key, now);
  return true;
}

function clientIp(req: Request): string {
  const trusted = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) return req.headers.get(trusted)?.split(",")[0]?.trim() || "unknown";
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
const isSig = (v: unknown): v is Hex => typeof v === "string" && isHex(v) && v.length === 132;
const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

function networkFor(chainId: unknown): Network | undefined {
  if (chainId === undefined || chainId === null || chainId === "") return defaultNetwork;
  return networkByChainId(Number(chainId));
}

/** GET /api/relay-timo?chainId=… tells the app whether relayed mode is available. */
export async function GET(req: Request) {
  const net = networkFor(new URL(req.url).searchParams.get("chainId"));
  const account = net ? usable(relayer(), net) : undefined;
  return NextResponse.json({ enabled: Boolean(account && net?.timo), relayer: account?.address ?? null });
}

export async function POST(req: Request) {
  if (limited(`ip:${clientIp(req)}`, PER_IP_PER_MINUTE)) return fail("Too many requests. Wait a minute.", 429);
  if (overDailyLimit()) return fail("The relayer reached its daily limit. Try the standard flow.", 503);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body.");
  }

  const net = networkFor(body.chainId);
  if (!net?.timo) return fail("TIMO is not configured on this network.", 404);
  const account = usable(relayer(), net);
  if (!account) return fail("Relayer is not available.", 503);

  const pub = createPublicClient({ chain: net.chain, transport: http() });
  const wallet = createWalletClient({ account, chain: net.chain, transport: http() });
  const timo = net.timo;

  try {
    if (body.kind === "buy") {
      const { eventId, from, validAfter, validBefore, signature } = body;
      if (!isUint(eventId) || typeof from !== "string" || !isAddress(from)) return fail("Bad buy request.");
      if (!isUint(validAfter) || !isUint(validBefore) || !isSig(signature)) return fail("Bad authorization.");
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (BigInt(validBefore) <= now || BigInt(validBefore) - now > MAX_WINDOW_SECONDS) {
        return fail("Authorization window is invalid or too long.");
      }
      if (limited(`signer:${from.toLowerCase()}`, PER_SIGNER_PER_MINUTE)) return fail("Too many relays for this wallet.", 429);
      const flightKey = `buy:${eventId}:${from.toLowerCase()}:${validBefore}`;
      if (!claimInFlight(flightKey)) return fail("This purchase is already being submitted.", 409);
      const { v, r, s } = parseSignature(signature);
      const args = [BigInt(eventId), from, BigInt(validAfter), BigInt(validBefore), Number(v), r, s] as const;
      await pub.simulateContract({ address: timo, abi: timoAbi, functionName: "buyTicketGasless", args, account: account.address });
      const hash = await wallet.writeContract({ address: timo, abi: timoAbi, functionName: "buyTicketGasless", args });
      sentToday++;
      return NextResponse.json({ hash });
    }

    if (body.kind === "checkin") {
      const { tokenId, expiry, ownerSignature, staffSignature } = body;
      if (!isUint(tokenId) || typeof expiry !== "number" || !Number.isFinite(expiry)) return fail("Bad check-in request.");
      if (!isSig(ownerSignature) || !isSig(staffSignature)) return fail("Bad signatures.");
      const now = Math.floor(Date.now() / 1000);
      if (expiry <= now || expiry > now + 60) return fail("Check-in signatures must be fresh (60 seconds).");
      if (!claimInFlight(`checkin:${tokenId}`)) return fail("This check-in is already being submitted.", 409);
      const args = [BigInt(tokenId), BigInt(expiry), ownerSignature, staffSignature] as const;
      await pub.simulateContract({ address: timo, abi: timoAbi, functionName: "checkInRelayed", args, account: account.address });
      const hash = await wallet.writeContract({ address: timo, abi: timoAbi, functionName: "checkInRelayed", args });
      sentToday++;
      return NextResponse.json({ hash });
    }

    return fail("Unknown relay kind.");
  } catch (e) {
    if (e instanceof BaseError) return fail(explain(e), 422);
    return fail("Relay failed.", 500);
  }
}
