#!/usr/bin/env python3
"""Small process-level checks for Spark lifecycle boundaries."""

import json
import os
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILLS = (
    "onboarding-closeout",
    "interview-closeout",
    "story-completion",
    "story-generation",
    "interview-observer",
)


class HealthHandler(BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):
        self.requests.append(("GET", self.path))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):
        self.requests.append(("POST", self.path))
        self.send_response(409)
        self.end_headers()

    def log_message(self, *_args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class SparkLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="spark-lifecycle-")
        self.tmp = Path(self.temp.name)
        self.repo = self.tmp / "repo"
        (self.repo / "deploy").mkdir(parents=True)
        shutil.copytree(ROOT / "deploy/spark", self.repo / "deploy/spark")
        (self.repo / "agent/skills").mkdir(parents=True)
        for skill in SKILLS:
            shutil.copytree(ROOT / "agent/skills" / skill, self.repo / "agent/skills" / skill)
        self.home = self.tmp / "spark-home"
        self.env_file = self.repo / "deploy/spark/.env"
        self.env_file.write_text(self.config(), encoding="utf-8")
        self.fakebin = self.tmp / "bin"
        self.fakebin.mkdir()
        self.host_home = self.tmp / "host-home"
        self.host_home.mkdir()
        self.env = os.environ.copy()
        self.env.update({
            "SPARK_ENV_FILE": str(self.env_file),
            "SPARK_HOME": str(self.home),
            "HOME": str(self.host_home),
            "PATH": f"{self.fakebin}:{os.environ['PATH']}",
        })
        self.docker_log = self.tmp / "docker.jsonl"
        self.env["MOCK_DOCKER_LOG"] = str(self.docker_log)
        self.git_log = self.tmp / "git.log"
        self.git_log.write_text("")
        self.env["MOCK_GIT_LOG"] = str(self.git_log)
        self.write_fake_git()

    def tearDown(self):
        self.temp.cleanup()

    def config(self, **overrides):
        values = {
            "SPARK_HOME": str(self.home),
            "DATABASE_PATH": f"{self.home}/data/memoir.db",
            "SPARK_BASE_VLLM_IMAGE": "nvcr.io/nvidia/vllm@sha256:base-v1",
            "SPARK_VLLM_IMAGE": "nvcr.io/nvidia/vllm@sha256:base-v1",
            "SPARK_TEXT_MODEL": "text-model-v1",
            "SPARK_TEXT_SERVED_MODEL": "text-api",
            "SPARK_COACH_MODEL": "coach-model-v1",
            "SPARK_COACH_SERVED_MODEL": "coach-api",
            "SPARK_TEXT_PORT": str(free_port()),
            "SPARK_COACH_PORT": str(free_port()),
            "SPARK_STEPAUDIO_BACKEND_PORT": str(free_port()),
            "SPARK_STEPAUDIO_WS_PORT": str(free_port()),
            "SPARK_STEPAUDIO_HEALTH_PORT": str(free_port()),
            "SPARK_RETRIEVER_PORT": str(free_port()),
            "SPARK_VECTORDB_PORT": str(free_port()),
            "SPARK_AGENT_RETRIEVAL_PORT": str(free_port()),
            "NEMOCLAW_SANDBOX": "my-assistant",
            "SPARK_HOST_IP": "192.168.1.24",
        }
        values.update(overrides)
        return "".join(f"{key}={value}\n" for key, value in values.items())

    def write_fake_git(self):
        (self.fakebin / "git").write_text(
            "#!/usr/bin/env python3\n"
            "import os,sys\n"
            "open(os.environ['MOCK_GIT_LOG'],'a').write(' '.join(sys.argv[1:])+'\\n')\n"
            "print(os.environ.get('MOCK_GIT_HEAD','head-a'))\n",
            encoding="utf-8",
        )
        (self.fakebin / "git").chmod(0o755)

    def write_fake_docker(self):
        (self.fakebin / "docker").write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "args=sys.argv[1:]; state_path=os.environ['MOCK_DOCKER_LOG']+'.state'\n"
            "try: state=json.load(open(state_path))\n"
            "except FileNotFoundError: state={}\n"
            "def save(): json.dump(state,open(state_path,'w'))\n"
            "def log(event): open(os.environ['MOCK_DOCKER_LOG'],'a').write(json.dumps(event)+'\\n')\n"
            "if args[:2]==['image','inspect']:\n"
            " print('arm64') if '-f' in args else None; sys.exit(0)\n"
            "if args and args[0]=='ps':\n"
            " running='-a' not in args; print('\\n'.join(n for n,v in state.items() if not running or v['running'])); sys.exit(0)\n"
            "if args and args[0]=='inspect':\n"
            " print(state.get(args[-1],{}).get('spec','')); sys.exit(0)\n"
            "if args and args[0]=='run':\n"
            " name=args[args.index('--name')+1]; label=args[args.index('--label')+1]; spec=label.split('=',1)[1]\n"
            " state[name]={'spec':spec,'running':True}; save(); log({'op':'run','name':name,'spec':spec}); print('container-id'); sys.exit(0)\n"
            "if args and args[0]=='rm':\n"
            " name=args[-1]; state.pop(name,None); save(); log({'op':'rm','name':name}); sys.exit(0)\n"
            "if args and args[0] in ('start','stop'):\n"
            " name=args[-1]; state.setdefault(name,{'spec':'','running':False})['running']=args[0]=='start'; save(); log({'op':args[0],'name':name}); sys.exit(0)\n"
            "if args and args[0]=='pull': sys.exit(0)\n"
            "sys.exit(0)\n",
            encoding="utf-8",
        )
        (self.fakebin / "docker").chmod(0o755)

    def write_fake_nemoclaw(self, log=None):
        (self.fakebin / "nemoclaw").write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "if os.environ.get('MOCK_NEMO_LOG'): open(os.environ['MOCK_NEMO_LOG'],'a').write(json.dumps(sys.argv[1:])+'\\n')\n"
            "sys.exit(0)\n",
            encoding="utf-8",
        )
        (self.fakebin / "nemoclaw").chmod(0o755)
        if log is not None:
            self.env["MOCK_NEMO_LOG"] = str(log)

    def run_script(self, relative, *args, env=None, check=True):
        result = subprocess.run(
            ["bash", str(self.repo / relative), *args],
            cwd=self.repo,
            env=env or self.env,
            text=True,
            capture_output=True,
            timeout=20,
        )
        if check and result.returncode:
            self.fail(f"{relative} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}")
        return result

    def serve(self, ports):
        servers = []
        for port in ports:
            server = ThreadingHTTPServer(("127.0.0.1", port), HealthHandler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
        def close_servers():
            for server in servers:
                server.shutdown()
                server.server_close()
        self.addCleanup(close_servers)

    def test_base_fingerprint_ignores_product_and_model_changes(self):
        script = "deploy/spark/bootstrap.sh"
        for name, body in {
            "uname": "#!/usr/bin/env python3\nimport os,sys\nprint(os.environ.get('MOCK_ARCH','aarch64') if sys.argv[1:]==['-m'] else 'Linux')\n",
            "nvidia-smi": "#!/usr/bin/env python3\nimport os\nprint(os.environ.get('MOCK_DRIVER_VERSION','580.159.03'))\n",
            "docker": "#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nprint(os.environ.get('MOCK_DOCKER_VERSION','27.5.1') if a and a[0]=='version' else os.environ.get('MOCK_DOCKER_RUNTIME','nvidia,runc') if a and a[0]=='info' else '')\n",
        }.items():
            target = self.fakebin / name
            target.write_text(body, encoding="utf-8")
            target.chmod(0o755)
        first = self.run_script(script, "fingerprint").stdout.strip()
        self.env["MOCK_GIT_HEAD"] = "head-b"
        self.env_file.write_text(self.config(SPARK_TEXT_MODEL="text-model-v2", PRODUCT_FLAG="changed"))
        (self.repo / "public").mkdir()
        (self.repo / "public/unrelated.txt").write_text("new product code")
        second = self.run_script(script, "fingerprint").stdout.strip()
        self.assertEqual(first, second)
        self.env["MOCK_DRIVER_VERSION"] = "580.160.01"
        changed_driver = self.run_script(script, "fingerprint").stdout.strip()
        self.assertNotEqual(second, changed_driver)
        self.env_file.write_text(self.config(SPARK_BASE_VLLM_IMAGE="nvcr.io/nvidia/vllm@sha256:base-v2"))
        changed_image = self.run_script(script, "fingerprint").stdout.strip()
        self.assertNotEqual(changed_driver, changed_image)
        self.assertEqual(self.git_log.read_text(), "")

    def test_install_dry_run_does_not_create_host_or_runtime_state(self):
        result = self.run_script("deploy/spark/install.sh", "--dry-run")
        self.assertIn("bootstrap", result.stdout.lower())
        self.assertFalse(self.home.exists())
        self.assertFalse((self.repo / "runtime").exists())

    def test_text_model_change_reconciles_only_text_container(self):
        self.write_fake_docker()
        self.write_fake_nemoclaw()
        tools = self.home / "venv/spark-tools/bin"
        tools.mkdir(parents=True)
        (tools / "python").symlink_to(shutil.which("python3"))
        (tools / "hf").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        (tools / "hf").chmod(0o755)
        ports = [int(v) for key, v in self.values().items() if key in {
            "SPARK_TEXT_PORT", "SPARK_COACH_PORT", "SPARK_STEPAUDIO_BACKEND_PORT", "SPARK_STEPAUDIO_HEALTH_PORT"
        }]
        self.serve(ports)
        self.run_script("deploy/spark/models.sh", "sync", "text")
        self.run_script("deploy/spark/restart.sh", "text")
        self.docker_log.write_text("")
        values = self.values()
        values["SPARK_TEXT_MODEL"] = "text-model-v2"
        self.env_file.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        self.run_script("deploy/spark/models.sh", "sync", "text")
        self.run_script("deploy/spark/restart.sh", "text")
        events = [json.loads(line) for line in self.docker_log.read_text().splitlines() if line]
        recreated = {event["name"] for event in events if event["op"] == "rm"}
        self.assertEqual(recreated, {"life-interview-spark-text"})

    def values(self):
        return dict(line.split("=", 1) for line in self.env_file.read_text().splitlines())

    def test_bridge_fingerprint_ignores_git_head_but_tracks_implementation(self):
        script = "deploy/spark/models/realtime.sh"
        first = self.run_script(script, "bridge-fingerprint").stdout.strip()
        self.env["MOCK_GIT_HEAD"] = "head-b"
        second = self.run_script(script, "bridge-fingerprint").stdout.strip()
        self.assertEqual(first, second)
        bridge = self.repo / "deploy/spark/services/stepaudio2_bridge.py"
        bridge.write_text(bridge.read_text() + "\n# bridge implementation change\n")
        third = self.run_script(script, "bridge-fingerprint").stdout.strip()
        self.assertNotEqual(second, third)
        self.assertEqual(self.git_log.read_text(), "")

    def test_retriever_start_does_not_initialize_collections(self):
        self.write_fake_docker()
        retriever_port, vectordb_port = [int(self.values()[k]) for k in ("SPARK_RETRIEVER_PORT", "SPARK_VECTORDB_PORT")]
        self.serve([retriever_port, vectordb_port])
        HealthHandler.requests = []
        self.run_script("deploy/spark/services/retriever.sh", "start")
        self.assertFalse(any(path == "/v1/collections" for _, path in HealthHandler.requests))

    def test_nemoclaw_start_skips_skills_and_skill_sync_is_content_scoped(self):
        log = self.tmp / "nemoclaw.jsonl"
        self.write_fake_nemoclaw(log)
        (self.fakebin / "ip").write_text("#!/bin/sh\nprintf '1.1.1.1 dev eth0 src 192.168.1.24\\n'\n")
        (self.fakebin / "ip").chmod(0o755)
        script = "deploy/spark/services/nemoclaw.sh"
        self.run_script(script, "start")
        self.run_script(script, "start")
        started = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertFalse(any("skill" in " ".join(args) or "onboard" in args for args in started))
        log.write_text("")
        self.run_script(script, "sync-skills")
        self.run_script(script, "sync-skills")
        changed = self.repo / "agent/skills/interview-observer/SKILL.md"
        changed.write_text(changed.read_text() + "\nchanged\n")
        self.run_script(script, "sync-skills")
        synced = [json.loads(line) for line in log.read_text().splitlines()]
        installs = [args for args in synced if "skill" in args and "install" in args]
        self.assertEqual(len(installs), len(SKILLS) + 1)
        self.assertFalse(any("onboard" in args for args in synced))

    def test_nemoclaw_lifecycle_start_is_idempotent_and_stop_preserves_sandbox(self):
        log = self.tmp / "nemoclaw-lifecycle.jsonl"
        state = self.tmp / "nemoclaw-state"
        state.write_text("stopped")
        self.env["MOCK_NEMO_LOG"] = str(log)
        self.env["MOCK_NEMO_STATE"] = str(state)
        (self.fakebin / "ip").write_text("#!/bin/sh\nprintf '1.1.1.1 dev eth0 src 192.168.1.24\\n'\n")
        (self.fakebin / "ip").chmod(0o755)
        (self.fakebin / "nemoclaw").write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "from pathlib import Path\n"
            "args=sys.argv[1:]; state=Path(os.environ['MOCK_NEMO_STATE'])\n"
            "open(os.environ['MOCK_NEMO_LOG'],'a').write(json.dumps(args)+'\\n')\n"
            "if args==['my-assistant','status']:\n"
            " print('Phase: Ready' if state.read_text()=='running' else 'Phase: Stopped')\n"
            "elif args==['my-assistant','start']: state.write_text('running')\n"
            "elif args==['my-assistant','stop']: state.write_text('stopped')\n"
            "sys.exit(0)\n",
            encoding="utf-8",
        )
        (self.fakebin / "nemoclaw").chmod(0o755)

        script = "deploy/spark/services/nemoclaw.sh"
        self.run_script(script, "start")
        self.run_script(script, "start")
        self.run_script(script, "stop")
        self.assertEqual(state.read_text(), "stopped")
        lifecycle = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(
            [args for args in lifecycle if args in (["my-assistant", "start"], ["my-assistant", "stop"])],
            [["my-assistant", "start"], ["my-assistant", "stop"]],
        )

    def test_nemoclaw_reconciles_skill_and_policy_after_sandbox_rebuild(self):
        log = self.tmp / "nemoclaw-rebuild.jsonl"
        remote = self.tmp / "sandbox-state"
        remote.mkdir()
        self.env["MOCK_NEMO_LOG"] = str(log)
        self.env["MOCK_NEMO_REMOTE"] = str(remote)
        (self.fakebin / "nemoclaw").write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "from pathlib import Path\n"
            "args=sys.argv[1:]; remote=Path(os.environ['MOCK_NEMO_REMOTE'])\n"
            "open(os.environ['MOCK_NEMO_LOG'],'a').write(json.dumps(args)+'\\n')\n"
            "if args==['my-assistant','status']: print('Phase: Ready')\n"
            "elif args==['my-assistant','status','--json']:\n"
            " print(json.dumps({'policiesAvailable': True, 'policies': ['life_interview_retrieval_api'] if (remote/'policy').exists() else []}))\n"
            "elif args==['my-assistant','exec','--','openclaw','config','get','agents.list']:\n"
            " print('[\\n  {\"id\": \"realtime-context\"}\\n]')\n"
            "elif len(args)==6 and args[:5]==['my-assistant','exec','--','test','-f']:\n"
            " target=args[5]\n"
            " present=(remote/'product-skill').exists() if 'workspace-realtime-context' in target else (remote/'skills'/Path(target).parent.name).exists()\n"
            " sys.exit(0 if present else 1)\n"
            "elif args[:3]==['my-assistant','skill','install']:\n"
            " name=Path(args[3]).name; path=remote/'skills'/name; path.mkdir(parents=True,exist_ok=True); (path/'SKILL.md').touch()\n"
            "elif args[1:4]==['exec','--','openclaw'] and args[4:6]==['skills','install']:\n"
            " (remote/'product-skill').touch()\n"
            "elif args[1:3]==['policy','add']:\n"
            " (remote/'policy').touch()\n"
            "sys.exit(0)\n",
            encoding="utf-8",
        )
        (self.fakebin / "nemoclaw").chmod(0o755)

        script = "deploy/spark/services/nemoclaw.sh"
        self.run_script(script, "sync-skills")
        self.run_script(script, "sync-skills")
        self.run_script(script, "apply-policy")
        self.run_script(script, "apply-policy")
        shutil.rmtree(remote)
        remote.mkdir()
        self.run_script(script, "sync-skills")
        self.run_script(script, "apply-policy")

        calls = [json.loads(line) for line in log.read_text().splitlines()]
        skill_installs = [args for args in calls if args[1:3] == ["skill", "install"]]
        product_skill_installs = [args for args in calls if args[1:4] == ["exec", "--", "openclaw"] and args[4:6] == ["skills", "install"]]
        policy_installs = [args for args in calls if args[1:3] == ["policy", "add"]]
        self.assertEqual(len(skill_installs), len(SKILLS) * 2)
        self.assertEqual(len(product_skill_installs), 2)
        self.assertEqual(len(policy_installs), 2)

    def test_update_dry_run_is_product_only(self):
        result = self.run_script("deploy/spark/update.sh", "--dry-run")
        self.assertIn("Backend", result.stdout)
        for marker in ("models/post-session.sh", "models/coach.sh", "models/realtime.sh", "retriever.sh start"):
            self.assertNotIn(marker, result.stdout)

    def test_repeated_update_keeps_migrated_db_and_recreates_lost_collections(self):
        retriever_port, vectordb_port = free_port(), free_port()
        self.env_file.write_text(self.config(
            DEPLOYMENT_PROFILE="spark",
            DATABASE_PATH="data/memoir.db",
            NEMO_RETRIEVER_ENABLED="true",
            NEMO_RETRIEVER_BASE_URL=f"http://127.0.0.1:{retriever_port}",
            NEMO_RETRIEVER_COLLECTION="private-test",
            NEMO_ERA_CONTEXT_COLLECTION="era-test",
            NEMO_ERA_CONTEXT_ENABLED="false",
            SPARK_RETRIEVER_PORT=str(retriever_port),
            SPARK_VECTORDB_PORT=str(vectordb_port),
            SPARK_HOST_IP="192.168.1.24",
            TEXT_MODEL_BASE_URL="http://127.0.0.1:8000/v1",
            REALTIME_COACH_BASE_URL="http://127.0.0.1:8001/v1",
            STEPAUDIO2_LOCAL_WS_URL="ws://127.0.0.1:8092/realtime",
        ))

        scripts = self.repo / "scripts"
        scripts.mkdir()
        fake_runner = scripts / "codex-node.sh"
        fake_runner.write_text(
            "#!/usr/bin/env bash\n"
            "if [[ \"$1 $2\" == 'npm ci' ]]; then mkdir -p node_modules; fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        fake_runner.chmod(0o755)
        nat_project = self.repo / "nvidia/nat"
        nat_project.mkdir(parents=True)
        (nat_project / "pyproject.toml").write_text("[project]\nname='nat-test'\n")
        (nat_project / "uv.lock").write_text("version = 1\n")

        log = self.tmp / "nemoclaw-update.jsonl"
        self.env["MOCK_NEMO_LOG"] = str(log)
        (self.fakebin / "nemoclaw").write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "args=sys.argv[1:]\n"
            "if os.environ.get('MOCK_NEMO_LOG'): open(os.environ['MOCK_NEMO_LOG'],'a').write(json.dumps(args)+'\\n')\n"
            "if args==['my-assistant','status']: print('Phase: Ready')\n"
            "elif args[-3:]==['config','get','agents.list']: print('[\\n  {\"id\": \"realtime-context\"}\\n]')\n"
            "sys.exit(0)\n",
            encoding="utf-8",
        )
        (self.fakebin / "nemoclaw").chmod(0o755)
        nat = self.home / "venv/nat/bin/nat"
        nat.parent.mkdir(parents=True)
        nat.write_text("#!/bin/sh\nexit 0\n")
        nat.chmod(0o755)
        uv = self.home / "tools/uv/bin/uv"
        uv.parent.mkdir(parents=True)
        uv.write_text("#!/bin/sh\nexit 0\n")
        uv.chmod(0o755)

        source_db = self.repo / "data/memoir.db"
        source_db.parent.mkdir()
        with sqlite3.connect(source_db) as db:
            db.execute("CREATE TABLE entries (value TEXT)")
            db.execute("INSERT INTO entries VALUES ('source')")

        state_dir = self.home / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        fingerprint = self.run_script("deploy/spark/bootstrap.sh", "fingerprint").stdout.strip()
        (state_dir / "base.fingerprint").write_text(fingerprint + "\n")

        server = ThreadingHTTPServer(("127.0.0.1", retriever_port), HealthHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        HealthHandler.requests = []

        self.run_script("deploy/spark/update.sh", "--no-restart")
        persistent_db = self.home / "data/memoir.db"
        self.assertTrue(persistent_db.is_file())
        with sqlite3.connect(persistent_db) as db:
            db.execute("INSERT INTO entries VALUES ('newer persistent data')")
        shutil.rmtree(self.home / "retriever/data")

        self.run_script("deploy/spark/update.sh", "--no-restart")

        self.assertEqual((self.repo / "data/memoir.db").is_file(), True)
        with sqlite3.connect(persistent_db) as db:
            self.assertEqual(db.execute("SELECT value FROM entries ORDER BY rowid").fetchall(),
                             [("source",), ("newer persistent data",)])
        collection_posts = [request for request in HealthHandler.requests if request == ("POST", "/v1/collections")]
        self.assertEqual(len(collection_posts), 4)

        persistent_db.unlink()
        missing_result = self.run_script("deploy/spark/update.sh", "--no-restart", check=False)
        self.assertNotEqual(missing_result.returncode, 0)
        self.assertFalse(persistent_db.exists())
        self.assertIn("persistent database is missing", missing_result.stderr.lower())

        source_db.unlink()
        missing_both_result = self.run_script("deploy/spark/update.sh", "--no-restart", check=False)
        self.assertNotEqual(missing_both_result.returncode, 0)
        self.assertFalse(persistent_db.exists())
        self.assertIn("persistent database is missing", missing_both_result.stderr.lower())

    def test_selective_restart_dry_run_names_only_requested_service(self):
        result = self.run_script("deploy/spark/restart.sh", "--dry-run", "backend")
        self.assertIn("backend", result.stdout.lower())
        self.assertNotIn("coach", result.stdout.lower())
        self.assertNotIn("stepaudio", result.stdout.lower())
        self.assertNotIn("retriever", result.stdout.lower())

    def test_persistent_paths_survive_checkout_changes(self):
        roots = [self.repo]
        second = self.tmp / "fresh-clone"
        (second / "deploy").mkdir(parents=True)
        shutil.copytree(ROOT / "deploy/spark", second / "deploy/spark")
        roots.append(second)
        shared = self.tmp / "shared-spark-home"
        (shared / "data").mkdir(parents=True)
        (shared / "data/memoir.db").write_bytes(b"preserve")
        outputs = []
        for root in roots:
            env_file = root / "deploy/spark/.env"
            env_file.write_text(f"SPARK_HOME={shared}\nDATABASE_PATH={shared}/data/memoir.db\n")
            common = root / "deploy/spark/lib/common.sh"
            command = f'. "{common}"; printf "%s\\n" "$SPARK_RUNTIME_DIR" "$SPARK_STATE_DIR" "$SPARK_PID_DIR" "$SPARK_RETRIEVER_DATA_DIR" "$SPARK_DIAGNOSTICS_DIR" "$DATABASE_PATH"'
            result = subprocess.run(["bash", "-c", command], cwd=root, text=True, capture_output=True, env={**self.env, "SPARK_ENV_FILE": str(env_file)}, check=True)
            outputs.append(result.stdout.splitlines())
        self.assertEqual(outputs[0][:4] + outputs[0][5:], outputs[1][:4] + outputs[1][5:])
        self.assertNotEqual(outputs[0][4], outputs[1][4])
        self.assertEqual((shared / "data/memoir.db").read_bytes(), b"preserve")


if __name__ == "__main__":
    unittest.main(verbosity=2)
