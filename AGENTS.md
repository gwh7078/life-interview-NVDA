# Codex development instructions

- Use bash scripts/codex-node.sh <command> [args...] for every Node.js or npm command. The wrapper selects a Node.js version compatible with this project's lockfile without replacing the system Node.
- Use bash scripts/codex-dev.sh to start the local app and bash scripts/codex-verify.sh for the local test suite.
- Each Worktree owns data/codex-worktree.db. Never point it at a shared or production database. Setup initializes this file only when it does not already exist.
- On macOS, keep the voice and text-model API keys in the user's login Keychain; setup may materialize only those two keys into the current Worktree's ignored .env with mode 0600. Never copy .env into another Worktree, add it to .worktreeinclude, commit it, or print its values.
- VOLCENGINE_API_KEY is for the realtime voice model; CLOSEOUT_API_KEY is a separate key for post-interview text summaries. Both are Volcengine credentials and must not be reused interchangeably.
- Do not run npm run test:voice:e2e unless the user specifically requests live-provider verification; it sends synthetic audio to external models and consumes usage.
- Preserve existing data/e2e artifacts; do not clear or replace them as part of routine setup or tests.
