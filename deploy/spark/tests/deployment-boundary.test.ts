import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sparkRoot = resolve(repoRoot, 'deploy/spark');

function read(relativePath: string): string {
  return readFileSync(resolve(sparkRoot, relativePath), 'utf8');
}

function assertNoRuntimeLifecycle(source: string, file: string): void {
  assert.doesNotMatch(source, /\bdocker\s+(?:pull|run|start|stop|rm|restart)\b/i, file);
  assert.doesNotMatch(source, /\bvllm\s+serve\b/i, file);
  assert.doesNotMatch(source, /\b(?:apt-get|apt|dnf|yum|pip)\s+install\b/i, file);
}

test('check-env only checks host prerequisites and all external Runtime endpoints', () => {
  const source = read('check-env.sh');
  for (const expected of [
    'uname -m', 'nvidia-smi', 'docker', 'TEXT_MODEL_BASE_URL',
    'REALTIME_COACH_BASE_URL', 'STEPAUDIO2_LOCAL_WS_URL',
    'NEMO_RETRIEVER_BASE_URL', 'NEMO_RETRIEVER_VECTORDB_URL',
    'EXTERNAL RUNTIME NOT READY',
  ]) assert.ok(source.includes(expected), `check-env.sh should check ${expected}`);
  assertNoRuntimeLifecycle(source, 'check-env.sh');
  assert.doesNotMatch(source, /\b(?:systemctl|launchctl|pkill|kill)\b/i);
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:sudo\s+)?bash/i);
});

test('Spark profile names served models and points each product contract at its endpoint', () => {
  const env = read('env.example');
  for (const expected of [
    'TEXT_MODEL_PROVIDER=openai-compatible',
    'TEXT_MODEL_BASE_URL=http://127.0.0.1:8000/v1',
    'TEXT_MODEL=',
    'REALTIME_COACH_PROVIDER=openai-compatible',
    'REALTIME_COACH_BASE_URL=http://127.0.0.1:8001/v1',
    'REALTIME_COACH_MODEL=',
    'STEPAUDIO2_EXECUTION=local',
    'STEPAUDIO2_LOCAL_WS_URL=ws://127.0.0.1:8092/realtime',
    'NEMO_RETRIEVER_ENABLED=true',
    'NEMO_RETRIEVER_BASE_URL=http://127.0.0.1:7670',
    'NEMO_RETRIEVER_VECTORDB_URL=http://127.0.0.1:7671',
    'AGENT_MODEL_BASE_URL=http://127.0.0.1:8000/v1',
    'AGENT_MODEL_DEFAULT=',
  ]) assert.ok(env.includes(expected), `env.example should define ${expected}`);
  assert.doesNotMatch(env, /^SPARK_(?:TEXT|COACH|STEPAUDIO|RETRIEVER)_(?:IMAGE|MODEL|GPU|MAX|SOURCE|CONTAINER)/m);
});

