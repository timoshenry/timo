"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient } from "wagmi";
import { signMessage, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import {
  CHECK_IN_TTL_SECONDS,
  checkInMessage,
  encodeCheckInPayload,
  fetchMyTickets,
  formatTUSD8,
  resolveEventTitle,
  timoAbi,
  type TimoTicket,
} from "@/lib/timo";

function TicketTitle({ ticket }: { ticket: TimoTicket }) {
  const title = useQuery({
    queryKey: ["timo-title", ticket.eventId.toString(), ticket.event.metadataURI],
    queryFn: () => resolveEventTitle(ticket.event.metadataURI, ticket.eventId),
    staleTime: 60_000,
  });
  return <>{title.data ?? `Event #${ticket.eventId.toString()}`}</>;
}

function CheckInQr({ ticket }: { ticket: TimoTicket }) {
  const config = useConfig();
  const { address } = useAccount();
  const [qr, setQr] = useState<{ dataUrl: string; expiry: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  async function show() {
    if (!address) return;
    setError(null);
    setBusy(true);
    try {
      const expiry = Math.floor(Date.now() / 1000) + CHECK_IN_TTL_SECONDS;
      const signature = await signMessage(config, { account: address, message: checkInMessage(ticket.tokenId, expiry) });
      const payload = encodeCheckInPayload(ticket.tokenId, expiry, signature);
      const dataUrl = await QRCode.toDataURL(payload, { width: 240, margin: 1 });
      setQr({ dataUrl, expiry });
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  // Every 30 seconds, re-check the signed payload: drop it once its signature has expired so the
  // owner signs a fresh one. A 1-second countdown runs alongside for display.
  useEffect(() => {
    if (!qr) return;
    const check = () => {
      const left = qr.expiry - Math.floor(Date.now() / 1000);
      setSecondsLeft(Math.max(0, left));
      if (left <= 0) setQr(null);
    };
    check();
    const refresh = setInterval(check, 30_000);
    const countdown = setInterval(() => setSecondsLeft(Math.max(0, qr.expiry - Math.floor(Date.now() / 1000))), 1_000);
    return () => {
      clearInterval(refresh);
      clearInterval(countdown);
    };
  }, [qr]);

  if (ticket.checkedIn) {
    return (
      <div className="notice good" role="status">
        <strong>Checked in</strong>
        <span>This ticket was locked at the door and can no longer be transferred or refunded.</span>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {qr ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.dataUrl} alt={`Check-in QR for ticket #${ticket.tokenId.toString()}`} width={240} height={240} style={{ borderRadius: 12, background: "#fff" }} />
          <p className="fine">
            Show this to the organizer. It proves wallet ownership and expires in {secondsLeft}s — a screenshot is useless once it lapses.
          </p>
        </>
      ) : (
        <>
          <button type="button" className="btn secondary block" disabled={busy} onClick={show}>
            {busy ? "Check your wallet…" : "Show check-in QR"}
          </button>
          <p className="fine">You sign a short-lived message (no gas). The organizer verifies it against the on-chain owner, then locks the ticket.</p>
        </>
      )}
      {error && (
        <div className="notice bad" role="alert">
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket, onChanged }: { ticket: TimoTicket; onChanged: () => void }) {
  const { net } = useNetwork();
  const config = useConfig();
  const { address } = useAccount();
  const timo = net.timo;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = ticket.event.status === 1;

  async function claimRefund() {
    if (!address || !timo) return;
    setError(null);
    setBusy(true);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: timo,
        abi: timoAbi,
        functionName: "claimRefund",
        args: [ticket.tokenId],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. No refund was paid.");
      onChanged();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card stack" style={{ gap: 14 }}>
      <div className="check-top" style={{ alignItems: "baseline" }}>
        <h2>
          <TicketTitle ticket={ticket} />
        </h2>
        <span className={`status-pill ${ticket.checkedIn ? "good" : cancelled ? "warn" : ""}`} style={ticket.checkedIn || cancelled ? undefined : { background: "var(--surface-2)", color: "var(--text-2)" }}>
          {ticket.checkedIn ? "Checked in" : cancelled ? "Event cancelled" : "Valid"}
        </span>
      </div>
      <dl className="kv">
        <dt>Ticket</dt>
        <dd>#{ticket.tokenId.toString()}</dd>
        <dt>Event</dt>
        <dd>
          <Link href={`/event/${ticket.eventId.toString()}`}>#{ticket.eventId.toString()}</Link>
        </dd>
        <dt>Paid</dt>
        <dd>{formatTUSD8(ticket.event.price)} tUSD8</dd>
      </dl>
      {cancelled && !ticket.checkedIn ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="notice warn" role="status">
            <strong>Refund available</strong>
            <span>Claim the full {formatTUSD8(ticket.event.price)} tUSD8 back from escrow. The ticket is burned when you claim.</span>
          </div>
          <button type="button" className="btn block" disabled={busy} onClick={claimRefund}>
            {busy ? "Check your wallet…" : `Claim refund · ${formatTUSD8(ticket.event.price)} tUSD8`}
          </button>
        </div>
      ) : (
        <CheckInQr ticket={ticket} />
      )}
      {error && (
        <div className="notice bad" role="alert">
          <span>{error}</span>
        </div>
      )}
    </article>
  );
}

export default function MyTicketsPage() {
  const { net } = useNetwork();
  const timo = net.timo;
  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;

  const tickets = useQuery({
    queryKey: ["timo-my-tickets", net.chain.id, timo, address],
    enabled: Boolean(client && timo && address),
    queryFn: () => fetchMyTickets(client!, timo!, address!, net.deployBlock),
  });

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">TIMO · Wallet tickets</p>
          <h1>My Tickets</h1>
          <p className="lede">Tickets owned by your connected wallet, with a dynamic check-in QR and refund claims for cancelled events.</p>
        </div>
        {tickets.data && (
          <div className="score">
            <span className="score-num">{tickets.data.length}</span>
            <span className="fine">tickets owned</span>
          </div>
        )}
      </div>

      {!timo ? (
        <div className="card empty">
          No TIMO contract configured for {net.label}. Set <code>NEXT_PUBLIC_TIMO_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
        </div>
      ) : !isConnected ? (
        <div className="card empty">Connect your wallet to see your tickets.</div>
      ) : tickets.isLoading ? (
        <div className="card empty">Loading your tickets…</div>
      ) : tickets.isError ? (
        <div className="notice bad" role="alert">
          <strong>Couldn&apos;t load your tickets</strong>
          <span>Reading TicketPurchased logs failed. Check the network and contract address, then reload.</span>
        </div>
      ) : (tickets.data?.length ?? 0) === 0 ? (
        <div className="card empty">
          No tickets yet. Find an event on the <Link href="/">Explore</Link> page.
        </div>
      ) : (
        <section className="grid-2" aria-label="Your tickets">
          {tickets.data!.map((t) => (
            <TicketCard key={t.tokenId.toString()} ticket={t} onChanged={() => void tickets.refetch()} />
          ))}
        </section>
      )}
    </main>
  );
}
