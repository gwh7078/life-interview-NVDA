export class OnboardingWorkflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409,
    readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OnboardingWorkflowError';
  }
}
