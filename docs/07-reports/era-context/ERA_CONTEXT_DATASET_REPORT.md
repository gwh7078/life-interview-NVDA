# Era Context Dataset Report

## Current dataset

- Canonical file: `data/era-context/era-context.zh-CN.jsonl`
- Records: 1,800
- Range: 1970–2020
- Categories: 12, with 150 records per category
- Canonical fields: `start_year`, `end_year`, `category`, `title`, `summary`
- Source manifest: `data/era-context/source-manifest.jsonl`

The canonical records contain only the five fields required by the Era Context
contract. Source URLs and verification labels live in the separate manifest.
The dataset stores derived summaries, not copied source pages.

## Source layers

The initial source set combines the official historical chronology, statistical
reports, internet development reports and CCTV cultural archives with the
provided Sohu and People discovery material. The Sohu timeline is treated as a
discovery source and major claims are intended to be checked against a primary
source before production use.

## Runtime boundary

The Retriever collection is `life-interview-era-context-v1`. It is separate
from `life-interview-transcripts`. Era matches are public interview hints and
are not user facts.

## Verification status

Run:

```bash
bash scripts/codex-node.sh npm run era:dataset:validate
```

The live ingest and search results are written by:

```bash
bash scripts/codex-node.sh npm run era:index
bash scripts/codex-node.sh npm run era:benchmark
```

The dataset builder deliberately keeps the canonical file reproducible. A
future curation pass should replace broad derived aspect rows with individually
reviewed source-backed records where human acceptance finds weak relevance.
