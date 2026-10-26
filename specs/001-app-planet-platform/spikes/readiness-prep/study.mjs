import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// Offline sensitivity study, not an implementation of product controls.
const fixtures = {
  seed: 'app-planet-readiness-2026-10-22-v1',
  nat: { actors: 30, fixedWindowLimit: 20, burstCapacity: 30, refillPerSecond: 0.5 },
  corpus: [
    { name: 'A-small', files: 4, bytesPerFile: 8192 },
    { name: 'A-media', files: 12, bytesPerFile: 65536 },
    { name: 'B-small', files: 24, bytesPerFile: 16384 },
    { name: 'B-large', files: 160, bytesPerFile: 32768 },
  ],
  queue: { arrivals: 20, concurrency: [1, 4, 10, 20], serviceSeconds: [5, 15, 30] },
  classroom: { students: 100, days: 20 },
  sandboxScenarios: [
    { name: 'low', jobsPerDay: 3, minutes: 2, activeFraction: 0.3 },
    { name: 'base', jobsPerDay: 6, minutes: 4, activeFraction: 0.5 },
    { name: 'high', jobsPerDay: 10, minutes: 8, activeFraction: 1 },
  ],
  sandboxResources: [{ vcpus: 1, memoryGB: 2 }, { vcpus: 2, memoryGB: 4 }],
  agent: { inputTokens: 25000, outputTokens: 4000, rounds: [1, 3, 6], cacheFractions: [0, 0.5, 0.8] },
  workData: { works: 20, rowsPerWork: 100, bytesPerRow: 512, readsPerWork: 40, writesPerWork: 10 },
  boundExample: { cacheMs: 300, replicationMs: 150, inFlightMs: 100, clockErrorMs: 50 },
  overlapExample: { tokenLifetimeSeconds: 120, clockErrorSeconds: 10, propagationSeconds: 30 },
  researchEnvelope: { creations: 100, vcpus: 2, memoryGB: 4, intendedMinutes: 10, worstHours: 24 },
};

