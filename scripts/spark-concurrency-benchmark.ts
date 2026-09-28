import { spawn } from 'node:child_process';

type Job = { name: string; args: string[]; input?: string };

function sanitize(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]')
    .replace(/\b(?:nvapi-|sk-)[A-Za-z0-9_-]{8,}\b/giu, '[redacted]');
}

function run(job: Job): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, job.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 50_000) stderr += chunk.toString(); });
    child.once('error', (error) => resolve({
      name: job.name,
      status: 'FAIL',
      duration_ms: Math.round(performance.now() - started),
      safe_error: sanitize(error.message).slice(-500),
    }));
    child.once('close', (code) => resolve({
      name: job.name,
      status: code === 0 ? 'PASS' : 'FAIL',
      duration_ms: Math.round(performance.now() - started),
      safe_error: code === 0 ? null : sanitize(stderr.trim().split(/\r?\n/u).at(-1) || `exit ${code}`).slice(-500),
    }));
    child.stdin.end(job.input ?? '');
  });
}

const voice = (): Job => ({
  name: 'voice',
  args: ['--import', 'tsx', 'scripts/spark-realtime-bridge-smoke.ts', '--turns', '1'],
});
const coach = (): Job => ({
  name: 'coach',
  args: ['--import', 'tsx', 'scripts/spark-coach-benchmark.ts', '--once'],
});
const retriever = (): Job => ({
  name: 'retriever',
  args: ['--import', 'tsx', 'scripts/spark-retriever-smoke.ts'],
});
const closeout = (): Job => ({
  name: 'background_closeout',
  args: ['--import', 'tsx', 'scripts/nat-agent-runner.ts'],
  input: 'onboarding.closeout\n',
});

async function scenario(name: string, jobs: Job[]): Promise<Record<string, unknown>> {
  const started = performance.now();
  const results = await Promise.all(jobs.map(run));
  return {
    name,
    status: results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL',
    wall_ms: Math.round(performance.now() - started),
    jobs: results,
  };
}

const scenarios = [
  await scenario('Voice', [voice()]),
  await scenario('Voice + Coach', [voice(), coach()]),
  await scenario('Voice + Retriever', [voice(), retriever()]),
  await scenario('Voice + Coach + Retriever', [voice(), coach(), retriever()]),
  await scenario('Voice + background Closeout', [voice(), closeout()]),
  await scenario('2 sessions', [voice(), voice()]),
];

const status = scenarios.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL';
process.stdout.write(`${JSON.stringify({ status, scenarios })}\n`);
if (status !== 'PASS') process.exitCode = 1;
