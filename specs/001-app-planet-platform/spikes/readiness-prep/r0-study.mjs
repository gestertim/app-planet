import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync, gzipSync } from 'node:zlib';

// R0 offline fixtures only: no application execution, network, or provider SDK.
const seed = 'app-planet-r0-2026-10-22';
const cases = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const record = (id, input, output) => {
  assert.ok(cases.length < 20, 'R0 case limit');
  cases.push({ id, input, output });
};
const chunk = (type, data) => {
  const label = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([size, label, data, checksum]);
};
const png = (width, height, initialState) => {
  let state = initialState;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= width * 3; x++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[y * (1 + width * 3) + x] = state & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
const padded = (text, kib) => {
  const start = Buffer.from(text);
  assert.ok(start.length <= kib * 1024);
  return Buffer.concat([start, Buffer.alloc(kib * 1024 - start.length, ' ')]);
};
const fixtures = [];
for (const [kind, jsKiB, jsonKiB, imageCount, side] of [
  ['A', 64, 8, 8, 320], ['B', 80, 24, 4, 256],
]) {
  const files = [
    ['index.html', 'text/html', padded('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>R0 synthetic fixture</title><body>R0 fixture only</body></html>', 32)],
    ['style.css', 'text/css', padded('body { color: #123; }\n', 24)],
    ['main.js', 'text/javascript', padded('// Inert fixture: no application logic or API calls.\n', jsKiB)],
    ['data.json', 'application/json', padded(JSON.stringify(kind === 'A'
      ? { cards: Array.from({ length: imageCount }, (_, i) => ({ image: `images/${i}.png`, label: `synthetic-${i}` })) }
      : { options: ['leaf', 'cloud', 'stone', 'flower'], counts: [0, 0, 0, 0], identity: false }), jsonKiB)],
    ...Array.from({ length: imageCount }, (_, i) => [`images/${i}.png`, 'image/png', png(side, side, 1000 + i)]),
  ];
  const manifest = files.map(([name, mime, bytes]) => ({
    name, mime, bytes: bytes.length, sha256: sha256(bytes), gzipBytes: gzipSync(bytes).length,
  }));
  const totalBytes = manifest.reduce((sum, file) => sum + file.bytes, 0);
  const independentGzipBytes = manifest.reduce((sum, file) => sum + file.gzipBytes, 0);
  const output = {
    manifest, fileCount: files.length, totalBytes,
    maxFileBytes: Math.max(...manifest.map(file => file.bytes)),
    independentGzipBytes, independentGzipRatio: totalBytes / independentGzipBytes,
    proposed16MiBHeadroom: 16 * 1024 ** 2 / totalBytes,
    withinProposedByteAndCountCaps: manifest.every(file => file.bytes <= 2 * 1024 ** 2)
      && totalBytes <= 16 * 1024 ** 2 && files.length <= 256,
    archiveFormatTested: false, buildExecuted: false, applicationComplete: false,
  };
  fixtures.push(output);
  record(`W1-${kind}`, { side, imageCount, textKiB: [32, 24, jsKiB, jsonKiB], pixelSeed: 1000 }, output);
}
const html = padded('<!doctype html><title>R0 whitespace compression counterexample</title><p>synthetic</p>', 128);
const compressed = gzipSync(html);
assert.ok(html.length / compressed.length > 100);
record('PP20-compression-counterexample', { bytes: html.length, syntax: 'HTML followed by whitespace' }, {
  gzipBytes: compressed.length, ratio: html.length / compressed.length,
  exceedsCandidateRatio100: true, archivePolicyCompatibilityUnknown: true,
});
record('C80-continuous', { lessonMinutes: [40, 40], breakMinutes: 10, cleanupMinutes: 10, lastInteractionMinute: 40 }, {
  activeMinutes: 80, elapsedMinutes: 90, illustrativeAbsoluteMinutes: 100,
  idleExpiryMinutes: { idle5: 45, idle10: 50 }, resumeMinute: 50,
  idle10BoundaryNeedsExplicitRule: true, teacherReviewMinutes: null,
});
record('C80-split', { lessonStarts: [0, 50], lessonMinutes: 40, orientationMinutesPerLesson: 5, reviewMinutesPerLesson: 5, cyclesPerLesson: 3 }, {
  illustrativeSessionAbsoluteMinutesEach: 50,
  illustrativeCycleBudgetSeconds: (40 - 5 - 5) * 60 / 3,
  budgetMustAlsoCover: ['AI', 'editing', 'queue', 'build', 'retrieval', 'validation', 'binding', 'browser-load', 'recovery'],
  measuredBuildTimeoutSeconds: null, breakRevocationApproved: false,
});
for (const serviceSeconds of [5, 15, 30]) {
  for (const concurrency of [1, 4, 10, 20]) {
    const waits = Array.from({ length: 20 }, (_, i) => Math.floor(i / concurrency) * serviceSeconds);
    const completions = waits.map(wait => wait + serviceSeconds);
    const p95 = values => values[Math.ceil(0.95 * values.length) - 1];
    record(`L1-s${serviceSeconds}-c${concurrency}`, {
      arrivals: 20, arrivalSeconds: 0, concurrency, serviceSeconds, discipline: 'FIFO',
      assumptions: 'identical total service, no failures, no rate limit or shared bottleneck',
    }, {
      queueP95Seconds: p95(waits), endToEndP50Seconds: completions[9],
      endToEndP95Seconds: p95(completions), maxSeconds: completions[19],
      simulatedErrorRate: 0, measuredErrorRate: null,
    });
  }
}
record('W1-B-distinct-workload', {
  works: 20, optionsPerWork: 4, logicalBytesPerRow: 256,
  readsPerWork: 30, writesPerWork: 5, readResponseBytes: 1024, writeResponseBytes: 256,
}, {
  logicalRows: 80, logicalBytes: 20 * 4 * 256,
  requests: 20 * (30 + 5), responseBodyBytes: 20 * (30 * 1024 + 5 * 256),
  totalMiBFor20ABundles: 20 * fixtures[0].totalBytes / 1024 ** 2,
  totalMiBFor20BBundles: 20 * fixtures[1].totalBytes / 1024 ** 2,
  physicalDatabaseAndAuthorizationOverheadBytes: null,
  scope: 'L1 distinct namespaces, not L3 shared-work atomicity',
});
record('RA1-compute-envelope', {
  elapsedHours: 48, conservativeBillableHours: 49, microUSDPerHour: 0.01344,
  assumedProSubscriptionUSD: 25, assumedSingleCycleComputeCreditUSD: 10,
}, {
  grossComputeUSD: 49 * 0.01344,
  conditionalKnownSubtotalUSD: 25 + Math.max(0, 49 * 0.01344 - 10),
  completeUpperBoundUSD: null, taxUSD: null, cleanupTailMonths: null,
});
record('RX12-iad1-compute-envelope', {
  creations: 12, vcpus: 2, memoryGB: 4, activeSecondsEach: 600,
  conservativeMemoryMinutesEach: 11, cpuUSDPerHour: 0.128,
  memoryUSDPerGBHour: 0.0212, creationUSD: 0.60 / 1e6,
  sourceRegion: 'iad1 only; not an APAC quote',
}, {
  grossComputeAndCreationUSD: 12 * (2 * 600 / 3600 * 0.128 + 4 * 11 / 60 * 0.0212 + 0.60 / 1e6),
  persistenceMustBeExplicitlyDisabled: true,
  deployingBackupMayNeedAdditionalSeat: true,
  completeUpperBoundUSD: null, taxUSD: null, cleanupTailMonths: null,
});
assert.equal(cases.length, 20);
assert.equal(cases.find(item => item.id === 'L1-s15-c4').output.endToEndP95Seconds, 75);
assert.equal(cases.find(item => item.id === 'L1-s30-c10').output.endToEndP95Seconds, 60);
assert.ok(fixtures.every(item => item.withinProposedByteAndCountCaps));
const result = {
  seed, generatedAt: new Date().toISOString(), node: process.version,
  kind: 'R0 offline synthetic evidence; not product validation or policy',
  caseCount: cases.length, runsPerCase: 1, providerCalls: 0, cases,
};
writeFileSync(new URL('./r0-results.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  caseCount: cases.length,
  fixtures: fixtures.map(({ fileCount, totalBytes, maxFileBytes, independentGzipRatio, proposed16MiBHeadroom }) =>
    ({ fileCount, totalBytes, maxFileBytes, independentGzipRatio, proposed16MiBHeadroom })),
  compression: cases[2].output, RA1: cases[18].output, RX12: cases[19].output,
}, null, 2));
