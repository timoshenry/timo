"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { useNetwork } from "@/lib/network";
import { fetchEvents, formatDateTime, formatTUSD8, type TimoEvent } from "@/lib/timo";

type Filter = "upcoming" | "soldout" | "cancelled" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "soldout", label: "Sold out" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All events" },
];

function matches(e: TimoEvent, f: Filter, now: number): boolean {
  if (f === "all") return true;
  if (f === "cancelled") return e.status === 1;
  if (f === "soldout") return e.status === 0 && e.sold >= e.capacity;
  return e.status === 0 && e.sold < e.capacity && Number(e.startsAt) > now;
}

function statusPill(e: TimoEvent): { label: string; cls: string } {
  if (e.status === 1) return { label: "Cancelled", cls: "bad" };
  if (e.status === 2) return { label: "Completed", cls: "warn" };
  if (e.sold >= e.capacity) return { label: "Sold out", cls: "warn" };
  return { label: "Open", cls: "good" };
}

export default function ExplorePage() {
  const { net } = useNetwork();
  const timo = net.timo;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const [filter, setFilter] = useState<Filter>("upcoming");

  const events = useQuery({
    queryKey: ["timo-events", net.chain.id, timo],
    enabled: Boolean(client && timo),
    queryFn: () => fetchEvents(client!, timo!, net.deployBlock),
  });

  const all = events.data ?? [];
  const now = Math.floor(Date.now() / 1000);
  const shown = all.filter((e) => matches(e, filter, now));
  const totalSold = all.reduce((n, e) => n + e.sold, 0);
  const totalEscrow = all.reduce((n, e) => n + e.escrow, 0n);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow light">TIMO · Ticket &amp; Invoice Management Onchain</p>
        <h1>Official event tickets, paid in tUSD8.</h1>
        <p className="hero-lede">
          Every event on TIMO is vetted and published by the TIMO team on behalf of its organizer. Your payment is held in escrow by the
          contract — never paid straight to the organizer — and refunded in full if the event is cancelled.
        </p>
        {events.data && (
          <div className="hero-stats" role="status">
            <div>
              <span className="hero-stat-num">{all.length}</span>
              <span className="hero-stat-label">events on-chain</span>
            </div>
            <div>
              <span className="hero-stat-num">{totalSold}</span>
              <span className="hero-stat-label">tickets sold</span>
            </div>
            <div>
              <span className="hero-stat-num">{formatTUSD8(totalEscrow)}</span>
              <span className="hero-stat-label">tUSD8 in escrow</span>
            </div>
          </div>
        )}
      </section>

      <div className="filter-row" role="tablist" aria-label="Event filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={`filter-chip ${filter === f.key ? "active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!timo ? (
        <div className="card empty">
          No TIMO contract configured for {net.label}. Deploy TIMO, then set <code>NEXT_PUBLIC_TIMO_{net.key.toUpperCase()}</code> in{" "}
          <code>web/.env.local</code>.
        </div>
      ) : events.isLoading ? (
        <div className="card empty">Loading events from {net.label}…</div>
      ) : events.isError ? (
        <div className="notice bad" role="alert">
          <strong>Couldn&apos;t load events</strong>
          <span>Reading EventCreated logs from the TIMO contract failed. Check the network and the contract address, then reload.</span>
        </div>
      ) : shown.length === 0 ? (
        <div className="card empty">No events in this view yet. Events are published by TIMO after an organizer is vetted — see “Become an organizer” below.</div>
      ) : (
        <section className="grid-2" aria-label="Events">
          {shown.map((e) => {
            const pill = statusPill(e);
            return (
              <article className="ticket-card" key={e.id.toString()}>
                <div className="ticket-main">
                  {e.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="ticket-img" src={e.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <div className="ticket-img placeholder" aria-hidden="true">
                      TIMO
                    </div>
                  )}
                  <div className="ticket-body">
                    <div className="check-top" style={{ alignItems: "baseline" }}>
                      <h2>{e.name || `Event #${e.id.toString()}`}</h2>
                      <span className={`status-pill ${pill.cls}`}>{pill.label}</span>
                    </div>
                    <p className="fine">
                      {formatDateTime(e.startsAt)} · {e.sold} / {e.capacity} sold
                    </p>
                    <div className="progress" aria-hidden="true">
                      <span style={{ width: `${e.capacity ? Math.min(100, (e.sold / e.capacity) * 100) : 0}%` }} />
                    </div>
                  </div>
                </div>
                <div className="ticket-stub">
                  <span className="stub-price">{formatTUSD8(e.price)} tUSD8</span>
                  <Link className="btn block" href={`/event/${e.id.toString()}`}>
                    View &amp; buy
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      )}

      <section className="footer-info" aria-label="About TIMO">
        <div className="info-grid">
          <article className="card stack">
            <h2>How TIMO works</h2>
            <p className="sub">
              Organizers are vetted offline by TIMO and never publish events themselves. You buy a ticket NFT with tUSD8 — gas-free via our
              relayer — and the money waits in contract escrow until the event completes. Cancelled? Claim a full refund from My Tickets.
            </p>
            <Link className="btn ghost" href="/docs">
              Read the docs
            </Link>
          </article>
          <article className="card stack">
            <h2>FAQ</h2>
            <details>
              <summary>How do I buy a ticket?</summary>
              <p className="sub">Connect your wallet, open an event, and sign once. The relayer submits the purchase and pays the gas — you only need tUSD8.</p>
            </details>
            <details>
              <summary>What if an event is cancelled or moved?</summary>
              <p className="sub">Cancelled events refund every ticket owner in full. If an event is rescheduled, a 7-day window opens in which you may claim a full refund instead.</p>
            </details>
            <details>
              <summary>How does check-in work?</summary>
              <p className="sub">Open your ticket in My Tickets and show its dynamic QR. It is signed by your wallet and expires in 60 seconds, so a screenshot is useless to anyone else.</p>
            </details>
            <details>
              <summary>Can I give my ticket to someone else?</summary>
              <p className="sub">Tickets are ERC-721 NFTs; transfers happen in your own wallet, outside TIMO. Whoever owns the ticket at refund time receives any refund.</p>
            </details>
          </article>
          <article className="card stack" id="contact">
            <h2>Contact &amp; help center</h2>
            <p className="sub">
              Questions about a ticket, or want to sell tickets for your event through TIMO? Message us on Telegram — the same contact is our
              help center and the organizer intake.
            </p>
            <p className="sub">Prospective organizers: please include your wallet address and a short description of your event (venue, date, ticket price, capacity).</p>
            <a className="btn ghost" href="https://t.me/Nyollo1" target="_blank" rel="noreferrer">
              Contact us on Telegram
            </a>
          </article>
        </div>
      </section>
    </main>
  );
}
