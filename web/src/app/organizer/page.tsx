"use client";

import { getLogsChunked } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getAbiItem, recoverMessageAddress, type Address, type Hash, type PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient } from "wagmi";
import { readContract, signMessage, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import {
  fetchEvents,
  formatDateTime,
  formatTUSD8,
  parseCheckInPayload,
  readEvent,
  readRole,
  readTicket,
  scanFromBlock,
  staffCheckInMessage,
  timoAbi,
  type TimoEvent,
} from "@/lib/timo";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* ---------------- Scanner + check-in ---------------- */

interface VerifyState {
  ok: boolean;
  detail: string;
  tokenId: bigint;
}

function CheckInPanel({ event, onDone }: { event: TimoEvent; onDone: () => void }) {
  const { net } = useNetwork();
  const timo = net.timo;
  const config = useConfig();
  const { address } = useAccount();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanSupported, setScanSupported] = useState<boolean | null>(null);
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<VerifyState | null>(null);
  const [busy, setBusy] = useState<"verify" | "checkin" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneHash, setDoneHash] = useState<Hash | null>(null);

  useEffect(() => {
    setScanSupported(typeof window !== "undefined" && "BarcodeDetector" in window);
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }

  async function startCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      // @ts-expect-error BarcodeDetector is not in TS lib yet.
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          const codes = await detector.detect(video);
          if (codes?.length) {
            const value = codes[0].rawValue as string;
            stopCamera();
            setRaw(value);
            void verify(value);
            return;
          }
        } catch {
          // Keep trying on the next frame.
        }
        if (streamRef.current) setTimeout(tick, 250);
      };
      void tick();
    } catch {
      setError("Camera is unavailable or permission was denied. Paste the payload text instead.");
      setScanning(false);
    }
  }

  async function verify(text: string) {
    if (!client || !timo) return;
    setError(null);
    setDoneHash(null);
    setResult(null);
    const payload = parseCheckInPayload(text.trim());
    if (!payload) {
      setResult({ ok: false, detail: "That doesn't look like a TIMO check-in payload. Ask the attendee to show a fresh QR.", tokenId: 0n });
      return;
    }
    setBusy("verify");
    try {
      const tokenId = BigInt(payload.tokenId);
      const now = Math.floor(Date.now() / 1000);
      if (payload.expiry < now) {
        setResult({ ok: false, detail: "This QR has expired. Ask the attendee to generate a fresh one.", tokenId });
        return;
      }
      const signer = await recoverMessageAddress({ message: payload.message, signature: payload.signature });
      const owner = (await readContract(config, { address: timo, abi: timoAbi, functionName: "ownerOf", args: [tokenId], chainId: net.chain.id })) as Address;
      if (signer.toLowerCase() !== owner.toLowerCase()) {
        setResult({ ok: false, detail: `Signed by ${short(signer)}, but ticket #${tokenId.toString()} belongs to ${short(owner)}. Do not admit.`, tokenId });
        return;
      }
      const t = await readTicket(client, timo, tokenId);
      if (t.eventId !== event.id) {
        setResult({ ok: false, detail: `Ticket #${tokenId.toString()} is for a different event. Do not admit here.`, tokenId });
        return;
      }
      if (t.checkedIn) {
        setResult({ ok: false, detail: `Ticket #${tokenId.toString()} was already checked in. Do not admit twice.`, tokenId });
        return;
      }
      setResult({ ok: true, detail: `Valid: ticket #${tokenId.toString()} · owner ${short(owner)} · not yet checked in.`, tokenId });
    } catch (e) {
      setResult({ ok: false, detail: `Verification failed: ${explain(e)}`, tokenId: 0n });
    } finally {
      setBusy(null);
    }
  }

  async function confirmCheckIn() {
    if (!address || !timo || !result?.ok) return;
    const payload = parseCheckInPayload(raw.trim());
    if (!payload) return;
    setError(null);
    setBusy("checkin");
    try {
      const tokenId = BigInt(payload.tokenId);
      // Preferred: relayed check-in — staff signs, the TIMO relayer submits and pays gas.
      let hash: Hash | null = null;
      try {
        const staffSignature = await signMessage(config, {
          account: address,
          message: staffCheckInMessage(tokenId, payload.expiry),
        });
        const res = await fetch("/api/relay-timo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "checkin",
            chainId: net.chain.id,
            tokenId: payload.tokenId,
            expiry: payload.expiry,
            ownerSignature: payload.signature,
            staffSignature,
          }),
        });
        const data = (await res.json()) as { hash?: Hash; error?: string };
        if (res.ok && data.hash) hash = data.hash;
      } catch {
        hash = null;
      }
      if (!hash) {
        // Fallback: staff submits directly (pays gas).
        const { request } = await simulateContract(config, {
          account: address,
          address: timo,
          abi: timoAbi,
          functionName: "checkIn",
          args: [tokenId, BigInt(payload.expiry), payload.signature],
          chainId: net.chain.id,
        });
        hash = await writeContract(config, request);
      }
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The check-in transaction reverted.");
      setDoneHash(hash);
      setResult(null);
      setRaw("");
      onDone();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack" aria-label="Check-in scanner">
      <div className="studio-band">
        <h3>Check-in mode</h3>
        <span className="fine light">
          Doors opened {formatDateTime(event.checkInOpensAt)} · the contract verifies the owner&apos;s signature on-chain.
        </span>
      </div>
      {scanning ? (
        <>
          <video ref={videoRef} className="scan-video" muted playsInline aria-label="Camera view for QR scanning" />
          <button type="button" className="btn ghost block" onClick={stopCamera}>
            Stop camera
          </button>
        </>
      ) : (
        <button type="button" className="btn big block" onClick={startCamera} disabled={scanSupported === false}>
          {scanSupported === false ? "Camera scanning not supported in this browser" : "Open camera scanner"}
        </button>
      )}
      <label className="stack" style={{ gap: 6 }}>
        <span className="fine">Or paste the attendee&apos;s payload text</span>
        <textarea
          className="input"
          rows={3}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder='{"tokenId":"1","expiry":…,"message":"…","signature":"0x…"}'
        />
      </label>
      <button type="button" className="btn block" onClick={() => void verify(raw)} disabled={busy !== null || !raw.trim()}>
        {busy === "verify" ? "Verifying…" : "Verify payload"}
      </button>
      {result && (
        <div className={`notice ${result.ok ? "good" : "bad"}`} role="status">
          <strong>{result.ok ? "Valid ticket" : "Do not admit"}</strong>
          <span>{result.detail}</span>
        </div>
      )}
      {result?.ok && (
        <button type="button" className="btn big block" onClick={confirmCheckIn} disabled={busy !== null}>
          {busy === "checkin" ? "Confirming on-chain…" : `Confirm check-in · Ticket #${result.tokenId.toString()}`}
        </button>
      )}
      {doneHash && (
        <div className="notice good" role="status">
          <strong>Checked in</strong>
          <span>Recorded on-chain. Ready for the next attendee.</span>
        </div>
      )}
      {error && (
        <div className="notice bad" role="alert">
          <strong>Something went wrong</strong>
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}

/* ---------------- Admin: sales + ticket lists ---------------- */

interface SaleRow {
  tokenId: bigint;
  buyer: Address;
  txHash: Hash;
  checkedIn: boolean | null;
  owner: string;
}

function AdminPanel({ event }: { event: TimoEvent }) {
  const { net } = useNetwork();
  const timo = net.timo;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;

  const sales = useQuery({
    queryKey: ["timo-sales", net.chain.id, timo, event.id.toString()],
    enabled: Boolean(client && timo),
    queryFn: async (): Promise<SaleRow[]> => {
      const head = await client!.getBlockNumber();
      const logs = await getLogsChunked(client!, {
        address: timo!,
        event: getAbiItem({ abi: timoAbi, name: "TicketPurchased" }),
        args: { eventId: event.id },
        fromBlock: scanFromBlock(head, net.deployBlock),
        toBlock: head,
      });
      const rows: SaleRow[] = [];
      for (const l of logs) {
        const tokenId = (l.args as any).tokenId as bigint;
        let checkedIn: boolean | null = null;
        let owner = "—";
        try {
          const t = await readTicket(client!, timo!, tokenId);
          checkedIn = t.checkedIn;
          owner = short((await client!.readContract({ address: timo!, abi: timoAbi, functionName: "ownerOf", args: [tokenId] })) as string);
        } catch {
          owner = "refunded (burned)";
          checkedIn = false;
        }
        rows.push({ tokenId, buyer: (l.args as any).buyer as Address, txHash: l.transactionHash, checkedIn, owner });
      }
      return rows;
    },
  });

  const checkedInCount = (sales.data ?? []).filter((r) => r.checkedIn).length;

  return (
    <section className="card stack" aria-label="Event administration">
      <h3>Sales &amp; tickets</h3>
      <dl className="kv">
        <dt>Sold</dt>
        <dd>
          {event.sold} / {event.capacity}
        </dd>
        <dt>Escrow</dt>
        <dd>{formatTUSD8(event.escrow)} tUSD8</dd>
        <dt>Checked in</dt>
        <dd>
          {checkedInCount} / {event.sold}
        </dd>
        <dt>Service fee</dt>
        <dd>{event.feeBps / 100}% (settled at withdraw)</dd>
      </dl>
      {sales.isLoading ? (
        <p className="fine">Loading sales…</p>
      ) : (sales.data ?? []).length === 0 ? (
        <p className="fine">No sales yet.</p>
      ) : (
        <table className="sales-table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Buyer</th>
              <th>Owner now</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(sales.data ?? []).map((r) => (
              <tr key={r.tokenId.toString()}>
                <td>#{r.tokenId.toString()}</td>
                <td>{short(r.buyer)}</td>
                <td>{r.owner}</td>
                <td>{r.checkedIn ? "Checked in" : "Not arrived"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="btn ghost small" onClick={() => void sales.refetch()}>
        Refresh
      </button>
    </section>
  );
}

/* ---------------- Studio root ---------------- */

export default function OrganizerStudioPage() {
  const { net } = useNetwork();
  const timo = net.timo;
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === net.chain.id;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const [selected, setSelected] = useState<bigint | null>(null);

  const events = useQuery({
    queryKey: ["timo-events", net.chain.id, timo],
    enabled: Boolean(client && timo),
    queryFn: () => fetchEvents(client!, timo!, net.deployBlock),
  });

  const roles = useQuery({
    queryKey: ["timo-roles", net.chain.id, timo, address, (events.data ?? []).length],
    enabled: Boolean(client && timo && onChain && address && events.data),
    queryFn: async () => {
      const map = new Map<string, number>();
      for (const e of events.data!) {
        const role = await readRole(client!, timo!, e.id, address!);
        if (role > 0) map.set(e.id.toString(), role);
      }
      return map;
    },
  });

  const myEvents = (events.data ?? []).filter((e) => (roles.data?.get(e.id.toString()) ?? 0) > 0);
  const current = myEvents.find((e) => e.id === selected) ?? myEvents[0];

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">TIMO · Organizer Studio</p>
          <h1>Organizer Studio</h1>
          <p className="lede">
            A separate workspace for event staff. Admins see sales and check-in lists; guards only scan tickets at the door. Events themselves
            are published by TIMO — organizers never create them here.
          </p>
        </div>
      </div>

      {!timo ? (
        <div className="card empty">No TIMO contract configured for {net.label}.</div>
      ) : !isConnected ? (
        <div className="card empty">Connect the wallet your organizer registered with TIMO.</div>
      ) : !onChain ? (
        <div className="card empty">Switch your wallet to {net.chain.name}.</div>
      ) : roles.isLoading || events.isLoading ? (
        <div className="card empty">Checking your staff roles…</div>
      ) : myEvents.length === 0 ? (
        <section className="card stack" aria-label="Become an organizer">
          <h2>This wallet has no staff role</h2>
          <p className="sub">
            TIMO is an official ticket agent: events are vetted offline and published by the TIMO team. Staff access (AdminOrganizer and
            GuardOrganizer wallets) is registered on-chain by TIMO when an event is created — it cannot be requested from inside the app.
          </p>
          <p className="sub">
            Want to sell tickets for your event through TIMO? Message us on Telegram with your event details (venue,
            date, price, capacity) and your team&apos;s wallet addresses: 1 boss wallet, 1–3 admin wallets, and 5–25 guard wallets.
          </p>
          <a className="btn ghost" href="https://t.me/Nyollo1" target="_blank" rel="noreferrer">
            Contact TIMO on Telegram
          </a>
        </section>
      ) : (
        <div className="stack" style={{ gap: 20 }}>
          <div className="filter-row" role="tablist" aria-label="Your events">
            {myEvents.map((e) => (
              <button
                key={e.id.toString()}
                type="button"
                role="tab"
                aria-selected={current?.id === e.id}
                className={`filter-chip ${current?.id === e.id ? "active" : ""}`}
                onClick={() => setSelected(e.id)}
              >
                {e.name || `Event #${e.id.toString()}`} · {roles.data!.get(e.id.toString()) === 1 ? "Admin" : "Guard"}
              </button>
            ))}
          </div>
          {current && (
            <>
              <div className="check-top" style={{ alignItems: "baseline" }}>
                <h2>
                  <Link href={`/event/${current.id.toString()}`}>{current.name || `Event #${current.id.toString()}`}</Link>
                </h2>
                <span className={`status-pill ${current.status === 0 ? "good" : "warn"}`}>
                  {roles.data!.get(current.id.toString()) === 1 ? "AdminOrganizer" : "GuardOrganizer"} · {current.statusLabel}
                </span>
              </div>
              <p className="fine">
                Starts {formatDateTime(current.startsAt)} · Doors {formatDateTime(current.checkInOpensAt)} · Boss (payout) {short(current.boss)}
              </p>
              <CheckInPanel event={current} onDone={() => void roles.refetch()} />
              {roles.data!.get(current.id.toString()) === 1 && <AdminPanel key={current.id.toString()} event={current} />}
            </>
          )}
        </div>
      )}
    </main>
  );
}