const prices = {
  verifiedDate: '2026-10-22',
  currency: 'USD',
  vercelIad1: { activeCpuHour: 0.128, memoryGBHour: 0.0212, creation: 0.60 / 1000000 },
  e2b: { cpuSecond: 0.000014, memoryGiBSecond: 0.0000045, proMonth: 150 },
  modelsPerMillion: {
    'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.50 },
    'gpt-6.1-sol': { input: 2, cached: 0.10, output: 10 },
    'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  },
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const round = value => Number(value.toFixed(6));
const nearestRank = (values, percentile) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
};

const nat = {
  simultaneousAttempts: fixtures.nat.actors,
  illustrativeFixedWindow: {
    accepted: Math.min(fixtures.nat.actors, fixtures.nat.fixedWindowLimit),
    rejected: Math.max(0, fixtures.nat.actors - fixtures.nat.fixedWindowLimit),
  },
  documentedTokenBucketModel: {
    firstBurstAccepted: Math.min(fixtures.nat.actors, fixtures.nat.burstCapacity),
    additionalAttemptsAt10Seconds: 10,
    additionalAccepted: Math.min(10, Math.floor(10 * fixtures.nat.refillPerSecond)),
  },
};
assert.equal(nat.illustrativeFixedWindow.rejected, 10);
assert.equal(nat.documentedTokenBucketModel.firstBurstAccepted, 30);
assert.equal(nat.documentedTokenBucketModel.additionalAccepted, 5);

const corpus = fixtures.corpus.map(item => {
  const file = Buffer.alloc(item.bytesPerFile, 'synthetic-text-only;');
  return {
    ...item,
    totalBytes: file.length * item.files,
    totalGzipBytes: gzipSync(file).length * item.files,
    fileSha256: sha256(file),
  };
});
assert.equal(corpus[3].totalBytes, 5242880);
assert.ok(corpus.every(item => item.totalBytes > item.totalGzipBytes));

const queue = fixtures.queue.serviceSeconds.flatMap(serviceSeconds =>
  fixtures.queue.concurrency.map(concurrency => {
    const waits = Array.from({ length: fixtures.queue.arrivals }, (_, i) => Math.floor(i / concurrency) * serviceSeconds);
    const completions = waits.map(wait => wait + serviceSeconds);
    return {
      serviceSeconds, concurrency, arrivals: fixtures.queue.arrivals,
      waitP95Seconds: nearestRank(waits, 0.95),
      endToEndP50Seconds: nearestRank(completions, 0.5),
      endToEndP95Seconds: nearestRank(completions, 0.95),
      endToEndMaxSeconds: Math.max(...completions),
      assumedErrorCount: 0,
    };
  }),
);
assert.equal(queue.find(row => row.serviceSeconds === 15 && row.concurrency === 4).endToEndP95Seconds, 75);
assert.equal(queue.find(row => row.serviceSeconds === 15 && row.concurrency === 20).endToEndP95Seconds, 15);

const sandbox = fixtures.sandboxScenarios.flatMap(scenario =>
  fixtures.sandboxResources.map(resource => {
    const jobs = fixtures.classroom.students * fixtures.classroom.days * scenario.jobsPerDay;
    const hours = jobs * scenario.minutes / 60;
    const cpu = hours * resource.vcpus * scenario.activeFraction * prices.vercelIad1.activeCpuHour;
    const memory = jobs * Math.max(1, scenario.minutes) / 60 * resource.memoryGB * prices.vercelIad1.memoryGBHour;
    const creation = jobs * prices.vercelIad1.creation;
    const e2bUsage = hours * 3600 * (
      resource.vcpus * prices.e2b.cpuSecond + resource.memoryGB * prices.e2b.memoryGiBSecond
    );
    return {
      scenario: scenario.name, ...resource, jobs, hours,
      vercelIad1CpuUSD: round(cpu), vercelIad1MemoryUSD: round(memory),
      vercelIad1CreationUSD: round(creation), vercelIad1UsageUSD: round(cpu + memory + creation),
      e2bUsageUSD: round(e2bUsage), e2bWithProMonthUSD: round(e2bUsage + prices.e2b.proMonth),
    };
  }),
);
assert.equal(sandbox.find(row => row.scenario === 'base' && row.vcpus === 2).vercelIad1UsageUSD, 170.2472);

const agent = Object.entries(prices.modelsPerMillion).flatMap(([model, price]) =>
  fixtures.agent.cacheFractions.flatMap(cacheFraction =>
    fixtures.agent.rounds.map(rounds => ({
      model, cacheFraction, rounds,
      modeledTaskUSD: round(rounds * (
        fixtures.agent.inputTokens * ((1 - cacheFraction) * price.input + cacheFraction * price.cached)
        + fixtures.agent.outputTokens * price.output
      ) / 1000000),
      actualModelCalls: 0,
      completedAOrBWorks: null,
    })),
  ),
);
assert.equal(agent.find(row => row.model === 'gpt-5.3-codex' && row.cacheFraction === 0.8 && row.rounds === 3).modeledTaskUSD, 0.20475);

const workData = {
  logicalBytes: fixtures.workData.works * fixtures.workData.rowsPerWork * fixtures.workData.bytesPerRow,
  requests: fixtures.workData.works * (fixtures.workData.readsPerWork + fixtures.workData.writesPerWork),
  excluded: ['indexes', 'row metadata', 'backups', 'retained previews', 'egress', 'provider request charges'],
};
assert.equal(workData.logicalBytes, 1024000);
assert.equal(workData.requests, 1000);

const revocationBound = {
  assumedComponents: fixtures.boundExample,
  additiveIllustrationMs: Object.values(fixtures.boundExample).reduce((sum, value) => sum + value, 0),
  cacheOnlyClaimMs: fixtures.boundExample.cacheMs,
  productionBoundProven: false,
};
assert.equal(revocationBound.additiveIllustrationMs, 600);
assert.ok(revocationBound.additiveIllustrationMs > revocationBound.cacheOnlyClaimMs);
const rotation = {
  assumedComponents: fixtures.overlapExample,
  minimumOverlapAfterLastOldIssuanceSeconds:
    fixtures.overlapExample.tokenLifetimeSeconds + fixtures.overlapExample.clockErrorSeconds + fixtures.overlapExample.propagationSeconds,
  realKeyGenerationCount: 0,
  productionRotationProven: false,
};
assert.equal(rotation.minimumOverlapAfterLastOldIssuanceSeconds, 160);

const envelope = fixtures.researchEnvelope;
const hourlyMaximum = envelope.vcpus * prices.vercelIad1.activeCpuHour + envelope.memoryGB * prices.vercelIad1.memoryGBHour;
const researchEnvelope = {
  intendedSandboxOnlyUSD: round(envelope.creations * (hourlyMaximum * envelope.intendedMinutes / 60 + prices.vercelIad1.creation)),
  allAt24HoursSandboxOnlyUSD: round(envelope.creations * (hourlyMaximum * envelope.worstHours + prices.vercelIad1.creation)),
  twoVercelProPlusOneSupabaseMicroMonthUSD: 20 + 20 + 25,
  completeCostUpperBoundUSD: null,
  excluded: ['APAC regional prices', 'worker', 'domains', 'traffic', 'storage', 'tax', 'cleanup failure beyond envelope'],
};
assert.equal(researchEnvelope.intendedSandboxOnlyUSD, 5.68006);
assert.equal(researchEnvelope.allAt24HoursSandboxOnlyUSD, 817.92006);

const output = {
  schemaVersion: 1,
  scope: 'offline-synthetic-research-not-product-acceptance',
  executedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  sourceSha256: sha256(readFileSync(new URL(import.meta.url))),
  fixturesSha256: sha256(JSON.stringify(fixtures)),
  fixtures, prices,
  result: { nat, corpus, queue, sandbox, agent, workData, revocationBound, rotation, researchEnvelope },
  limitations: [
    'No network requests, provider accounts, credentials, product dependencies, or real child data.',
    'Corpus contains repetitive synthetic text, not representative images or actual A/B work bundles.',
    'Queue service times and zero errors are assumptions, not measured latency or availability.',
    'Prices are public list rates; regional prices, fixed costs and excluded components prevent a total cost bound.',
    'All policy numbers remain unapproved. No S-01 through S-15 or formal product matrix is marked passed.',
  ],
};
writeFileSync(new URL('./results.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify({
  scope: output.scope,
  fixturesSha256: output.fixturesSha256,
  nat, corpus: corpus.map(({ name, totalBytes, totalGzipBytes }) => ({ name, totalBytes, totalGzipBytes })),
  baseSandbox: sandbox.filter(row => row.scenario === 'base'),
  queue15Seconds: queue.filter(row => row.serviceSeconds === 15),
  workData, revocationBound, rotation, researchEnvelope,
}, null, 2));
