# life-interview-NVDA

人生采访局 NVIDIA Agent-Native 比赛版。

## Development baseline

- Source product repository: `gwh7078/life-interview`
- Baseline source SHA: `f05b22ce57ae06e4e619bd53218278e6937475e4`
- Baseline date: 2026-09-20
- Development branch: `nvidia/agent-native`
- Runtime target: NVIDIA NemoClaw + OpenShell + OpenClaw
- Mac development: real NemoClaw/OpenClaw sandbox + NVIDIA hosted inference
- Competition target: DGX Spark local-first inference/retrieval

The existing `public/` and `src/` directories are a stable product baseline and are intentionally kept during Phase 0/1. New Agent code starts in `agent/`; NVIDIA integration assets live in `nvidia/`; environment-specific deployment assets live in `deploy/`.

## Current phase

Phase 0 baseline is frozen. Phase 1 builds the Node → NemoClaw → OpenClaw → read-only Tool API smoke chain without changing current Web product behavior.

See `docs/nvidia-agent-native/`.
