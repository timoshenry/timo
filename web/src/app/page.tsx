"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { useNetwork } from "@/lib/network";
import { fetchEvents, formatDateTime, formatTUSD8, resolveEventTitle, type TimoEvent } from "@/lib/timo";

function EventTitle({ event }: { event: TimoEvent }) {
  const title = useQuery({
    queryKey: ["timo-title", event.id.toString(), event.metadataURI],
    queryFn: () => resolveEventTitle(event.metadataURI, event.id),
    staleTime: 60_000,
  });
  return <>{title.data ?? `Event #${event.id.toString()}`}</>;
}

export default function ExplorePage() {
  const { net } = useNetwork();
  const timo = net.timo;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;

  const events = useQuery({
    queryKey: ["timo-events", net.chain.id, timo],
    enabled: Boolean(client && timo),
    queryFn: () => fetchEvents(client!, timo!, net.deployBlock),
  });

  const open = (events.data ?? []).filter((e) => e.status === 0);

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">TIMO · Ticket &amp; Invoice Management Onchain</p>
          <h1>Explore events</h1>
          <p className="lede">
            Event tickets paid in tUSD8 on Aevum. Your payment stays in escrow — if an event is cancelled, every ticket owner can claim a
            full refund.
          </p>
        </div>
        {events.data && (
          <div className="score">
            <span className="score-num">{open.length}</span>
            <span className="fine">open events on {net.label}</span>
          </div>
        )}
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
      ) : open.length === 0 ? (
        <div className="card empty">
          No open events yet. Organizers can create one from the <Link href="/organizer">Organizer</Link> page.
        </div>
      ) : (
        <section className="grid-2" aria-label="Open events">
          {open.map((e) => (
            <article className="card stack" key={e.id.toString()} style={{ gap: 12 }}>
              <div className="check-top" style={{ alignItems: "baseline" }}>
                <h2>
                  <EventTitle event={e} />
                </h2>
                <span className="status-pill good">Open</span>
              </div>
              <dl className="kv">
                <dt>Price</dt>
                <dd>
                  {formatTUSD8(e.price)} tUSD8
                </dd>
                <dt>Tickets</dt>
                <dd>
                  {e.sold} / {e.capacity} sold
                </dd>
                <dt>Starts</dt>
                <dd>{formatDateTime(e.startsAt)}</dd>
                <dt>Sales end</dt>
                <dd>{formatDateTime(e.salesEnd)}</dd>
              </dl>
              <div className="progress" aria-hidden="true">
                <span style={{ width: `${e.capacity ? Math.min(100, (e.sold / e.capacity) * 100) : 0}%` }} />
              </div>
              <Link className="btn block" href={`/event/${e.id.toString()}`}>
                View event &amp; buy ticket
              </Link>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
