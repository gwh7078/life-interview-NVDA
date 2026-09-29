#!/usr/bin/env python3
"""Assemble and summarize the frozen-A / new-B targeted regression evidence."""
import argparse
import json
import pathlib
import random
import statistics
import unicodedata
import uuid

ROOT = pathlib.Path('benchmark/next-question/results')
FROZEN_RUN_ID = '2026-09-28T11-54-23-404Z-27c55a4d'
FROZEN_JUDGE_ID = '2026-09-28T13-34-48-step-plan-judge-682ebd14'
CASE_IDS = ['C03', 'C05', 'C06', 'C10']
SCORE_KEYS = ['information_gain', 'context_use', 'story_value', 'depth', 'non_leading']
RESULT_KEYS = set(SCORE_KEYS + ['total_score', 'repeated_question', 'fact_misuse', 'leading_question', 'missed_high_value_clue', 'brief_reason'])
RESULT_META_KEYS = {
    'status', 'candidate_id', 'case_id', 'judge_model', 'temperature', 'max_output_tokens',
    'response_id', 'finish_reason', 'judge_attempt', 'attempt_count', 'retry_reason', 'schema_validation_error',
}
LIMITS = {'information_gain': 30, 'context_use': 25, 'story_value': 20, 'depth': 15, 'non_leading': 10}


def load_json(path):
    return json.loads(pathlib.Path(path).read_text())


def load_jsonl(path):
    path = pathlib.Path(path)
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_json(path, value):
    path = pathlib.Path(path)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)


