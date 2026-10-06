// Next routes, instrumentation and HMR can load distinct copies of this class.
// A process-wide brand preserves typed HTTP errors across those module graphs.
const INPUT_ERROR = Symbol.for("scope.x.research.input-error.v1");
export class ResearchInputError extends Error {
  readonly [INPUT_ERROR] = true;
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ResearchInputError";
  }
}
export function isResearchInputError(error: unknown): error is ResearchInputError {
  return Boolean(
    error &&
    typeof error === "object" &&
    INPUT_ERROR in error &&
    (error as ResearchInputError)[INPUT_ERROR] === true &&
    typeof (error as ResearchInputError).message === "string" &&
    Number.isInteger((error as ResearchInputError).status) &&
    (error as ResearchInputError).status >= 400 &&
    (error as ResearchInputError).status <= 599,
  );
}
