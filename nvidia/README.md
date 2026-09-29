# NVIDIA integration assets

This directory contains the NVIDIA-specific integration layer for Life Interview.

- `nemoclaw/`: NemoClaw / OpenClaw runtime configuration and policy assets.
- `nat/`: NeMo Agent Toolkit evaluation, regression, profiling, and trace tooling.
- NeMo Retriever is integrated through the application and Spark deployment profile rather than duplicated here.
- Product business logic remains in `src/`; this directory only contains NVIDIA integration and reproducibility assets.

The competition Spark profile has been verified on NVIDIA DGX Spark GB10 as **FULL LOCAL VERIFIED / OFFLINE CAPABLE**. See [DGX Spark verification](../docs/07-reports/spark-deployment-evidence-2026-09-29.md).
