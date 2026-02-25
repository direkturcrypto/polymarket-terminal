import { performance } from 'node:perf_hooks';

const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:18789';
const samples = Number.parseInt(process.env.SAMPLES ?? '200', 10);
const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '10', 10);
const maxP95Ms = Number.parseFloat(process.env.MAX_P95_MS ?? '250');

if (!Number.isFinite(samples) || samples <= 0) {
  throw new Error('SAMPLES must be a positive integer');
}

if (!Number.isFinite(concurrency) || concurrency <= 0) {
  throw new Error('CONCURRENCY must be a positive integer');
}

const target = `${baseUrl.replace(/\/$/, '')}/api/v1/health`;

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function singleProbe() {
  const start = performance.now();
  const response = await fetch(target, { cache: 'no-store' });
  const duration = performance.now() - start;

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Health probe failed (${response.status}): ${body}`);
  }

  await response.text();
  return duration;
}

async function run() {
  console.log(`Benchmarking ${target} with ${samples} samples @ concurrency ${concurrency}`);

  const latencies = [];
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < samples) {
      const index = cursor;
      cursor += 1;
      if (index >= samples) {
        return;
      }

      const duration = await singleProbe();
      latencies.push(duration);
    }
  });

  await Promise.all(workers);

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const avg = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

  console.log(
    `Results ms -> avg: ${avg.toFixed(2)}, p50: ${p50.toFixed(2)}, p95: ${p95.toFixed(2)}, p99: ${p99.toFixed(2)}`,
  );

  if (p95 > maxP95Ms) {
    console.error(`p95 ${p95.toFixed(2)}ms exceeds threshold ${maxP95Ms.toFixed(2)}ms`);
    process.exit(1);
  }

  console.log(`p95 ${p95.toFixed(2)}ms is within threshold ${maxP95Ms.toFixed(2)}ms`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
