# story-completion recovery

- Original with and without Harbor job trees, task Dockerfiles, and pre-refresh lock files are preserved under this directory.
- The initial with job had 18 infrastructure failures (17 RuntimeError, 1 EnvironmentStartTimeoutError); without had 1 startup timeout and 1 cancelled trial. No scored result was present.
- Task Dockerfiles were refreshed only in the generated evaluation workspace. Harbor task digests were recomputed from those generated task contexts; agent, judge, dataset, threshold, and attempt count stayed unchanged.
- One resumed with attempt (COMP-NEG-001__8FNYzFn) was cancelled during environment setup after about 2m41s, before agent setup or agent_result existed. Its trial directory is preserved under _recovery-attempts/.
- The recovery run log is ../../_recovery-logs/resume-with.log. It records progress only; original failure details remain in the archived Harbor job logs.

- A second resumed attempt (COMP-NEG-001__HZHUVkU) was cancelled after 7m14s in environment setup, before agent setup or agent_result existed. Its trial directory is preserved under _recovery-attempts/.
- Colima was restarted after Docker/ctr calls stalled and containerd logged an inactive ttrpc stream. Docker responsiveness returned; the existing my-assistant container was restarted by ID, its named state volume remained attached, and health is healthy.

- Post-Colima recovery produced 6 valid with-skill scores: nvidia/skillevaluator-COMP-001=0.9583, nvidia/skillevaluator-COMP-004=1.0, nvidia/skillevaluator-COMP-006=1.0, nvidia/skillevaluator-COMP-007=1.0, nvidia/skillevaluator-COMP-HNEG-002=1.0, nvidia/skillevaluator-COMP-NEG-001=0.75.
- 8 later with-skill Agent attempts received HTTP 400 code Arrearage from Bailian; the response states the account is not in good standing and is non-retryable. Their raw trial directories are preserved under ../bailian-arrearage/with/. Four with-skill trials remain unrun; the without-skill job was not resumed.
- No further Qwen requests were made after confirming Arrearage. The shared OpenCode runtime mount was verified read-only in a live trial container, with version 1.18.33.
