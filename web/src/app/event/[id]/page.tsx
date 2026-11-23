"use client";

import { erc20Abi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import type { Address, Hash, PublicClient } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { formatDateTime, formatTUSD8, readEvent, resolveEventTitle, timoAbi } from "@/lib/timo";

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const eventId = /^\d+$/.test(params.id ?? "") ? BigInt(params.id) : null;
  const { net } = useNetwork();
  const timo = net.timo;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === net.chain.id;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;

  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);

  const event = useQuery({
    queryKey: ["timo-event", net.chain.id, timo, eventId?.toString()],
    enabled: Boolean(client && timo && eventId !== null),
    queryFn: () => readEvent(client!, timo!, eventId!),
  });
  const ev = event.data;

  const title = useQuery({
    queryKey: ["timo-title", eventId?.toString(), ev?.metadataURI],
    enabled: Boolean(ev),
    queryFn: () => resolveEventTitle(ev!.metadataURI, ev!.id),
    staleTime: 60_000,
  });

  const tokenAddress = useReadContract({
    address: timo,
    abi: timoAbi,
    functionName: "token",
    chainId: net.chain.id,
    query: { enabled: Boolean(timo) },
  }).data as Address | undefined;

  const balance = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: net.chain.id,
    query: { enabled: onChain && Boolean(tokenAddress && address) },
  });

  const now = Math.floor(Date.now() / 1000);
  const salesOpen = ev ? ev.status === 0 && now <= Number(ev.salesEnd) && ev.sold < ev.capacity : false;
  const enoughBalance = !ev || balance.data === undefined || balance.data >= ev.price;
  const busy = phase === "working";

  async function onBuy() {
    if (!address || !timo || !tokenAddress || !ev) return;
    setError(null);
    setPhase("working");
    try {
      // 1. Approve exactly the ticket price, never an unlimited amount.
      const allowance = await readContract(config, {
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, timo],
        chainId: net.chain.id,
      });
      if (allowance < ev.price) {
        const approveHash = await writeContract(config, {
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [timo, ev.price],
          chainId: net.chain.id,
        });
        await waitForTransactionReceipt(config, { hash: approveHash, chainId: net.chain.id });
      }
      // 2. Buy. Simulate first so a revert surfaces with its reason before gas is spent.
      const { request } = await simulateContract(config, {
        account: address,
        address: timo,
        abi: timoAbi,
        functionName: "buyTicket",
        args: [ev.id],
        chainId: net.chain.id,
      });
      const hash = await writeContract(config, request);
      setTxHash(hash);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was charged.");
      setPhase("done");
      void event.refetch();
      void balance.refetch();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  const cta = (() => {
    if (!isConnected) return "Connect a wallet to buy";
    if (!onChain) return "Switch network to buy";
    if (!ev) return "Buy ticket";
    if (phase === "done") return "Ticket purchased";
    if (busy) return "Check your wallet…";
    return `Buy ticket · ${formatTUSD8(ev.price)} tUSD8`;
  })();

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">TIMO · Event detail</p>
          <h1>{eventId === null ? "Event not found" : (title.data ?? `Event #${eventId.toString()}`)}</h1>
          <p className="lede">Ticket payments are held in escrow by the TIMO contract — never paid straight to the organizer.</p>
        </div>
      </div>

      {!timo ? (
        <div className="card empty">
          No TIMO contract configured for {net.label}. Set <code>NEXT_PUBLIC_TIMO_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
        </div>
      ) : eventId === null ? (
        <div className="card empty">
          That event link doesn&apos;t look right. Go back to <Link href="/">Explore events</Link>.
        </div>
      ) : event.isLoading ? (
        <div className="card empty">Loading event…</div>
      ) : event.isError || !ev ? (
        <div className="notice bad" role="alert">
          <strong>Couldn&apos;t load this event</strong>
          <span>It may not exist on {net.label}, or the contract address is wrong.</span>
        </div>
      ) : (
        <div className="row">
          <section className="card stack" aria-label="Event information" style={{ flex: "1.3 1 420px" }}>
            <div className="check-top" style={{ alignItems: "baseline" }}>
              <h2>Event information</h2>
              <span className={`status-pill ${ev.status === 0 ? "good" : "warn"}`}>{ev.statusLabel}</span>
            </div>
            <dl className="kv">
              <dt>Price</dt>
              <dd>{formatTUSD8(ev.price)} tUSD8</dd>
              <dt>Tickets sold</dt>
              <dd>
                {ev.sold} / {ev.capacity}
              </dd>
              <dt>Escrow held</dt>
              <dd>{formatTUSD8(ev.escrow)} tUSD8</dd>
              <dt>Starts</dt>
              <dd>{formatDateTime(ev.startsAt)}</dd>
              <dt>Sales end</dt>
              <dd>{formatDateTime(ev.salesEnd)}</dd>
              <dt>Organizer</dt>
              <dd>{ev.organizer}</dd>
              <dt>Contract</dt>
              <dd>{timo}</dd>
            </dl>
            {ev.status === 1 && (
              <div className="notice warn" role="status">
                <strong>This event was cancelled</strong>
                <span>
                  Refunds are claimable by every current ticket owner from <Link href="/my-tickets">My Tickets</Link> — the full ticket price,
                  straight from escrow.
                </span>
              </div>
            )}
            {ev.status === 2 && (
              <div className="notice good" role="status">
                <strong>This event is completed</strong>
                <span>The organizer has withdrawn the escrow.</span>
              </div>
            )}
          </section>

          <section className="card stack" aria-label="Buy a ticket" style={{ flex: "1 1 340px" }}>
            <h2>Buy a ticket</h2>
            <p className="sub">
              Standard flow: approve the exact price, then buy. Your ticket is minted as an NFT and the {formatTUSD8(ev.price)} tUSD8 stays in
              escrow until the event completes.
            </p>
            <dl className="kv" style={{ fontSize: 13 }}>
              <dt>Your balance</dt>
              <dd>{balance.data !== undefined ? `${formatTUSD8(balance.data)} tUSD8` : "—"}</dd>
            </dl>
            {!salesOpen && ev.status === 0 && (
              <div className="notice warn" role="status">
                <strong>Sales are closed</strong>
                <span>{ev.sold >= ev.capacity ? "This event is sold out." : "The sales deadline has passed."}</span>
              </div>
            )}
            {salesOpen && !enoughBalance && (
              <div className="notice warn" role="status">
                <strong>Not enough tUSD8</strong>
                <span>This ticket needs {formatTUSD8(ev.price)} tUSD8. Get test tokens from the QDay faucet (see the Docs page).</span>
              </div>
            )}
            {error && (
              <div className="notice bad" role="alert">
                <strong>Purchase didn&apos;t go through</strong>
                <span>{error}</span>
              </div>
            )}
            {phase === "done" && (
              <div className="notice good" role="status">
                <strong>Ticket purchased</strong>
                <span>
                  Find it under <Link href="/my-tickets">My Tickets</Link>, with your check-in QR.
                  {net.hasExplorer && txHash && (
                    <>
                      {" "}
                      <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                        View transaction
                      </a>
                    </>
                  )}
                </span>
              </div>
            )}
            <button
              type="button"
              className="btn big block"
              disabled={!onChain || !salesOpen || busy || phase === "done" || !enoughBalance}
              onClick={onBuy}
            >
              {cta}
            </button>
            <p className="fine">The approval is for the exact ticket price, never unlimited. Gasless purchase (EIP-3009) is supported by the contract but not wired into this page yet.</p>
          </section>
        </div>
      )}
    </main>
  );
}
