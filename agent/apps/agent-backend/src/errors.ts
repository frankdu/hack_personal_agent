export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const missing = () =>
  new ApiError(404, "NOT_FOUND", "Resource not found.");
