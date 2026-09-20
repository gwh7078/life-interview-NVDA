export class CloseoutWorkflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 400,
    readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CloseoutWorkflowError';
  }
}
