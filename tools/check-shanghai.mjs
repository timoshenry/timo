#!/usr/bin/env node
// Fails if any contract compiled from contracts/src uses an opcode Aevum (Shanghai EVM) doesn't have.
// Usage: node tools/check-shanghai.mjs [contracts/out]
//
// The scan is a recursive-descent traversal, NOT a linear sweep: it only
// decodes bytes that are reachable as code (entry point, jump targets, and
// fall-through after conditional jumps). A linear sweep cannot tell code
// apart from the literal data segments solc appends to the bytecode (e.g.
// the Base64 alphabet string embedded for tokenURI), whose bytes are data,
// never executed opcodes — sweeping them produced false positives such as
// "BLOBHASH" for the ASCII letter 'I' (0x49) inside that string.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CANCUN_ONLY = { 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE", 0x5c: "TLOAD", 0x5d: "TSTORE", 0x5e: "MCOPY" };
const TERMINAL = new Set([0x00, 0xf3, 0xfd, 0xfe, 0xff]); // STOP, RETURN, REVERT, INVALID, SELFDESTRUCT
const outDir = process.argv[2] ?? "contracts/out";

function* artifacts(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* artifacts(p);
    else if (name.endsWith(".json")) yield p;
  }
}

// Walk reachable basic blocks. Returns Cancun-only opcodes found in code positions.
function findBad(hex) {
  const code = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (code.length === 0) return [];
  const metaLen = code.length >= 2 ? code.readUInt16BE(code.length - 2) + 2 : 0;
  const end = metaLen < code.length ? code.length - metaLen : code.length;
  const bad = [];
  const visited = new Uint8Array(end); // 1 = byte is part of a decoded instruction stream
  const worklist = [0];
  while (worklist.length) {
    let pc = worklist.pop();
    // Decode one basic block starting at pc.
    let lastPush = null; // value of the most recent PUSH in this block (jump targets in solc output)
    while (pc < end && !visited[pc]) {
      visited[pc] = 1;
      const op = code[pc];
      if (CANCUN_ONLY[op]) bad.push(`${CANCUN_ONLY[op]} at byte ${pc}`);
      if (op >= 0x60 && op <= 0x7f) {
        // PUSH1..PUSH32: skip its data bytes.
        const n = op - 0x5f;
        lastPush = 0n;
        for (let k = 1; k <= n && pc + k < end; k++) {
          visited[pc + k] = 1;
          lastPush = (lastPush << 8n) | BigInt(code[pc + k]);
        }
        pc += 1 + n;
        continue;
      }
      if (op === 0x5f) lastPush = 0n; // PUSH0
      pc += 1;
      if (op === 0x56 || op === 0x57) {
        // JUMP / JUMPI: enqueue the constant target; JUMPI also falls through.
        if (lastPush !== null && lastPush < BigInt(end)) worklist.push(Number(lastPush));
        if (op === 0x57) continue; // fall-through: keep decoding this block
        break; // JUMP ends the block
      }
      if (TERMINAL.has(op)) break;
    }
  }
  return bad;
}

let checked = 0;
let failed = 0;
for (const file of artifacts(outDir)) {
  const a = JSON.parse(readFileSync(file, "utf8"));
  const source = Object.keys(a.metadata?.settings?.compilationTarget ?? {})[0] ?? "";
  if (!source.startsWith("src/")) continue; // only our contracts, not forge-std/test helpers
  for (const [kind, hex] of [["runtime", a.deployedBytecode?.object], ["creation", a.bytecode?.object]]) {
    if (!hex || hex === "0x") continue;
    checked++;
    const bad = findBad(hex);
    if (bad.length) {
      failed++;
      console.error(`✗ ${source} (${kind}): ${bad.join(", ")}`);
    }
  }
}
if (checked === 0) {
  console.error(`No artifacts from src/ found in ${outDir}. Run \`forge build\` first.`);
  process.exit(1);
}
if (failed) {
  console.error("\nThese opcodes don't exist on Aevum. Set evm_version = \"shanghai\" in foundry.toml.");
  process.exit(1);
}
console.log(`✓ ${checked} bytecode blobs checked: Shanghai-safe.`);
