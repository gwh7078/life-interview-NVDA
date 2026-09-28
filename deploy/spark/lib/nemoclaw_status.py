import argparse
import json
import sys


def status_error(status, expected_model=None):
    if not isinstance(status, dict):
        return "NemoClaw returned a non-object status."
    if status.get("found") is not True:
        return "NemoClaw sandbox was not found."
    phase = str(status.get("phase", "")).lower()
    if phase not in {"ready", "running"}:
        return f"NemoClaw sandbox is not RUNNING (phase={phase or 'unknown'})."
    if expected_model is None:
        return None
    expected = {"provider": "vllm-local", "model": expected_model}
    if status.get("provider") != expected["provider"] or status.get("model") != expected_model:
        return "NemoClaw route does not match the configured Text model."
    for key in ("recordedRoute", "liveRoute"):
        route = status.get(key)
        if not isinstance(route, dict) or any(route.get(name) != value for name, value in expected.items()):
            return f"NemoClaw {key} does not match the configured Text model."
    if status.get("routeDrift") is not False:
        return "NemoClaw reports inference route drift."
    return None


def validate_status_json(raw, expected_model=None):
    try:
        status = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return "NemoClaw returned invalid status JSON."
    return status_error(status, expected_model)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", help="require the exact vllm-local provider/model route")
    parser.add_argument("--phase", action="store_true", help="print the phase for lifecycle handling")
    args = parser.parse_args()
    try:
        status = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        print("NemoClaw returned invalid status JSON.", file=sys.stderr)
        return 1
    if not isinstance(status, dict) or status.get("found") is not True:
        print("NemoClaw sandbox was not found.", file=sys.stderr)
        return 1
    if args.phase:
        phase = str(status.get("phase", "")).lower()
        if not phase:
            print("NemoClaw status has no phase.", file=sys.stderr)
            return 1
        print(phase)
        return 0
    error = status_error(status, args.model)
    if error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