test('setup is repeatable, initializes the app, and does not start external AI services', () => {
  const source = read('setup.sh');
  assert.match(source, /if\s+\[\[\s+!\s+-f\s+.*\.env/s, 'preserve an existing local config');
  assert.match(source, /npm\s+ci/);
  assert.match(source, /db:migrate/);
  assert.match(source, /db:seed|db:setup/);
  assert.match(source, /install-nemoclaw\.sh/);
  assert.match(source, /sync-skills\.sh/);
  assert.match(source, /configure-policy\.sh/);
  assertNoRuntimeLifecycle(source, 'setup.sh');
  assert.doesNotMatch(source, /(?:services\/retriever\.sh|services\/backend\.sh|services\/observer\.sh)\s+start/);
});

test('NemoClaw install uses NVIDIA onboarding and selects the already-running vLLM server', () => {
  const source = read('agent/install-nemoclaw.sh');
  for (const expected of [
    'https://www.nvidia.com/nemoclaw.sh',
    'NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1',
    'NEMOCLAW_AGENT=openclaw',
    'NEMOCLAW_PROVIDER=vllm',
    'NEMOCLAW_SANDBOX_NAME',
    'NEMOCLAW_NO_EXPRESS=1',
  ]) assert.ok(source.includes(expected), `installer should configure ${expected}`);
  assert.doesNotMatch(source, /nemoclaw\s+setup-spark/i);
  assert.doesNotMatch(source, /NEMOCLAW_PROVIDER=install-vllm/);
  assert.doesNotMatch(source, /docker\s+(?:pull|run|start)/i);
});

test('OpenClaw route uses the configured served model and agent Skills can be synced repeatedly', () => {
  const runtime = read('agent/configure-runtime.sh');
  assert.match(runtime, /nemoclaw\s+(?:"\$sandbox"\s+)?inference\s+set/);
  assert.match(runtime, /vllm-local/);
  assert.match(runtime, /AGENT_MODEL_DEFAULT/);
  assert.match(runtime, /AGENT_MODEL_BASE_URL/);

  const skills = read('agent/sync-skills.sh');
  for (const skill of [
    'onboarding-closeout', 'interview-closeout', 'interview-observer',
    'story-completion', 'story-generation',
  ]) assert.ok(skills.includes(skill), `formal OpenClaw Skill ${skill} should be synced`);
  assert.match(skills, /skill\s+install/);
  assert.doesNotMatch(skills, /fingerprint|\.fingerprint/);
});

test('start and stop manage application-owned services only', () => {
  const start = read('start.sh');
  const stop = read('stop.sh');
  assert.match(start, /services\/backend\.sh"?\s+start/);
  assert.match(start, /services\/observer\.sh"?\s+start/);
  assert.doesNotMatch(start, /models\/|services\/(?:retriever|nemoclaw)\.sh\s+(?:start|install)/);
  assertNoRuntimeLifecycle(start, 'start.sh');

  assert.match(stop, /services\/backend\.sh"?\s+stop/);
  assert.match(stop, /services\/observer\.sh"?\s+stop/);
  assert.doesNotMatch(stop, /docker\s+stop|nemoclaw\s+.*(?:stop|destroy)|models\//i);
});

test('verify reports separate product, external Runtime, and hardware evidence states', () => {
  const source = read('verify.sh');
  for (const expected of [
    'PASS', 'FAIL', 'EXTERNAL RUNTIME NOT READY', 'NOT TESTED ON DGX SPARK',
    'SQLite', 'Text', 'Coach', 'StepAudio', 'Retriever', 'Era', 'Memory',
    'NemoClaw', 'OpenClaw', 'Skills', 'Closeout', 'Completion',
    'Generation', 'Contributor', 'NAT', 'Technical Observer',
  ]) assert.ok(source.includes(expected), `verify.sh should report ${expected}`);
  assert.doesNotMatch(source, /docker\s+(?:pull|run|stop)|vllm\s+serve/i);
});

test('old whole-machine installer and model lifecycle managers are removed; benchmark stays separate', () => {
  for (const relativePath of [
    'install.sh', 'bootstrap.sh', 'models.sh', 'models',
    'services/nemoclaw-base.sh',
  ]) assert.equal(existsSync(resolve(sparkRoot, relativePath)), false, `${relativePath} should be removed`);

  const benchmarkPath = resolve(repoRoot, 'scripts/benchmark/spark.sh');
  assert.equal(existsSync(benchmarkPath), true, 'competition benchmark remains under scripts/benchmark');
  const benchmark = readFileSync(benchmarkPath, 'utf8');
  assert.doesNotMatch(benchmark, /deploy\/spark\/(?:start|models\/realtime)\.sh/);
});

test('NemoClaw management uses current sandbox command syntax and reconciles the configured endpoint', () => {
  const install = read('agent/install-nemoclaw.sh');
  const runtime = read('agent/configure-runtime.sh');
  const skills = read('agent/sync-skills.sh');
  const policy = read('agent/configure-policy.sh');
  const verify = read('verify.sh');
  const benchmark = readFileSync(resolve(repoRoot, 'scripts/benchmark/spark.sh'), 'utf8');

  for (const source of [install, runtime, skills, policy, verify, benchmark]) {
    assert.doesNotMatch(source, /nemoclaw\s+sandbox\s+status/);
  }
  assert.match(install, /nemoclaw\s+"\$sandbox"\s+status\s+--json/);
  assert.match(runtime, /NEMOCLAW_VLLM_PORT="\$port"\s+nemoclaw\s+inference\s+set/);
  assert.match(runtime, /--sandbox\s+"\$sandbox"/);
  assert.match(verify, /\["nemoclaw",\s*sandbox,\s*"exec",\s*"--",\s*"openclaw",\s*"--version"\]/);
  for (const source of [runtime, verify, benchmark]) {
    assert.match(source, /recordedRoute/, 'the persisted NemoClaw route should be verified');
    assert.match(source, /liveRoute/, 'the live inference route should be verified');
    assert.match(source, /routeDrift/, 'route drift should fail verification');
  }
  assert.match(verify, /\["nemoclaw",\s*sandbox,\s*"status",\s*"--json"\]/);
  assert.match(benchmark, /\[cli,sandbox,"status","--json"\]/);
});

test('endpoint checks require exact served model IDs and report readiness failures in the overall result', () => {
  const check = read('check-env.sh');
  const verify = read('verify.sh');
  assert.match(check, /json\.load\(sys\.stdin\)/);
  assert.match(check, /item\.get\("id"\).*model|model.*item\.get\("id"\)/s);
  assert.match(verify, /External Runtime endpoint readiness/);
  assert.match(verify, /check_exit/);
});

test('repeat setup reconciles policy endpoints and service ownership works from any caller directory', () => {
  const policy = read('agent/configure-policy.sh');
  const policyTemplate = read('services/retrieval-policy.yaml.template');
  const observer = read('services/observer.sh');
  assert.match(policy, /policy\s+add\s+--from-file/);
  assert.match(policyTemplate, /__HOST__.*__PORT__/s);
  assert.doesNotMatch(policy, /already installed[\s\S]*exit 0/i);
  assert.match(observer, /cd\s+"\$REPO_ROOT"/);

  const benchmark = readFileSync(resolve(repoRoot, 'scripts/benchmark/spark.sh'), 'utf8');
  assert.match(benchmark, /hashlib\.sha256/);
  assert.match(benchmark, /speech-short\.wav/);
  assert.match(benchmark, /speech-long\.wav/);
});
