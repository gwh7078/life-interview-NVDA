interface NatValidation {
  contract_valid?: unknown;
  backend_validation?: unknown;
  semantic_valid?: unknown;
  semantic_checks?: unknown;
}

interface NatResult {
  status?: unknown;
  validation?: NatValidation;
}

interface CoachGateSample {
  route?: unknown;
  latency_ms?: unknown;
}

export function isNatPathPassing(result: NatResult): boolean {
  const validation = result.validation;
  const checks = validation?.semantic_checks;
  return result.status === 'succeeded'
    && validation?.contract_valid === true
    && validation.backend_validation === 'passed'
    && validation.semantic_valid === true
    && Array.isArray(checks)
    && checks.every((check) => typeof check === 'object'
      && check !== null
      && 'passed' in check
      && check.passed === true);
}

export function isCoachGatePassing(
  expectedRoute: string,
  samples: readonly CoachGateSample[],
  budgetMs: number,
): boolean {
  return samples.length > 0 && samples.every((sample) => sample.route === expectedRoute
    && typeof sample.latency_ms === 'number'
    && Number.isFinite(sample.latency_ms)
    && sample.latency_ms <= budgetMs);
}
