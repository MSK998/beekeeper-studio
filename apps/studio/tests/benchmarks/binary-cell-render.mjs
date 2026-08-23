// Benchmark for the large-binary cell rendering pipeline stages.
//
//   yarn bench:binary
//   node tests/benchmarks/binary-cell-render.mjs [--sizes=64k,1m,10m] [--iters=30]
//
// Stages measured (per single cell value):
//   - old-render-hex     : what happened before — convert the WHOLE buffer to hex,
//                          then _.truncate(256). This is the UI-lockup culprit.
//   - new-render-hex     : current behavior — slice ~128 leading bytes, convert, truncate.
//   - old/new-render-b64 : base64 equivalents.
//   - transcoder-view    : GenericBinaryTranscoder.serialize (Buffer -> Uint8Array view).
//   - ipc-clone          : structuredClone of the Uint8Array (renderer transfer cost).
//   - deserialize-copy   : Buffer.from(uint8) (write-back direction).

import 'core-js/actual/typed-array/to-hex.js';
import 'core-js/actual/typed-array/to-base64.js';
import { hrtime } from 'node:process';

const args = process.argv.slice(2);
const sizesArg = args.find((a) => a.startsWith('--sizes='))?.split('=')[1] ?? '64k,1m,10m';
const iters = parseInt(args.find((a) => a.startsWith('--iters='))?.split('=')[1] ?? '20', 10);

const SIZES = sizesArg.split(',').map((s) => {
  const num = parseInt(s, 10);
  if (s.endsWith('k')) return num * 1024;
  if (s.endsWith('m')) return num * 1024 * 1024;
  return num;
});

function truncateLodashStyle(str, length) {
  return str.length > length ? `${str.slice(0, length - 3)}...` : str;
}

const HEX_PREVIEW_BYTES = Math.ceil(256 / 2);
const B64_PREVIEW_BYTES = Math.floor(256 / 4) * 3;

function makeValue(byteLength) {
  const buf = Buffer.alloc(byteLength);
  // pseudorandom-ish content so conversions do real work on varied bytes
  let seed = 42;
  for (let i = 0; i < byteLength; i += 4096) {
    seed = (seed * 1103515245 + 12345) % 2147483647;
    buf[i] = seed % 256;
  }
  return buf;
}

async function measure(fn, value, iterations) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = hrtime.bigint();
    await fn(value);
    times.push(Number(hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

const stages = [
  ['old-render-hex', async (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    truncateLodashStyle(u8.toHex(), 256);
  }],
  ['new-render-hex', async (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    truncateLodashStyle(u8.subarray(0, HEX_PREVIEW_BYTES).toHex(), 256);
  }],
  ['old-render-b64', async (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    truncateLodashStyle(u8.toBase64(), 256);
  }],
  ['new-render-b64', async (buf) => {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    truncateLodashStyle(u8.subarray(0, B64_PREVIEW_BYTES).toBase64(), 256);
  }],
  ['transcoder-view', async (buf) => {
    new Uint8Array(buf.buffer, 0, buf.byteLength);
  }],
  ['ipc-clone', async (buf) => {
    structuredClone(new Uint8Array(buf.buffer, 0, buf.byteLength));
  }],
  ['deserialize-copy', async (buf) => {
    const u8 = new Uint8Array(buf.buffer, 0, buf.byteLength);
    Buffer.from(u8.buffer, 0, u8.byteLength);
  }],
];

console.log(`Binary cell rendering benchmark — median of ${iters} iterations per stage\n`);
console.log('size'.padEnd(10)
  + 'stage'.padEnd(20)
  + 'ms/op'.padStart(12)
  + 'ops/sec'.padStart(12));

for (const size of SIZES) {
  console.log('-'.repeat(54));
  for (const [name, fn] of stages) {
    const value = makeValue(size);
    await measure(fn, value, 2); // warmup
    const ms = await measure(fn, value, iters);
    const opsSec = ms > 0 ? 1000 / ms : Infinity;
    console.log(`${(size >= 1024 * 1024 ? `${size / 1024 / 1024}MB` : `${size / 1024}KB`).padEnd(10)}`
      + name.padEnd(20)
      + ms.toFixed(3).padStart(12)
      + opsSec.toFixed(1).padStart(12));
  }
}

console.log('\nNotes:');
console.log(' - Tabulator re-runs formatters for every visible cell on each redraw/scroll,');
console.log('   so old-render costs multiply by visible rows x columns.');
console.log(' - ipc-clone happens once per row per fetch; render stages happen per redraw.');
