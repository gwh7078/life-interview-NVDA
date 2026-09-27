import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEraContextClientFromEnv } from '../src/era-context/client.js';
import { validateEraContextDataset } from '../src/era-context/validation.js';

const root = path.resolve(import.meta.dirname, '..');
const jobId = process.env.ERA_CONTEXT_JOB_ID?.trim();
if (!jobId) throw new Error('ERA_CONTEXT_JOB_ID is required.');
const datasetPath = process.argv[2] ?? path.join(root, 'data/era-context/era-context.zh-CN.jsonl');
const records = validateEraContextDataset(
  (await readFile(datasetPath, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
);
const client = createEraContextClientFromEnv(process.env);
const terminalStatuses = new Set(['completed', 'complete', 'indexed', 'ready', 'succeeded', 'success', 'partial_success', 'failed', 'error']);
const job = await client.getJob(jobId);
const failed = Array.isArray(job.documents)
  ? job.documents.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && item.status === 'failed'))
  : [];
const failedIds = new Set(failed
  .map((item) => typeof item.filename === 'string' ? item.filename.match(/^era-([a-f0-9]{64})\.json$/u)?.[1] : undefined)
  .filter((value): value is string => Boolean(value)));
const retryRecords = records.filter((record) => {
  const content = JSON.stringify(record);
  const id = createHash('sha256').update(content, 'utf8').digest('hex');
  return failedIds.has(id);
});
if (retryRecords.length === 0) {
  console.log(JSON.stringify({ originalJobId: jobId, failed: failed.length, retried: 0, status: 'nothing_to_retry' }));
  process.exit(0);
}
const startedAt = Date.now();
const result = await client.indexRecords(retryRecords);
let status = result.status;
let finalJob: Record<string, unknown> | undefined;
for (let attempt = 0; attempt < 600 && !terminalStatuses.has(status.toLowerCase()); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  finalJob = await client.getJob(result.jobId);
  status = typeof finalJob.status === 'string' ? finalJob.status : 'unknown';
  const counts = finalJob.counts && typeof finalJob.counts === 'object' ? JSON.stringify(finalJob.counts) : '{}';
  console.error(`ERA_CONTEXT_RETRY_POLL status=${status} counts=${counts} attempt=${attempt + 1}`);
}
if (!finalJob) finalJob = await client.getJob(result.jobId);
const counts = finalJob.counts && typeof finalJob.counts === 'object' ? finalJob.counts : {};
console.log(JSON.stringify({ originalJobId: jobId, failed: failed.length, retried: retryRecords.length, retryJobId: result.jobId, status, counts, latencyMs: Date.now() - startedAt }));
if (!terminalStatuses.has(status.toLowerCase()) || Number((counts as Record<string, unknown>).failed ?? 0) > 0) process.exitCode = 1;
