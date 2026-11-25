import type { Metadata } from "next";
import { links, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { GitHubIcon } from "@/components/Icons";
import { defaultNetwork, repoUrl } from "@/lib/env";

export const metadata: Metadata = { title: "Docs" };

const TELEGRAM_URL = "https://t.me/Nyollo1";

const sections = [
  { id: "what", label: "What is TIMO" },
  { id: "buying", label: "Buying a ticket" },
  { id: "refunds", label: "Refunds & schedule changes" },
  { id: "checkin", label: "Check-in at the door" },
  { id: "organizers", label: "For organizers" },
  { id: "fees", label: "Fees & payouts" },
  { id: "safety", label: "How your money is protected" },
  { id: "demo", label: "Try the demo" },
  { id: "developers", label: "For developers" },
];

export default function DocsPage() {
  const timo = defaultNetwork.timo;

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Docs</p>
          <h1>How TIMO works</h1>
          <p className="lede">
            Everything about buying tickets, refunds, check-in and selling with TIMO — in plain language. Source code and
            technical documentation live in the GitHub repository.
          </p>
        </div>
        <a className="btn secondary" href={repoUrl} target="_blank" rel="noreferrer">
          <GitHubIcon />
          View the code on GitHub
        </a>
      </div>

      <div className="docs">
        <nav className="docs-toc" aria-label="On this page">
          <p className="docs-toc-title">On this page</p>
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </nav>

        <article className="docs-body">
          <section id="what">
            <h2>What is TIMO</h2>
            <p>
              TIMO (Ticket &amp; Invoice Management Onchain) is an <strong>official ticket agent</strong> on the Aevum
              network. Every ticket is an NFT you own in your wallet, paid for with the <strong>tUSD8</strong> stablecoin.
            </p>
            <p>
              Ticket money never goes to a person. It is held in <strong>escrow by the TIMO smart contract</strong> until
              the event has taken place — so buyers can always be refunded if an event is cancelled, and organizers are
              paid once their event actually happens. Organizers on TIMO are verified clients: every event is reviewed
              and published by TIMO, never self-published.
            </p>
          </section>

          <section id="buying">
            <h2>Buying a ticket</h2>
            <ol>
              <li>
                <strong>Connect your wallet</strong> with the button at the top of the page.
              </li>
              <li>
                <strong>Pick an event</strong> on Explore and open its page. You will see the organizer&apos;s name with a
                Verified Organizer label, the venue, and the ticket price in tUSD8.
              </li>
              <li>
                <strong>Confirm the purchase.</strong> Normally you only sign one authorization in your wallet — TIMO
                submits the transaction and pays the network fee for you, so you need tUSD8 but no gas token. If the
                gas-free service is ever unavailable, a standard payment option appears instead and you pay a small
                network fee yourself.
              </li>
              <li>
                <strong>Your ticket is in My Tickets</strong> — an NFT in your wallet, ready for check-in.
              </li>
            </ol>
            <ul>
              <li>There is no per-wallet purchase limit; one wallet can buy any number of tickets.</li>
              <li>Sales close at the sales end time shown on the event page. Event times are shown in the event&apos;s local time.</li>
              <li>
                You can send a ticket to another wallet with your wallet app if you wish — My Tickets always shows the
                tickets your wallet currently owns, and refunds always follow the current owner.
              </li>
            </ul>
          </section>

          <section id="refunds">
            <h2>Refunds &amp; schedule changes</h2>
            <h3>If an event is cancelled</h3>
            <p>
              Every ticket can be refunded <strong>in full</strong>. The refund goes to the wallet that owns the ticket at
              that moment. Claim it from <strong>My Tickets → the event → Claim refund</strong>: one claim per ticket, for
              exactly the ticket price. Claiming is a normal transaction, so you pay a small network fee for it.
            </p>
            <h3>If an event is rescheduled</h3>
            <p>
              Your ticket stays valid for the new date automatically. If the new time doesn&apos;t work for you, a{" "}
              <strong>7-day window</strong> opens from the moment the change is announced, during which you can claim a
              voluntary full refund the same way. After the window closes, the ticket simply follows the new schedule.
            </p>
            <p>Outside of cancellation and rescheduling, ticket sales are final.</p>
          </section>

          <section id="checkin">
            <h2>Check-in at the door</h2>
            <ol>
              <li>Open your ticket in <strong>My Tickets</strong> when you arrive.</li>
              <li>
                The ticket shows a <strong>QR code that refreshes every 60 seconds</strong> and is signed by your wallet —
                a screenshot won&apos;t work, so bring the wallet that holds the ticket.
              </li>
              <li>
                Event staff scan the code in TIMO&apos;s Organizer Studio. The contract verifies your signature against
                the ticket&apos;s owner, then marks the ticket <strong>checked in</strong> — it can never be used twice.
              </li>
            </ol>
            <p>Check-in opens at the door-open time set for each event, shown on the event page.</p>
          </section>

          <section id="organizers">
            <h2>For organizers</h2>
            <p>
              TIMO works as your official ticket agent. Organizers never publish events themselves — that keeps every
              event on the platform verified and trustworthy for buyers.
            </p>
            <ol>
              <li>
                <strong>Contact TIMO</strong> using the Telegram button in the{" "}
                <a href="/#contact">Contact section</a> on the home page.
              </li>
              <li>
                <strong>We verify your event together</strong> — venue, date and time, ticket price and capacity — and
                agree the terms, including the service fee.
              </li>
              <li>
                <strong>TIMO publishes the event for you.</strong> Your name appears on the event page with a Verified
                Organizer label, and sales open immediately.
              </li>
            </ol>
            <p>Each event has its own staff roles, fixed when the event is created and never changed afterwards:</p>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr>
                    <th scope="row">Boss organizer (1 wallet)</th>
                    <td>The event owner. Receives the payout after the event. Does not operate the door.</td>
                  </tr>
                  <tr>
                    <th scope="row">Admin organizers (1–3 wallets)</th>
                    <td>See sales, transactions and check-ins in Organizer Studio, and can scan tickets at the door.</td>
                  </tr>
                  <tr>
                    <th scope="row">Door staff (5–25 wallets)</th>
                    <td>Can only scan tickets at the door. They need no funds — TIMO covers the check-in network fees.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Once an event is published, its price, capacity, payout wallet, staff roles and fee <strong>never change</strong>.
              If your plans move, TIMO can adjust the schedule and the display details (image, description, venue) — and a
              schedule change automatically opens the 7-day refund window for your buyers, described above.
            </p>
          </section>

          <section id="fees">
            <h2>Fees &amp; payouts</h2>
            <ul>
              <li>
                TIMO charges a <strong>service fee per event, agreed before the event is published — 1% by default</strong> —
                and recorded in the contract, where anyone can check it.
              </li>
              <li>
                The fee is taken <strong>only at payout, never during sales</strong>. That is deliberate: if an event is
                cancelled, buyers can still be refunded every cent.
              </li>
              <li>
                <strong>24 hours after the event starts</strong>, TIMO releases the payout in a single transaction: the
                organizer&apos;s share goes to the boss organizer&apos;s wallet, and TIMO&apos;s fee goes to TIMO.
              </li>
            </ul>
          </section>

          <section id="safety">
            <h2>How your money is protected</h2>
            <ul>
              <li>
                <strong>The vault is the contract itself.</strong> Ticket money sits in the TIMO smart contract as
                per-event escrow. No person holds it, and no TIMO wallet can reach it.
              </li>
              <li>
                <strong>Exactly two ways out.</strong> Escrowed money can only ever leave as (1) a refund to a
                ticket&apos;s current owner, or (2) the one-time payout after the event. There is no admin withdrawal and
                no emergency drain — not even for TIMO.
              </li>
              <li>
                <strong>Check-in needs you there.</strong> A ticket can only be checked in with your fresh 60-second
                signature, verified by the contract — staff cannot check in a ticket without the owner standing at the
                door.
              </li>
              <li>
                <strong>Gas-free doesn&apos;t mean trust-based.</strong> When TIMO pays your network fee, its relayer can
                only submit the exact purchase or check-in you signed, for the exact amount you signed. It never holds
                your money, and it runs with rate limits and a daily spending cap.
              </li>
            </ul>
          </section>

          <section id="demo">
            <h2>Try the demo</h2>
            <p>
              This site runs on the <strong>Aevum testnet</strong> with test tokens — no real money is involved. To buy a
              demo ticket you need a wallet and some test tUSD8, which the QDay faucet gives out for free.
            </p>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr>
                    <th scope="row">Network</th>
                    <td>QDay Aevum Testnet, chain ID 44005 — your wallet can add it automatically when you connect.</td>
                  </tr>
                  <tr>
                    <th scope="row">Ticket currency</th>
                    <td>tUSD8, the Aevum testnet stablecoin.</td>
                  </tr>
                  <tr>
                    <th scope="row">Free test tokens</th>
                    <td>
                      From the <a href={links.faucetWeb} target="_blank" rel="noreferrer">QDay web faucet</a> or the
                      faucet bot in the QDay Discord.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">TIMO contract</th>
                    <td>
                      {timo ? (
                        <a href={`${links.explorer}/address/${timo}`} target="_blank" rel="noreferrer">
                          {timo}
                        </a>
                      ) : (
                        "See the home page for the live address."
                      )}{" "}
                      — every purchase, refund and check-in can be followed on the{" "}
                      <a href={links.explorer} target="_blank" rel="noreferrer">Aevum explorer</a>.
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">tUSD8 contract</th>
                    <td>
                      <a href={`${links.explorer}/address/${TUSD8_ADDRESS}`} target="_blank" rel="noreferrer">
                        {TUSD8_ADDRESS}
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="developers">
            <h2>For developers</h2>
            <p>
              TIMO is open source. The smart contract, its test suite, the architecture notes and the setup instructions
              live in the <a href={repoUrl} target="_blank" rel="noreferrer">GitHub repository</a> — that is the technical
              documentation. Questions about using TIMO as a buyer or organizer are answered fastest through the{" "}
              <a href={TELEGRAM_URL} target="_blank" rel="noreferrer">Contact button</a> on the home page.
            </p>
          </section>

          <p className="fine">
            TIMO — Ticket &amp; Invoice Management Onchain, built for the Aevum Builder Challenge #1. This demo runs on
            Aevum testnet; test tokens have no real-world value.
          </p>
        </article>
      </div>
    </main>
  );
}