def write_jsonl(path, values):
    path = pathlib.Path(path)
    path.write_text(''.join(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n' for value in values))
    path.chmod(0o600)


def is_boundary(char):
    return not char or char.isspace() or unicodedata.category(char)[0] in {'P', 'Z'}


def normalize_asr(text):
    source = list(unicodedata.normalize('NFKC', text).lower())
    compact = []
    for index, char in enumerate(source):
        if char in {'嗯', '呃', '额'} and is_boundary(source[index - 1] if index else '') and is_boundary(source[index + 1] if index + 1 < len(source) else ''):
            continue
        if not char.isspace() and unicodedata.category(char)[0] != 'Z':
            compact.append(char)
    output = []
    for index, char in enumerate(compact):
        if unicodedata.category(char)[0] == 'P':
            before = compact[index - 1] if index else ''
            after = compact[index + 1] if index + 1 < len(compact) else ''
            if not (unicodedata.category(before) == 'Nd' and unicodedata.category(after) == 'Nd'):
                continue
        output.append(char)
    return ''.join(output)


def valid_score(row):
    if not row or row.get('status') != 'scored' or row.get('finish_reason') != 'stop':
        return False
    if set(row).intersection(RESULT_KEYS) != RESULT_KEYS:
        return False
    if set(row) - RESULT_KEYS - RESULT_META_KEYS:
        return False
    for key, maximum in LIMITS.items():
        if type(row.get(key)) is not int or not 0 <= row[key] <= maximum:
            return False
    if type(row.get('total_score')) is not int or row['total_score'] != sum(row[key] for key in SCORE_KEYS):
        return False
    if any(type(row.get(key)) is not bool for key in ['repeated_question', 'fact_misuse', 'leading_question', 'missed_high_value_clue']):
        return False
    return isinstance(row.get('brief_reason'), str) and 0 < len(row['brief_reason']) <= 80


def baseline_data():
    frozen = ROOT / FROZEN_RUN_ID
    judged = ROOT / FROZEN_JUDGE_ID
    technical = load_jsonl(frozen / 'technical.jsonl')
    run_manifest = load_json(frozen / 'manifest.json')
    inputs = {row['candidate_id']: row for row in load_jsonl(judged / 'judge.jsonl')}
    latest = {}
    for row in load_jsonl(judged / 'judge-results.jsonl'):
        latest[row.get('candidate_id')] = row
    indexed = {}
    candidates = {}
    for mapping in run_manifest['samples']:
        sample = technical[int(mapping['technical_record_index'])]
        key = (sample['case_id'], int(sample['run']), mapping['variant'])
        indexed[key] = sample
        if mapping['variant'] == 'A' and sample['case_id'] in CASE_IDS:
            candidate_id = mapping['candidate_id']
            candidates[key] = {
                'sample': sample,
                'mapping': mapping,
                'input': inputs.get(candidate_id),
                'old_judge': latest.get(candidate_id),
                'candidate_id': candidate_id,
            }
    return frozen, judged, indexed, candidates


def prepare_probe(result_dir):
    result_dir = pathlib.Path(result_dir)
    frozen, judged, _, candidates = baseline_data()
    ranked = [entry for entry in candidates.values() if entry['input'] and entry['old_judge'] and entry['old_judge'].get('status') == 'scored']
    ranked.sort(key=lambda entry: (entry['old_judge']['total_score'], entry['sample']['case_id'], int(entry['sample']['run'])))
    if len(ranked) < 3:
        raise SystemExit(f'Need at least three scored historical A candidates; found {len(ranked)}')
    selected = [('low', ranked[0]), ('medium', ranked[len(ranked) // 2]), ('high', ranked[-1])]
    probe = result_dir / 'step5-probe'
    probe.mkdir(mode=0o700)
    probe_inputs = []
    probe_map = []
    for band, entry in selected:
        candidate = dict(entry['input'])
        candidate['user_answer'] = entry['sample'].get('actual_asr_text', '')
        candidate['next_question'] = entry['sample'].get('next_question', '')
        probe_inputs.append(candidate)
        probe_map.append({
            'band': band,
            'candidate_id': entry['candidate_id'],
            'case_id': entry['sample']['case_id'],
            'run': int(entry['sample']['run']),
            'historical_score': entry['old_judge']['total_score'],
        })
    random.SystemRandom().shuffle(probe_inputs)
    write_jsonl(probe / 'judge.jsonl', probe_inputs)
    write_json(probe / 'probe-map.json', probe_map)
    write_json(probe / 'run.json', {
        'benchmark_type': 'targeted_ab_regression_judge_probe',
        'judge_model': 'step-5-preview',
        'judge_endpoint': 'https://api.stepfun.com/step_plan/v1/chat/completions',
        'temperature': 0,
        'source_frozen_run_id': FROZEN_RUN_ID,
        'source_frozen_judge_id': FROZEN_JUDGE_ID,
        'candidate_count': len(probe_inputs),
        'selected_candidates': probe_map,
    })
    print('STEP5_PROBE_INPUTS', json.dumps([(item['band'], item['case_id'], item['run'], item['historical_score']) for item in probe_map], ensure_ascii=False))
    print('PROBE_DIR', probe)


def assert_runtime_parity(old, new, case_id, run):
    fields = [
        'status', 'realtime_model', 'realtime_provider', 'previous_question', 'expected_user_text',
        'audio_sha256', 'input_kind', 'base_prompt_sha256', 'session_setup_sha256',
        'case_input_sha256', 'response_parameters_sha256', 'response_parameters',
    ]
    mismatches = [key for key in fields if old.get(key) != new.get(key)]
    if mismatches:
        raise SystemExit(f'Frozen A parity failed for {case_id}-run{run}: {", ".join(mismatches)}')


def assemble(result_dir, gate_run_id, prompt_before, prompt_after, resolve_prompt_after):
    result_dir = pathlib.Path(result_dir)
    frozen, judged, old_samples, old_candidates = baseline_data()
    old_run = load_json(frozen / 'run.json')
    old_manifest = load_json(frozen / 'manifest.json')
    new_run_path = result_dir / 'run.json'
    new_run = load_json(new_run_path)
    new_manifest = load_json(result_dir / 'manifest.json')
    new_samples = load_jsonl(result_dir / 'technical.jsonl')
    if len(new_samples) != 12 or any(row.get('variant') != 'B' for row in new_samples):
        raise SystemExit('Expected exactly the 12 completed targeted B samples.')
    if old_run.get('story_context_sha256') != new_run.get('story_context_sha256'):
        raise SystemExit('Frozen A Story/context changed; refusing to compare.')
    if old_run.get('voice_profile') != new_run.get('voice_profile') or old_run.get('realtime_model') != new_run.get('realtime_model') or old_run.get('realtime_provider') != new_run.get('realtime_provider'):
        raise SystemExit('Frozen A model/provider/voice profile changed; refusing to compare.')
    if old_manifest.get('audio_manifest_sha256') != new_manifest.get('audio_manifest_sha256'):
        raise SystemExit('Canonical audio manifest changed; refusing to compare.')

    probe_dir = result_dir / 'step5-probe'
    probe_map = load_json(probe_dir / 'probe-map.json')
    probe_rows = load_jsonl(probe_dir / 'judge-results.jsonl')
    probe_latest = {}
    for row in probe_rows:
        probe_latest[row.get('candidate_id')] = row
    if len(probe_map) != 3 or any(not valid_score(probe_latest.get(entry['candidate_id'])) for entry in probe_map):
        raise SystemExit('Step 5 probe must have three final schema-valid, stop-finished scores before assembly.')
    reuse_ids = {(entry['case_id'], int(entry['run'])): entry['candidate_id'] for entry in probe_map}

    new_by_key = {(row['case_id'], int(row['run']), row['variant']): row for row in new_samples}
    output_samples = []
    mappings = []
    judge_candidates = []
    equivalence = []
    for case_id in CASE_IDS:
        for run in range(1, 4):
            old = old_samples.get((case_id, run, 'A'))
            new = new_by_key.get((case_id, run, 'B'))
            old_candidate = old_candidates.get((case_id, run, 'A'))
            if old is None or new is None or old_candidate is None or not old_candidate['input']:
                raise SystemExit(f'Missing frozen A or new B record for {case_id}-run{run}.')
            assert_runtime_parity(old, new, case_id, run)
            old_copy = dict(old)
            new_copy = dict(new)
            old_copy['source_run_id'] = FROZEN_RUN_ID
            old_copy['pair_input_equivalence'] = 'NOT_TESTED'
            new_copy['source_run_id'] = new_run['run_id']
            new_copy['pair_input_equivalence'] = 'NOT_TESTED'
            expected = normalize_asr(old['expected_user_text'])
            a_norm = normalize_asr(old.get('actual_asr_text') or '')
            b_norm = normalize_asr(new.get('actual_asr_text') or '')
            pair_ok = bool(expected and a_norm == expected and b_norm == expected and old.get('audio_sha256') == new.get('audio_sha256'))
            pair_status = 'PASS' if pair_ok else 'FAIL'
            for row in (old_copy, new_copy):
                row['pair_input_equivalence'] = pair_status
                row['input_equivalence'] = pair_status
                row['input_transcript_mismatch'] = not pair_ok
                row['primary_score_eligible'] = pair_ok
                if not pair_ok:
                    errors = list(row.get('errors') or [])
                    errors.append({'stage': 'pair_input_equivalence', 'code': 'PAIR_INPUT_MISMATCH'})
                    row['errors'] = errors
            equivalence.append({
                'case_id': case_id, 'run': run, 'status': pair_status,
                'audio_sha256_A': old.get('audio_sha256'), 'audio_sha256_B': new.get('audio_sha256'),
                'expected_normalized': expected, 'A_normalized_asr': a_norm, 'B_normalized_asr': b_norm,
            })
            pair = [('A', old_copy), ('B', new_copy)]
            for variant, sample in pair:
                index = len(output_samples)
                output_samples.append(sample)
                candidate_id = reuse_ids.get((case_id, run)) if variant == 'A' else None
                candidate_id = candidate_id or str(uuid.uuid4())
                template = old_candidate['input']
                candidate = dict(template)
                candidate.update({
                    'candidate_id': candidate_id,
                    'case_id': case_id,
                    'previous_question': sample['previous_question'],
                    'user_answer': sample.get('actual_asr_text', ''),
                    'next_question': sample.get('next_question', ''),
                })
                judge_candidates.append(candidate)
                mappings.append({
                    'candidate_id': candidate_id,
                    'variant': variant,
                    'run': run,
                    'case_id': case_id,
                    'technical_record_index': index,
                    'source_run_id': FROZEN_RUN_ID if variant == 'A' else new_run['run_id'],
                    'input_equivalence': pair_status,
                })
    random.SystemRandom().shuffle(judge_candidates)
    write_jsonl(result_dir / 'technical.jsonl', output_samples)
    write_jsonl(result_dir / 'judge.jsonl', judge_candidates)
    write_jsonl(result_dir / 'judge-results.jsonl', probe_rows)
    new_manifest.update({
        'benchmark_type': 'targeted_ab_regression',
        'sample_count_planned': len(mappings),
        'frozen_a_source_run_id': FROZEN_RUN_ID,
        'frozen_a_source_judge_id': FROZEN_JUDGE_ID,
        'gate_probe_run_id': gate_run_id,
        'frozen_a_parity': 'PASS',
        'input_equivalence': equivalence,
        'primary_score_excluded_candidates': [entry['candidate_id'] for entry in mappings if entry['input_equivalence'] != 'PASS'],
        'samples': mappings,
        'judge_probe_reused_candidate_ids': [entry['candidate_id'] for entry in probe_map],
    })
    write_json(result_dir / 'manifest.json', new_manifest)
    new_run.update({
        'benchmark_type': 'targeted_ab_regression',
        'cases': CASE_IDS,
        'variants': ['A', 'B'],
        'runs': 3,
        'samples_planned': 24,
        'realtime_samples_planned': 12,
        'realtime_samples_attempted': 12,
        'frozen_a_samples_reused': 12,
        'frozen_a_run_id': FROZEN_RUN_ID,
        'frozen_a_judge_run_id': FROZEN_JUDGE_ID,
        'gate_probe_run_id': gate_run_id,
        'frozen_a_commit_sha': old_run.get('commit_sha'),
        'judge_model': 'step-5-preview',
        'judge_endpoint': 'https://api.stepfun.com/step_plan/v1/chat/completions',
        'judge_temperature': 0,
        'judge_concurrency': 2,
        'judge_prompt_version': 'targeted-ab-json-schema-v1',
        'gate_prompt_chars_before': prompt_before,
        'gate_prompt_chars_after': prompt_after,
        'resolve_prompt_chars_after': resolve_prompt_after,
        'step5_probe_passed': True,
        'repeat_commands': [
            'bash scripts/codex-node.sh npm run benchmark:next-question:gate-probe',
            'NEXT_QUESTION_BENCHMARK_TYPE=targeted_ab_regression bash scripts/codex-node.sh npm run benchmark:next-question -- --cases C03,C05,C06,C10 --variants B --runs 3',
            f'python3 benchmark/next-question/targeted_ab_report.py prepare-probe --result-dir {result_dir}',
            f'bash scripts/codex-node.sh npm run benchmark:next-question:judge -- --result-dir {result_dir}/step5-probe',
            f'python3 benchmark/next-question/targeted_ab_report.py assemble --result-dir {result_dir} --gate-run-id {gate_run_id} --prompt-before {prompt_before} --prompt-after {prompt_after}',
            f'bash scripts/codex-node.sh npm run benchmark:next-question:judge -- --result-dir {result_dir}',
            f'python3 benchmark/next-question/targeted_ab_report.py summarize --result-dir {result_dir}',
        ],
    })
    write_json(new_run_path, new_run)
    print(f'ASSEMBLED {len(output_samples)} technical rows; {len(judge_candidates)} blinded Judge candidates; {sum(row["status"] == "PASS" for row in equivalence)}/12 input-equivalent pairs.')
    print(f'RESULT_DIR {result_dir}')


def mean(values):
    return sum(values) / len(values) if values else None


def rounded(value):
    return round(value, 2) if value is not None else None


def score_latest(result_dir):
    latest = {}
    attempts = load_jsonl(result_dir / 'judge-results.jsonl')
    for row in attempts:
        latest[row.get('candidate_id')] = row
    return attempts, latest


def summarize(result_dir):
    result_dir = pathlib.Path(result_dir)
    run = load_json(result_dir / 'run.json')
    manifest = load_json(result_dir / 'manifest.json')
    technical = load_jsonl(result_dir / 'technical.jsonl')
    attempts, latest = score_latest(result_dir)
    mapping = {row['candidate_id']: row for row in manifest['samples']}
    technical_by_index = {i: row for i, row in enumerate(technical)}
    scores = {}
    for candidate_id, entry in mapping.items():
        sample = technical_by_index[int(entry['technical_record_index'])]
        judge = latest.get(candidate_id)
        if sample.get('primary_score_eligible') and valid_score(judge):
            scores[(sample['case_id'], int(sample['run']), entry['variant'])] = judge
    pairs = []
    case_stats = {}
    for case_id in CASE_IDS:
        rows = []
        for run_number in range(1, 4):
            a = scores.get((case_id, run_number, 'A'))
            b = scores.get((case_id, run_number, 'B'))
            sample_a = next((row for row in technical if row.get('case_id') == case_id and int(row.get('run', 0)) == run_number and row.get('variant') == 'A'), None)
            sample_b = next((row for row in technical if row.get('case_id') == case_id and int(row.get('run', 0)) == run_number and row.get('variant') == 'B'), None)
            delta = b['total_score'] - a['total_score'] if a and b else None
            item = {'case_id': case_id, 'run': run_number, 'A': a, 'B': b, 'delta': delta, 'sample_A': sample_a, 'sample_B': sample_b}
            rows.append(item)
            if delta is not None:
                pairs.append(item)
        case_stats[case_id] = rows
    deltas = [row['delta'] for row in pairs]
    all_a = [row['A']['total_score'] for row in pairs]
    all_b = [row['B']['total_score'] for row in pairs]
    dimensions = {}
    for dimension in SCORE_KEYS:
        ds = [row['B'][dimension] - row['A'][dimension] for row in pairs]
        dimensions[dimension] = {'mean_paired_delta': rounded(mean(ds)), 'paired_n': len(ds)}
    by_case = {}
    for case_id, rows in case_stats.items():
        usable = [row for row in rows if row['delta'] is not None]
        by_case[case_id] = {
            'valid_pairs': len(usable),
            'A_mean': rounded(mean([row['A']['total_score'] for row in usable])),
            'B_mean': rounded(mean([row['B']['total_score'] for row in usable])),
            'mean_delta': rounded(mean([row['delta'] for row in usable])),
        }
    b_samples = [row for row in technical if row.get('variant') == 'B']
    gate_probe_dir = ROOT / f"gate-probe-{run.get('gate_probe_run_id')}"
    gate_rows = load_jsonl(gate_probe_dir / 'gate-results.jsonl') if gate_probe_dir.exists() else []
    gate_counts = {case: sum(row.get('schema_valid') is True and row.get('action') != 'none' for row in gate_rows if row.get('case_id') == case) for case in CASE_IDS}
    first_attempt = [row for row in attempts if int(row.get('judge_attempt', 1)) == 1]
    schema_invalid = sum(row.get('error_code') in {'JUDGE_RESPONSE_SCHEMA_INVALID', 'JUDGE_RESPONSE_INVALID_JSON'} for row in attempts)
    token_limit = sum(row.get('error_code') == 'JUDGE_OUTPUT_TOKEN_LIMIT' for row in attempts)
    http_failures = sum(isinstance(row.get('http_status'), int) and row.get('status') == 'failed' for row in attempts)
    retries = sum(int(row.get('judge_attempt', 1)) > 1 for row in attempts)
    candidates_retried = len({row.get('candidate_id') for row in attempts if int(row.get('judge_attempt', 1)) > 1})
    first_valid_ids = {row.get('candidate_id') for row in first_attempt if valid_score(row)}
    final_valid_ids = {candidate_id for candidate_id, row in latest.items() if valid_score(row)}
    probe_dir = result_dir / 'step5-probe'
    probe_attempts, probe_latest = score_latest(probe_dir)
    probe_map = load_json(probe_dir / 'probe-map.json')
    probe_ok = len(probe_map) == 3 and all(valid_score(probe_latest.get(row['candidate_id'])) for row in probe_map)
    mismatches = [row for row in manifest.get('input_equivalence', []) if row.get('status') != 'PASS']
    coach_fail_open = sum(row.get('coach_status') == 'failed_open' for row in b_samples)
    coach_intervened = sum(isinstance(row.get('gate'), dict) and row['gate'].get('action') != 'none' for row in b_samples)
    no_gain = [row for row in pairs if isinstance(row['sample_B'].get('gate'), dict) and row['sample_B']['gate'].get('action') != 'none' and row['delta'] <= 0]
    conclusion = 'INCONCLUSIVE'
    if len(pairs) == 12 and mean(deltas) is not None:
        case_deltas = [value['mean_delta'] for value in by_case.values() if value['mean_delta'] is not None]
        positive_cases = sum(value > 0 for value in case_deltas)
        negative_cases = sum(value < 0 for value in case_deltas)
        if mean(deltas) > 0 and statistics.median(deltas) > 0 and positive_cases >= 3:
            conclusion = 'SUPPORTED'
        elif mean(deltas) < 0 and statistics.median(deltas) < 0 and negative_cases >= 3:
            conclusion = 'NOT SUPPORTED'

    quality = {
        'valid_pairs': len(pairs), 'excluded_pairs': 12 - len(pairs),
        'A_mean': rounded(mean(all_a)), 'B_mean': rounded(mean(all_b)),
        'mean_paired_delta': rounded(mean(deltas)),
        'median_paired_delta': rounded(statistics.median(deltas)) if deltas else None,
        'dimensions': dimensions,
        'by_case': by_case,
        'coach_targeted_improvement': conclusion,
    }
    probe_first_valid = sum(valid_score(row) for row in probe_attempts if int(row.get('judge_attempt', 1)) == 1)
    summary = {
        'benchmark_type': 'targeted_ab_regression',
        'branch': 'benchmark/next-question',
        'run_id': run.get('run_id'),
        'commit_sha': run.get('commit_sha'),
        'result_directory': str(result_dir),
        'frozen_a_run_id': FROZEN_RUN_ID,
        'frozen_a_judge_run_id': FROZEN_JUDGE_ID,
        'gate_probe_run_id': run.get('gate_probe_run_id'),
        'gate_prompt_chars_before': run.get('gate_prompt_chars_before'),
        'gate_prompt_chars_after': run.get('gate_prompt_chars_after'),
        'gate_probe': {
            'schema_valid': sum(row.get('schema_valid') is True for row in gate_rows),
            'evaluations': len(gate_rows), 'interventions_by_case': gate_counts,
            'total_interventions': sum(gate_counts.values()),
            'readiness': 'PASS' if all(gate_counts.get(case, 0) >= 2 for case in CASE_IDS) and sum(gate_counts.values()) >= 8 else 'FAIL',
        },
        'realtime': {
            'new_b_samples_completed': sum(row.get('status') == 'completed' for row in b_samples),
            'new_b_samples_attempted': len(b_samples),
            'input_equivalent_pairs': sum(row.get('status') == 'PASS' for row in manifest.get('input_equivalence', [])),
            'excluded_pairs': mismatches,
            'runtime_parity': manifest.get('frozen_a_parity'),
            'b_gate_interventions': coach_intervened,
            'b_coach_fail_open': coach_fail_open,
        },
        'judge': {
            'model': 'step-5-preview',
            'endpoint': 'https://api.stepfun.com/step_plan/v1/chat/completions',
            'temperature': 0,
            'concurrency': 2,
            'probe': {'passed': probe_ok, 'final_valid': sum(valid_score(probe_latest.get(row['candidate_id'])) for row in probe_map), 'n': len(probe_map), 'first_attempt_valid': probe_first_valid, 'attempts': len(probe_attempts)},
            'candidate_count': len(mapping), 'first_attempt_schema_valid': len(first_valid_ids), 'final_schema_valid': len(final_valid_ids),
            'schema_invalid_attempts': schema_invalid, 'output_token_limit_attempts': token_limit,
            'http_failures': http_failures, 'retry_attempts': retries, 'candidates_retried': candidates_retried,
            'attempts': len(attempts), 'judge_failures_final': sum(not valid_score(latest.get(candidate_id)) for candidate_id in mapping),
        },
        'quality': quality,
        'case_details': {
            case_id: [{
                'run': row['run'],
                'input_equivalence': row['sample_B'].get('pair_input_equivalence') if row['sample_B'] else 'NOT_TESTED',
                'A_score': row['A']['total_score'] if row['A'] else None,
                'B_score': row['B']['total_score'] if row['B'] else None,
                'delta': row['delta'],
                'A_dimensions': {key: row['A'][key] for key in SCORE_KEYS} if row['A'] else None,
                'B_dimensions': {key: row['B'][key] for key in SCORE_KEYS} if row['B'] else None,
                'A_question': row['sample_A'].get('next_question') if row['sample_A'] else None,
                'gate': row['sample_B'].get('gate') if row['sample_B'] else None,
                'coach_packet': row['sample_B'].get('coach_packet') if row['sample_B'] else None,
                'B_question': row['sample_B'].get('next_question') if row['sample_B'] else None,
                'errors': row['sample_B'].get('errors') if row['sample_B'] else None,
            } for row in case_stats[case_id]],
        },
        'intervention_but_no_improvement': [{
            'case_id': row['case_id'], 'run': row['run'], 'delta': row['delta'],
            'gate_action': row['sample_B']['gate'].get('action'),
            'gate_reason': row['sample_B']['gate'].get('reason'),
            'gate_direction': row['sample_B']['gate'].get('direction'),
            'coach_packet': row['sample_B'].get('coach_packet'),
            'next_question': row['sample_B'].get('next_question'),
        } for row in no_gain],
    }
    write_json(result_dir / 'summary.json', summary)
    lines = [
        '# Targeted Coach A/B Regression', '',
        f'- Run ID: `{summary["run_id"]}`; benchmark_type: `targeted_ab_regression`',
        f'- Branch/commit: `{summary["branch"]}` / `{summary["commit_sha"]}`',
        f'- Frozen A: `{FROZEN_RUN_ID}`; Judge source: `{FROZEN_JUDGE_ID}`',
        f'- Gate Probe: {summary["gate_probe"]["schema_valid"]}/{summary["gate_probe"]["evaluations"]} schema-valid; interventions C03/C05/C06/C10 = {gate_counts.get("C03",0)}/3, {gate_counts.get("C05",0)}/3, {gate_counts.get("C06",0)}/3, {gate_counts.get("C10",0)}/3; readiness {summary["gate_probe"]["readiness"]}.',
        f'- Gate prompt: {summary["gate_prompt_chars_before"]} → {summary["gate_prompt_chars_after"]} characters; Resolve prompt now {run.get("resolve_prompt_chars_after", "not recorded")} characters.',
        f'- Realtime: {summary["realtime"]["new_b_samples_completed"]}/{summary["realtime"]["new_b_samples_attempted"]} new B complete; input-equivalent pairs {summary["realtime"]["input_equivalent_pairs"]}/12; Frozen A runtime parity {summary["realtime"]["runtime_parity"]}.',
        f'- Step 5 Probe: {summary["judge"]["probe"]["final_valid"]}/{summary["judge"]["probe"]["n"]} final valid ({summary["judge"]["probe"]["first_attempt_valid"]}/3 first-attempt valid; {summary["judge"]["probe"]["attempts"]} attempts); PASS={str(probe_ok).upper()}.',
        f'- Judge: {summary["judge"]["first_attempt_schema_valid"]}/{summary["judge"]["candidate_count"]} first-attempt valid; {summary["judge"]["final_schema_valid"]}/{summary["judge"]["candidate_count"]} final valid; schema-invalid attempts {schema_invalid}; output-token-limit {token_limit}; HTTP failures {http_failures}; retry calls {retries} across {candidates_retried} candidates.',
        '', '## Overall paired quality', '',
        '| Metric | Value |', '|---|---:|',
        f'| Valid input-equivalent judged pairs | {len(pairs)}/12 |',
        f'| Frozen A mean | {quality["A_mean"]} |', f'| New B mean | {quality["B_mean"]} |',
        f'| Mean paired delta (B − A) | {quality["mean_paired_delta"]} |',
        f'| Median paired delta | {quality["median_paired_delta"]} |',
        '', '## Score dimensions', '', '| Dimension | Mean paired delta (B − A) |', '|---|---:|',
        *[f'| {key} | {value["mean_paired_delta"]} (n={value["paired_n"]}) |' for key, value in dimensions.items()],
        '', '## Case means', '', '| Case | Frozen A mean | New B mean | Mean delta | Valid pairs |', '|---|---:|---:|---:|---:|',
        *[f'| {case} | {data["A_mean"]} | {data["B_mean"]} | {data["mean_delta"]} | {data["valid_pairs"]}/3 |' for case, data in by_case.items()],
        '', '## Per-run candidates', '',
    ]
    for case_id in CASE_IDS:
        lines += [f'### {case_id}', '', '| Run | Input | A score / question | Gate | Coach packet | B score / question | Delta |', '|---:|---|---|---|---|---|---:|']
        for row in case_stats[case_id]:
            a_score = row['A']['total_score'] if row['A'] else 'n/a'
            b_score = row['B']['total_score'] if row['B'] else 'n/a'
            gate = row['sample_B'].get('gate') if row['sample_B'] else None
            gate_text = f"{gate.get('action')} / {gate.get('reason')}: {gate.get('direction')}" if isinstance(gate, dict) else 'none / no packet'
            packet = row['sample_B'].get('coach_packet') if row['sample_B'] else None
            packet_text = json.dumps(packet, ensure_ascii=False) if packet else '—'
            lines.append(f'| {row["run"]} | {row["sample_B"].get("pair_input_equivalence") if row["sample_B"] else "NOT_TESTED"} | {a_score}: {row["sample_A"].get("next_question") if row["sample_A"] else "n/a"} | {gate_text} | {packet_text} | {b_score}: {row["sample_B"].get("next_question") if row["sample_B"] else "n/a"} | {row["delta"] if row["delta"] is not None else "n/a"} |')
        lines.append('')
    lines += ['## Intervention without improvement', '']
    if no_gain:
        for row in no_gain:
            gate = row['sample_B'].get('gate') or {}
            lines.append(f'- {row["case_id"]}-run{row["run"]}: delta {row["delta"]}; {gate.get("reason")}; direction: {gate.get("direction")}; Mini asked: {row["sample_B"].get("next_question")}. Coach packet: {row["sample_B"].get("coach_packet") or "none"}.')
    else:
        lines.append('- None among input-equivalent, validly judged pairs.')
    lines += [
        '', '## Conclusion', '',
        f'- Coach targeted improvement: **{conclusion}**. A conclusive label requires all 12 valid pairs and at least 3 of 4 case means to share the mean/median direction; this is a 4-case targeted regression, not a full benchmark.',
        f'- B Gate intervention: {coach_intervened}/{len(b_samples)} samples; Coach fail-open: {coach_fail_open}/{len(b_samples)}.',
        f'- Result directory: `{result_dir}`',
    ]
    path = result_dir / 'summary.md'
    path.write_text('\n'.join(lines) + '\n')
    path.chmod(0o600)
    print(f'SUMMARY {quality["A_mean"]} → {quality["B_mean"]}; paired delta={quality["mean_paired_delta"]}; valid pairs={len(pairs)}/12; {conclusion}')
    print(f'SUMMARY_PATH {path}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare-probe', 'assemble', 'summarize'])
    parser.add_argument('--result-dir', required=True)
    parser.add_argument('--gate-run-id', default='')
    parser.add_argument('--prompt-before', type=int, default=2253)
    parser.add_argument('--prompt-after', type=int, default=0)
    parser.add_argument('--resolve-prompt-after', type=int, default=685)
    args = parser.parse_args()
    if args.mode == 'prepare-probe':
        prepare_probe(args.result_dir)
    elif args.mode == 'assemble':
        assemble(args.result_dir, args.gate_run_id, args.prompt_before, args.prompt_after, args.resolve_prompt_after)
    else:
        summarize(pathlib.Path(args.result_dir))


if __name__ == '__main__':
    main()
