import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createEraContextClientFromEnv } from '../src/era-context/client.js';
import { validateEraContextDataset } from '../src/era-context/validation.js';
import type { EraContextRecord } from '../src/era-context/types.js';

const root = path.resolve(import.meta.dirname, '..');
const datasetPath = process.argv[2] ?? path.join(root, 'data/era-context/era-context.zh-CN.jsonl');
const records = validateEraContextDataset(
  (await readFile(datasetPath, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
);
const client = createEraContextClientFromEnv(process.env);
const startedAt = Date.now();
const existingJobId = process.env.ERA_CONTEXT_JOB_ID?.trim();
const result = existingJobId
  ? { jobId: existingJobId, documentIds: [], status: 'processing' }
  : await client.indexRecords(records as EraContextRecord[]);
const terminalStatuses = new Set(['completed', 'complete', 'indexed', 'ready', 'succeeded', 'success', 'partial_success', 'failed', 'error']);
let status = result.status;
let finalJob: Record<string, unknown> | undefined;
const maxAttempts = Number(process.env.ERA_CONTEXT_MAX_POLL_ATTEMPTS ?? 600);
for (let attempt = 0; attempt < maxAttempts && !terminalStatuses.has(status.toLowerCase()); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const job = await client.getJob(result.jobId);
  finalJob = job;
  status = typeof job.status === 'string' ? job.status : 'unknown';
  const counts = job.counts && typeof job.counts === 'object' ? JSON.stringify(job.counts) : '{}';
  console.error(`ERA_CONTEXT_INDEX_POLL status=${status} counts=${counts} attempt=${attempt + 1}`);
}
if (!finalJob && terminalStatuses.has(status.toLowerCase())) {
  finalJob = await client.getJob(result.jobId);
}
const counts = finalJob?.counts && typeof finalJob.counts === 'object' ? finalJob.counts as Record<string, unknown> : {};
const failedDocuments = typeof counts.failed === 'number' ? counts.failed : 0;
const output = {
  dataset: path.relative(root, datasetPath),
  records: records.length,
  jobId: result.jobId,
  documentsAccepted: result.documentIds.length,
  status,
  counts,
  failedDocuments,
  latencyMs: Date.now() - startedAt,
};
console.log(JSON.stringify(output));
if (!terminalStatuses.has(status.toLowerCase()) || failedDocuments > 0) process.exitCode = 1;
