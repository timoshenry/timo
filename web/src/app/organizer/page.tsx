"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { recoverMessageAddress, type Address, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import {
  fetchEvents,
  formatDateTime,
  formatTUSD8,
  parseCheckInPayload,
  parseTUSD8,
  readTicket,
  resolveEventTitle,
  timoAbi,
  type TimoEvent,
} from "@/lib/timo";

const WITHDRAW_DELAY_SECONDS = 24 * 60 * 60;

function EventTitle({ event }: { event: TimoEvent }) {
  const title = useQuery({
    queryKey: ["timo-title", event.id.toString(), event.metadataURI],
    queryFn: () => resolveEventTitle(event.metadataURI, event.id),
    staleTime: 60_000,
  });
  return <>{title.data ?? `Event #${event.id.toString()}`}</>;
}

function CreateEventForm({ onCreated }: { onCreated: () => void }) {
  const { net } = useNetwork();
  const timo = net.timo;
  const config = useConfig();
  const { address } = useAccount();
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [capacity, setCapacity] = useState("");
  const [salesEnd, setSalesEnd] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!address || !timo) return;
    setError(null);
    setDone(false);
    try {
      const priceUnits = parseTUSD8(price);
      const cap = Number(capacity);
      const salesEndTs = Math.floor(new Date(salesEnd).getTime() / 1000);
      const startsAtTs = Math.floor(new Date(startsAt).getTime() / 1000);
      if (!title.trim()) throw new Error("Give the event a title.");
      if (priceUnits <= 0n) throw new Error("Price must be more than 0 tUSD8.");
      if (!Number.isInteger(cap) || cap <= 0) throw new Error("Capacity must be a whole number above 0.");
      if (!Number.isFinite(salesEndTs) || !Number.isFinite(startsAtTs)) throw new Error("Pick both dates.");
      if (salesEndTs >= startsAtTs) throw new Error("Sales must end before the event starts.");
      if (startsAtTs <= Math.floor(Date.now() / 1000)) throw new Error("The event must start in the future.");
      setBusy(true);
      const { request } = await simulateContract(config, {
        account: address,
        address: timo,
        abi: timoAbi,
        functionName: "createEvent",
        args: [priceUnits, cap, BigInt(salesEndTs), BigInt(startsAtTs), title.trim()],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. The event was not created.");
      setDone(true);
      setTitle("");
      setPrice("");
      setCapacity("");
      setSalesEnd("");
      setStartsAt("");
      onCreated();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label="Create event" style={{ gap: 14 }}>
      <h2>Create an event</h2>
      <label className="stack" style={{ gap: 6 }}>
        <span className="fine">Event title</span>
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Aevum Builders Meetup" required />
      </label>
      <div className="row" style={{ gap: 14 }}>
        <label className="stack" style={{ gap: 6, flex: "1 1 160px" }}>
          <span className="fine">Ticket price (tUSD8)</span>
          <input className="field" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="2.50" inputMode="decimal" required />
        </label>
        <label className="stack" style={{ gap: 6, flex: "1 1 160px" }}>
          <span className="fine">Capacity</span>
          <input className="field" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="100" inputMode="numeric" required />
        </label>
      </div>
      <div className="row" style={{ gap: 14 }}>
        <label className="stack" style={{ gap: 6, flex: "1 1 200px" }}>
          <span className="fine">Sales end</span>
          <input className="field" type="datetime-local" value={salesEnd} onChange={(e) => setSalesEnd(e.target.value)} required />
        </label>
        <label className="stack" style={{ gap: 6, flex: "1 1 200px" }}>
          <span className="fine">Event starts</span>
          <input className="field" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </label>
      </div>
      {error && (
        <div className="notice bad" role="alert">
          <span>{error}</span>
        </div>
      )}
      {done && (
        <div className="notice good" role="status">
          <strong>Event created</strong>
          <span>It now appears in Explore and in your events below.</span>
        </div>
      )}
      <button type="submit" className="btn big block" disabled={busy || !timo}>
        {busy ? "Check your wallet…" : "Create event"}
      </button>
      <p className="fine">Ticket payments are held in escrow by the contract. You can withdraw only 24 hours after the event starts, and only if you don&apos;t cancel.</p>
    </form>
  );
}

function OrganizerEventRow({ event, onChanged }: { event: TimoEvent; onChanged: () => void }) {
  const { net } = useNetwork();
  const timo = net.timo;
  const config = useConfig();
  const { address } = useAccount();
  const [busy, setBusy] = useState<"cancel" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Math.floor(Date.now() / 1000);
  const canCancel = event.status === 0 && now < Number(event.startsAt);
  const canWithdraw = event.status === 0 && !event.withdrawn && now >= Number(event.startsAt) + WITHDRAW_DELAY_SECONDS;

  async function act(fn: "cancelEvent" | "withdraw") {
    if (!address || !timo) return;
    setError(null);
    setBusy(fn === "cancelEvent" ? "cancel" : "withdraw");
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: timo,
        abi: timoAbi,
        functionName: fn,
        args: [event.id],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
      onChanged();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card stack" style={{ gap: 12 }}>
      <div className="check-top" style={{ alignItems: "baseline" }}>
        <h2>
          <EventTitle event={event} />
        </h2>
        <span className={`status-pill ${event.status === 0 ? "good" : "warn"}`}>{event.statusLabel}</span>
      </div>
      <dl className="kv">
        <dt>Price</dt>
        <dd>{formatTUSD8(event.price)} tUSD8</dd>
        <dt>Sold</dt>
        <dd>
          {event.sold} / {event.capacity}
        </dd>
        <dt>Escrow</dt>
        <dd>{formatTUSD8(event.escrow)} tUSD8</dd>
        <dt>Starts</dt>
        <dd>{formatDateTime(event.startsAt)}</dd>
        <dt>Withdrawable</dt>
        <dd>{formatDateTime(event.startsAt + BigInt(WITHDRAW_DELAY_SECONDS))}</dd>
      </dl>
      <div className="row" style={{ gap: 10 }}>
        <button type="button" className="btn warn" disabled={!canCancel || busy !== null} onClick={() => act("cancelEvent")}>
          {busy === "cancel" ? "Check your wallet…" : "Cancel event"}
        </button>
        <button type="button" className="btn" disabled={!canWithdraw || busy !== null} onClick={() => act("withdraw")}>
          {busy === "withdraw" ? "Check your wallet…" : `Withdraw ${formatTUSD8(event.escrow)} tUSD8`}
        </button>
      </div>
      {!canCancel && event.status === 0 && <p className="fine">Cancellation closes once the event starts. Cancelling makes every ticket refundable from escrow.</p>}
      {!canWithdraw && event.status === 0 && <p className="fine">Withdrawal unlocks 24 hours after the event starts.</p>}
      {error && (
        <div className="notice bad" role="alert">
          <span>{error}</span>
        </div>
      )}
    </article>
  );
}

interface Verification {
  ok: boolean;
  detail: string;
  tokenId: bigint;
}

function CheckInPanel() {
  const { net } = useNetwork();
  const timo = net.timo;
  const config = useConfig();
  const { address } = useAccount();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<Verification | null>(null);
  const [busy, setBusy] = useState<"verify" | "checkin" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function verify() {
    if (!client || !timo) return;
    setError(null);
    setDone(false);
    setResult(null);
    const payload = parseCheckInPayload(raw.trim());
    if (!payload) {
      setResult({ ok: false, detail: "That doesn't look like a TIMO check-in payload. Ask the attendee to show a fresh QR and copy its full contents.", tokenId: 0n });
      return;
    }
    setBusy("verify");
    try {
      const tokenId = BigInt(payload.tokenId);
      const now = Math.floor(Date.now() / 1000);
      if (payload.expiry < now) {
        setResult({ ok: false, detail: "This payload has expired. Ask the attendee to generate a fresh QR.", tokenId });
        return;
      }
      const signer = await recoverMessageAddress({ message: payload.message, signature: payload.signature });
      const owner = (await readContract(config, { address: timo, abi: timoAbi, functionName: "ownerOf", args: [tokenId], chainId: net.chain.id })) as Address;
      if (signer.toLowerCase() !== owner.toLowerCase()) {
        setResult({ ok: false, detail: `Signed by ${signer}, but ticket #${tokenId.toString()} is owned by ${owner}. Do not admit.`, tokenId });
        return;
      }
      const t = await readTicket(client, timo, tokenId);
      if (t.checkedIn) {
        setResult({ ok: false, detail: `Ticket #${tokenId.toString()} was already checked in. Do not admit twice.`, tokenId });
        return;
      }
      setResult({ ok: true, detail: `Valid: ticket #${tokenId.toString()} is owned by the signer (${owner}) and has not been checked in.`, tokenId });
    } catch (e) {
      setResult({ ok: false, detail: `Verification failed: ${explain(e)}`, tokenId: 0n });
    } finally {
      setBusy(null);
    }
  }

  async function checkIn() {
    if (!address || !timo || !result?.ok) return;
    setError(null);
    setBusy("checkin");
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: timo,
        abi: timoAbi,
        functionName: "checkIn",
        args: [result.tokenId],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. The ticket was not checked in.");
      setDone(true);
      setResult(null);
      setRaw("");
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack" aria-label="Check-in" style={{ gap: 14 }}>
      <h2>Door check-in</h2>
      <p className="sub">Paste the contents of an attendee&apos;s check-in QR. We verify the signature recovers to the ticket&apos;s on-chain owner and that the payload hasn&apos;t expired, before anything is written on-chain.</p>
      <textarea
        className="field"
        rows={5}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder='{"tokenId":"1","expiry":…,"message":"…","signature":"0x…"}'
        style={{ fontFamily: "var(--font-mono)", resize: "vertical" }}
      />
      <div className="row" style={{ gap: 10 }}>
        <button type="button" className="btn secondary" disabled={!raw.trim() || busy !== null} onClick={verify}>
          {busy === "verify" ? "Verifying…" : "Verify payload"}
        </button>
        <button type="button" className="btn" disabled={!result?.ok || busy !== null} onClick={checkIn}>
          {busy === "checkin" ? "Check your wallet…" : "Check in ticket"}
        </button>
      </div>
      {result && (
        <div className={`notice ${result.ok ? "good" : "bad"}`} role="status">
          <span>{result.detail}</span>
        </div>
      )}
      {done && (
        <div className="notice good" role="status">
          <strong>Checked in</strong>
          <span>The ticket is now locked on-chain and cannot be reused or transferred.</span>
        </div>
      )}
      {error && (
        <div className="notice bad" role="alert">
          <span>{error}</span>
        </div>
      )}
      <p className="fine">Check-in is only possible at or after the event&apos;s start time, and only from the organizer&apos;s wallet.</p>
    </section>
  );
}

export default function OrganizerPage() {
  const { net } = useNetwork();
  const timo = net.timo;
  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;

  const events = useQuery({
    queryKey: ["timo-events", net.chain.id, timo],
    enabled: Boolean(client && timo),
    queryFn: () => fetchEvents(client!, timo!, net.deployBlock),
  });
  const mine = (events.data ?? []).filter((e) => address && e.organizer.toLowerCase() === address.toLowerCase());

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">TIMO · Organizer</p>
          <h1>Organizer dashboard</h1>
          <p className="lede">Create events, manage escrow, and check attendees in at the door.</p>
        </div>
      </div>

      {!timo ? (
        <div className="card empty">
          No TIMO contract configured for {net.label}. Set <code>NEXT_PUBLIC_TIMO_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
        </div>
      ) : !isConnected ? (
        <div className="card empty">Connect the organizer wallet to manage events.</div>
      ) : (
        <div className="stack">
          <CreateEventForm onCreated={() => void events.refetch()} />
          <section className="stack" aria-label="Your events">
            <h2 style={{ fontSize: 22 }}>Your events</h2>
            {events.isLoading ? (
              <div className="card empty">Loading your events…</div>
            ) : mine.length === 0 ? (
              <div className="card empty">No events created with this wallet yet.</div>
            ) : (
              mine.map((e) => <OrganizerEventRow key={e.id.toString()} event={e} onChanged={() => void events.refetch()} />)
            )}
          </section>
          <CheckInPanel />
        </div>
      )}
    </main>
  );
}
