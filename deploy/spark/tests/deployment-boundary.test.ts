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
    'NEMO_RETRIEVER_BASE_URL',
    'EXTERNAL RUNTIME NOT READY',
  ]) assert.ok(source.includes(expected), `check-env.sh should check ${expected}`);
  assert.doesNotMatch(source, /VECTORDB|vectordb/i, 'VectorDB is internal to the Retriever Runtime');
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
    'AGENT_MODEL_BASE_URL=http://127.0.0.1:8000/v1',
    'AGENT_MODEL_DEFAULT=',
    'SPARK_SEED_DEMO_DATA=false',
  ]) assert.ok(env.includes(expected), `env.example should define ${expected}`);
  assert.doesNotMatch(env, /NEMO_RETRIEVER_VECTORDB_URL/);
  assert.doesNotMatch(env, /^SPARK_(?:TEXT|COACH|STEPAUDIO|RETRIEVER)_(?:IMAGE|MODEL|GPU|MAX|SOURCE|CONTAINER)/m);
});

test('setup is repeatable, initializes the app, and seeds demo data only by explicit opt-in', () => {
  const source = read('setup.sh');
  assert.match(source, /if\s+\[\[\s+!\s+-f\s+.*\.env/s, 'preserve an existing local config');
  assert.match(source, /npm\s+ci/);
  assert.match(source, /db:migrate/);
  assert.match(source, /db:migrate/);
  assert.match(source, /SPARK_SEED_DEMO_DATA/);
  assert.match(source, /if\s+\[\[.*SPARK_SEED_DEMO_DATA.*==.*true/s);
  assert.match(source, /npm\s+run\s+db:seed/);
  assert.doesNotMatch(source, /NEMO_RETRIEVER_VECTORDB_URL/);
  assert.match(source, /check-agent-runtime\.sh/);
  assert.doesNotMatch(source, /install-nemoclaw|nemoclaw\s+(?:onboard|start|stop)/i);
  assert.match(source, /sync-skills\.sh/);
  assert.match(source, /configure-policy\.sh/);
  assert.match(source, /TEXT_MODEL_API_KEY must be empty/);
  assertNoRuntimeLifecycle(source, 'setup.sh');
  assert.doesNotMatch(source, /(?:services\/retriever\.sh|services\/backend\.sh|services\/observer\.sh)\s+start/);
});

test('NemoClaw/OpenClaw readiness is operator-managed and check-only', () => {
  const source = read('agent/check-agent-runtime.sh');
  for (const expected of [
    'AGENT RUNTIME NOT READY',
    'operator-managed prerequisite',
    'status --json',
    'found',
    'ready',
    'running',
    'openclaw',
    '--version',
  ]) assert.ok(source.includes(expected), `Agent Runtime check should enforce ${expected}`);
  assert.doesNotMatch(source, /curl|nemoclaw\s+(?:onboard|start|stop)|openclaw\s+(?:install|onboard)/i);
  assert.equal(existsSync(resolve(sparkRoot, 'agent/install-nemoclaw.sh')), false);
});

test('Spark Text contract rejects authentication while Coach credentials remain optional', () => {
  const env = read('env.example');
  const setup = read('setup.sh');
  assert.match(env, /^TEXT_MODEL_API_KEY=$/m);
  assert.match(env, /^REALTIME_COACH_API_KEY=$/m);
  assert.match(setup, /TEXT_MODEL_API_KEY must be empty/);
  assert.doesNotMatch(setup, /REALTIME_COACH_API_KEY must be empty/);
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

test('verify is an application acceptance profile, not CI or competition evaluation', () => {
  const source = read('verify.sh');
  for (const expected of [
    'PASS', 'FAIL', 'EXTERNAL RUNTIME NOT READY', 'NOT TESTED ON DGX SPARK',
    'SQLite', 'Text', 'Coach', 'StepAudio', 'Retriever', 'Era', 'Memory',
    'NemoClaw', 'OpenClaw', 'Skills', 'Closeout', 'Completion',
    'Generation', 'Contributor', 'spark:product:acceptance', 'Technical Observer',
  ]) assert.ok(source.includes(expected), `verify.sh should report ${expected}`);
  for (const gate of ['G0A', 'G4a', 'G4b', 'G7a', 'G7b']) {
    assert.ok(source.includes(gate), `verify.sh should report ${gate}`);
  }
  assert.match(source, /test:spark:realtime:e2e/);
  assert.match(source, /test:realtime:agent:smoke/);
  assert.match(source, /fixture\.is_file\(\)[\s\S]*?NOT TESTED/);
  assert.doesNotMatch(source, /npm\s+test|test:agent:nat|\bNAT\b/i);
  assert.doesNotMatch(source, /NEMO_RETRIEVER_VECTORDB_URL|vectordb/i);
  assert.match(source, /G9.*Technical Observer/s);
  assert.match(source, /TEXT_MODEL_API_KEY/);
  assert.match(source, /REALTIME_COACH_API_KEY/);
  assert.doesNotMatch(source, /docker\s+(?:pull|run|stop)|vllm\s+serve/i);

  const acceptance = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).scripts[
    'spark:product:acceptance'
  ] as string;
  for (const path of [
    'test/interview-closeout-workflow.test.ts', 'test/story-completion.test.ts',
    'test/story-generation.test.ts', 'test/story-share.test.ts',
    'test/realtime-memory-trigger.test.ts',
  ]) assert.ok(acceptance.includes(path), `product acceptance should cover ${path}`);
  assert.doesNotMatch(acceptance, /nat|npm\s+test/i);
});

test('OpenAI-compatible model smoke passes each configured API key and does not require health', () => {
  const source = read('verify.sh');
  assert.match(source, /openai-smoke\.py[\s\S]{0,260}TEXT_MODEL_API_KEY/);
  assert.match(source, /openai-smoke\.py[\s\S]{0,260}REALTIME_COACH_API_KEY/);
  assert.match(source, /SPARK_OPENAI_API_KEY/);
  assert.doesNotMatch(source, /os\.environ\.get\("(?:TEXT_MODEL|REALTIME_COACH)_API_KEY"\),/);
  const smoke = read('lib/openai-smoke.py');
  assert.doesNotMatch(smoke, /\/health/);
  assert.match(smoke, /SPARK_OPENAI_API_KEY/);
  for (const file of ['check-env.sh', 'status.sh']) {
    const probe = read(file);
    assert.match(probe, /urllib\.request/);
    assert.doesNotMatch(probe, /curl[^\n]*(?:api_key|api_token)/i);
  }
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
  const readiness = read('agent/check-agent-runtime.sh');
  const runtime = read('agent/configure-runtime.sh');
  const skills = read('agent/sync-skills.sh');
  const policy = read('agent/configure-policy.sh');
  const verify = read('verify.sh');
  const benchmark = readFileSync(resolve(repoRoot, 'scripts/benchmark/spark.sh'), 'utf8');

  for (const source of [readiness, runtime, skills, policy, verify, benchmark]) {
    assert.doesNotMatch(source, /nemoclaw\s+sandbox\s+status/);
  }
  assert.match(readiness, /nemoclaw_status_ready/);
  assert.match(runtime, /NEMOCLAW_VLLM_PORT="\$port"\s+nemoclaw\s+inference\s+set/);
  assert.match(runtime, /--sandbox\s+"\$sandbox"/);
  assert.match(verify, /\["nemoclaw",\s*sandbox,\s*"exec",\s*"--",\s*"openclaw",\s*"--version"\]/);
  const statusContract = read('lib/nemoclaw_status.py');
  for (const field of ['recordedRoute', 'liveRoute', 'routeDrift', 'vllm-local']) {
    assert.ok(statusContract.includes(field), `shared status validation should enforce ${field}`);
  }
  assert.match(runtime, /nemoclaw_status_ready/);
  assert.match(verify, /validate_status_json/);
  assert.match(benchmark, /validate_status_json/);
  assert.match(verify, /\["nemoclaw",\s*sandbox,\s*"status",\s*"--json"\]/);
  assert.match(benchmark, /\[cli,sandbox,"status","--json"\]/);
  for (const source of [readiness, runtime, skills]) {
    assert.match(source, /nemoclaw_status(?:_ready|\.py)|nemoclaw_status/,
      'NemoClaw readiness/configuration scripts should share the status contract');
  }
  assert.match(verify, /validate_status_json/);
  assert.match(read('status.sh'), /nemoclaw_status_ready/);
  assert.match(read('services/telemetry.py'), /validate_status_json/);
});

test('check-env checks versioned host prerequisites and reports them as FAIL', () => {
  const source = read('check-env.sh');
  for (const expected of [
    'python3 --version', 'node --version', 'npm --version', 'git --version',
    'docker info', 'nvidia-smi', 'NVIDIA Container Runtime',
  ]) assert.ok(source.includes(expected), `check-env.sh should check ${expected}`);
  assert.match(source, /fail\s+.*Python|fail\s+.*Node|fail\s+.*npm|fail\s+.*Git/i);
  assert.match(source, /EXTERNAL RUNTIME NOT READY/);
  assertNoRuntimeLifecycle(source, 'check-env.sh');
});

test('application and competition evidence share the same sanitizer', () => {
  const verify = read('verify.sh');
  const benchmark = readFileSync(resolve(repoRoot, 'scripts/benchmark/spark.sh'), 'utf8');
  assert.match(verify, /sanitize_text/);
  assert.match(benchmark, /sanitize_text/);
  assert.doesNotMatch(verify, /re\.sub\([^\n]*(?:authorization|nvapi|api[_-]\?key)/i);
});

test('Spark documentation reflects final GB10 ARM64 verification and seed opt-in remains explicit', () => {
  const docs = `${read('README.md')}\n${readFileSync(resolve(repoRoot, 'README.md'), 'utf8')}`;
  assert.match(docs, /FULL LOCAL VERIFIED\s*\/\s*OFFLINE CAPABLE/i);
  assert.doesNotMatch(docs, /NOT VERIFIED ON DGX SPARK\s*\/\s*ARM64/i);
  assert.match(docs, /SPARK_SEED_DEMO_DATA=true/);
  assert.doesNotMatch(docs, /NEMO_RETRIEVER_VECTORDB_URL/);
  const currentDocs = [
    'docs/CURRENT_STATE.md', 'docs/NVIDIA.md', 'docs/ARCHITECTURE.md',
    'docs/AGENT_RUNTIME.md', 'docs/00-competition/SCORING_ALIGNMENT_v1.0.md',
    'docs/04-nvidia/spark/README.md',
    'docs/04-nvidia/spark/ONE_DAY_SPARK_RUNBOOK_v1.0.md',
    'docs/04-nvidia/spark/SPARK_DEPLOYMENT_AGENT_BRIEF_v1.0.md',
    'docs/04-nvidia/spark/OFFICIAL_REFERENCE_INDEX_v1.0.md',
  ].map((path) => readFileSync(resolve(repoRoot, path), 'utf8')).join('\n');
  assert.match(currentDocs, /FULL LOCAL VERIFIED\s*\/\s*OFFLINE CAPABLE/i);
  assert.doesNotMatch(currentDocs, /NOT (?:TESTED|VERIFIED) ON DGX SPARK(?:\s*\/\s*ARM64)?/i);
  assert.match(currentDocs, /NEMO_RETRIEVER_BASE_URL/);
});

test('endpoint checks require exact served model IDs and report readiness failures in the overall result', () => {
  const check = read('check-env.sh');
  const verify = read('verify.sh');
  assert.match(check, /json\.load\(response\)/);
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
