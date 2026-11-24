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
  formatDateTime,
  formatTUSD8,
  isRefundable,
  readTicketNft,
  timoAbi,
  type TimoEvent,
  type TimoTicket,
} from "@/lib/timo";

function CheckInQr({ ticket }: { ticket: TimoTicket }) {
  const config = useConfig();
  const { address } = useAccount();
  const [qr, setQr] = useState<{ dataUrl: string; expiry: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  async function show() {
    if (!address) return;
    setBusy(true);
    setError(null);
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

  useEffect(() => {
    if (!qr) return;
    const tick = () => setSecondsLeft(Math.max(0, qr.expiry - Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [qr]);

  if (ticket.checkedIn) return <p className="fine">This ticket has been checked in. It is locked and cannot be transferred or refunded.</p>;
  if (ticket.event.status === 1) return <p className="fine">Event cancelled — claim your refund below instead of checking in.</p>;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="fine">Check-in in 3 steps: 1) Open this ticket at the door. 2) Show the QR to the organizer&apos;s staff. 3) They scan it — done.</p>
      {qr ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qr-img" src={qr.dataUrl} alt={`Check-in QR for ticket ${ticket.tokenId.toString()}`} />
          <p className="fine" role="status">
            Expires in {secondsLeft}s — a screenshot is useless once it lapses.
          </p>
          <button type="button" className="btn ghost small" onClick={show} disabled={busy}>
            Generate a fresh QR
          </button>
        </>
      ) : (
        <button type="button" className="btn block" onClick={show} disabled={busy}>
          {busy ? "Check your wallet…" : "Show QR for check-in"}
        </button>
      )}
      {error && (
        <p className="fine" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TicketCard({ ticket, onChanged }: { ticket: TimoTicket; onChanged: () => void }) {
  const config = useConfig();
  const { net } = useNetwork();
  const timo = net.timo;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Math.floor(Date.now() / 1000);
  const refundable = isRefundable(ticket.event, now) && !ticket.refunded && !ticket.checkedIn;

  const nft = useQuery({
    queryKey: ["timo-nft", net.chain.id, timo, ticket.tokenId.toString()],
    enabled: Boolean(client && timo),
    queryFn: () => readTicketNft(client!, timo!, ticket.tokenId),
    staleTime: 30_000,
  });

  async function claimRefund() {
    if (!timo) return;
    setBusy(true);
    setError(null);
    try {
      const { request } = await simulateContract(config, {
        address: timo,
        abi: timoAbi,
        functionName: "claimRefund",
        args: [ticket.tokenId],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
      onChanged();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card stack ticket-nft">
      {nft.data?.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="nft-img" src={nft.data.image} alt="" />
      ) : ticket.event.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="nft-img" src={ticket.event.imageUrl} alt="" />
      ) : null}
      <div className="check-top" style={{ alignItems: "baseline" }}>
        <h3>Ticket #{ticket.tokenId.toString()}</h3>
        <span className={`status-pill ${ticket.checkedIn ? "warn" : ticket.event.status === 1 ? "bad" : "good"}`}>
          {ticket.checkedIn ? "Checked in" : ticket.event.status === 1 ? "Event cancelled" : (nft.data?.status ?? "Active")}
        </span>
      </div>
      <p className="fine">
        NFT · ERC-721 #{ticket.tokenId.toString()} · {formatTUSD8(ticket.event.price)} tUSD8
      </p>
      <CheckInQr ticket={ticket} />
      {refundable && (
        <div className="stack" style={{ gap: 8 }}>
          <button type="button" className="btn warn block" onClick={claimRefund} disabled={busy}>
            {busy ? "Check your wallet…" : `Claim refund · ${formatTUSD8(ticket.event.price)} tUSD8`}
          </button>
          <p className="fine">Claiming burns the ticket NFT and returns the full price from escrow to your wallet.</p>
        </div>
      )}
      {error && (
        <p className="fine" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export default function MyTicketsPage() {
  const { net } = useNetwork();
  const timo = net.timo;
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === net.chain.id;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;

  const tickets = useQuery({
    queryKey: ["timo-my-tickets", net.chain.id, timo, address],
    enabled: Boolean(client && timo && onChain && address),
    queryFn: () => fetchMyTickets(client!, timo!, address!, net.deployBlock),
  });

  const groups = new Map<string, { event: TimoEvent; items: TimoTicket[] }>();
  for (const t of tickets.data ?? []) {
    const key = t.eventId.toString();
    if (!groups.has(key)) groups.set(key, { event: t.event, items: [] });
    groups.get(key)!.items.push(t);
  }

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">TIMO · My Tickets</p>
          <h1>My tickets</h1>
          <p className="lede">Your tickets are ERC-721 NFTs, grouped by event. This page always shows what your wallet owns right now.</p>
        </div>
      </div>

      {!timo ? (
        <div className="card empty">No TIMO contract configured for {net.label}.</div>
      ) : !isConnected ? (
        <div className="card empty">Connect your wallet to see your tickets.</div>
      ) : !onChain ? (
        <div className="card empty">Switch your wallet to {net.chain.name} to see your tickets.</div>
      ) : tickets.isLoading ? (
        <div className="card empty">Loading your tickets…</div>
      ) : tickets.isError ? (
        <div className="notice bad" role="alert">
          <strong>Couldn&apos;t load your tickets</strong>
          <span>Reading your ticket logs failed. Check the network and reload.</span>
        </div>
      ) : (tickets.data ?? []).length === 0 ? (
        <div className="card empty">
          No tickets yet. Browse <Link href="/">events</Link> to buy your first one.
        </div>
      ) : (
        [...groups.values()].map(({ event, items }) => (
          <section key={event.id.toString()} className="stack" style={{ marginBottom: 28 }} aria-label={event.name}>
            <div className="check-top" style={{ alignItems: "baseline" }}>
              <h2>
                <Link href={`/event/${event.id.toString()}`}>{event.name || `Event #${event.id.toString()}`}</Link>
              </h2>
              <span className="fine">
                {formatDateTime(event.startsAt)} · {items.length} ticket{items.length > 1 ? "s" : ""}
              </span>
            </div>
            <div className="grid-2">
              {items.map((t) => (
                <TicketCard key={t.tokenId.toString()} ticket={t} onChanged={() => void tickets.refetch()} />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
