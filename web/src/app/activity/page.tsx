"use client";

import { getLogsChunked, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { getAbiItem, type Hash, type PublicClient } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { useNetwork } from "@/lib/network";
import { formatTUSD8, readEvent, scanFromBlock, timoAbi } from "@/lib/timo";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO = "0x0000000000000000000000000000000000000000";

interface Row {
  kind: "Bought" | "Refund claimed" | "Transferred out";
  eventId: bigint;
  eventName: string;
  tokenId: bigint;
  detail: string;
  txHash: Hash;
  block: bigint;
}

export default function ActivityPage() {
  const { net } = useNetwork();
  const timo = net.timo;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const { address, isConnected } = useAccount();

  const rows = useQuery({
    queryKey: ["timo-activity", net.chain.id, timo, address],
    enabled: Boolean(client && timo && address),
    queryFn: async (): Promise<Row[]> => {
      const head = await client!.getBlockNumber();
      const fromBlock = scanFromBlock(head, net.deployBlock);
      const nameCache = new Map<string, string>();
      const nameOf = async (eventId: bigint): Promise<string> => {
        const key = eventId.toString();
        if (!nameCache.has(key)) {
          try {
            const ev = await readEvent(client!, timo!, eventId);
            nameCache.set(key, ev.name || `Event #${key}`);
          } catch {
            nameCache.set(key, `Event #${key}`);
          }
        }
        return nameCache.get(key)!;
      };
      const out: Row[] = [];

      const buys = await getLogsChunked(client!, {
        address: timo!,
        event: getAbiItem({ abi: timoAbi, name: "TicketPurchased" }),
        args: { buyer: address! },
        fromBlock,
        toBlock: head,
      });
      for (const l of buys) {
        const a = l.args as any;
        out.push({
          kind: "Bought",
          eventId: a.eventId,
          eventName: await nameOf(a.eventId),
          tokenId: a.tokenId,
          detail: `${formatTUSD8(a.price)} tUSD8`,
          txHash: l.transactionHash,
          block: l.blockNumber ?? 0n,
        });
      }

      const refunds = await getLogsChunked(client!, {
        address: timo!,
        event: getAbiItem({ abi: timoAbi, name: "RefundClaimed" }),
        args: { owner: address! },
        fromBlock,
        toBlock: head,
      });
      for (const l of refunds) {
        const a = l.args as any;
        out.push({
          kind: "Refund claimed",
          eventId: 0n,
          eventName: "—",
          tokenId: a.tokenId,
          detail: `${formatTUSD8(a.amount)} tUSD8 back`,
          txHash: l.transactionHash,
          block: l.blockNumber ?? 0n,
        });
      }

      const transfers = await getLogsChunked(client!, {
        address: timo!,
        event: getAbiItem({ abi: timoAbi, name: "Transfer" }),
        args: { from: address! },
        fromBlock,
        toBlock: head,
      });
      for (const l of transfers) {
        const a = l.args as any;
        if (!a.to || a.to === ZERO) continue; // burns are refunds, already listed
        out.push({
          kind: "Transferred out",
          eventId: 0n,
          eventName: "—",
          tokenId: a.tokenId,
          detail: `to ${short(a.to)}`,
          txHash: l.transactionHash,
          block: l.blockNumber ?? 0n,
        });
      }

      return out.sort((x, y) => (y.block > x.block ? 1 : -1));
    },
  });

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">TIMO · Activity</p>
          <h1>Activity</h1>
          <p className="lede">Your TIMO history: tickets bought, refunds claimed, and tickets transferred out — each with its transaction hash.</p>
        </div>
        {rows.data && (
          <div className="score">
            <span className="score-num">{rows.data.length}</span>
            <span className="fine">entries</span>
          </div>
        )}
      </div>

      {!timo ? (
        <div className="card empty">No TIMO contract configured for {net.label}.</div>
      ) : !isConnected ? (
        <div className="card empty">Connect your wallet to see your activity.</div>
      ) : rows.isLoading ? (
        <div className="card empty">Scanning your activity…</div>
      ) : rows.isError ? (
        <div className="notice bad" role="alert">
          <strong>Couldn&apos;t load activity</strong>
          <span>Reading your logs failed. Check the network and reload.</span>
        </div>
      ) : (rows.data ?? []).length === 0 ? (
        <div className="card empty">
          Nothing yet. Buy a ticket from <Link href="/">Explore</Link> and it will appear here.
        </div>
      ) : (
        <section className="card flush">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Event</th>
                  <th>Ticket</th>
                  <th>Detail</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {(rows.data ?? []).map((r, i) => (
                  <tr key={`${r.txHash}-${i}`}>
                    <td>{r.kind}</td>
                    <td>
                      {r.eventId > 0n ? <Link href={`/event/${r.eventId.toString()}`}>{r.eventName}</Link> : r.eventName}
                    </td>
                    <td className="mono">#{r.tokenId.toString()}</td>
                    <td>{r.detail}</td>
                    <td>
                      {net.hasExplorer ? (
                        <a href={txUrl(r.txHash)} target="_blank" rel="noreferrer" className="mono">
                          {short(r.txHash)}
                        </a>
                      ) : (
                        <span className="mono">{short(r.txHash)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
