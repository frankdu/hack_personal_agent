import { apiErrorSchema } from "@agent/contracts";

export type Connection = { id: string; baseUrl: string; token: string };
type Parser<T> = { parse: (value: unknown) => T };

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function normalizeBackendUrl(input: string): string {
  const url = new URL(input.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use an HTTP or HTTPS backend URL without credentials, a query, or a fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export async function apiRequest<T>(
  connection: Connection,
  path: string,
  schema: Parser<T>,
  options: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`${connection.baseUrl}${path}`, {
    method: options.method ?? "GET",
    credentials: "omit",
    cache: "no-store",
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(data);
    throw new ApiRequestError(
      response.status,
      parsed.success ? parsed.data.error.code : "http_error",
      parsed.success
        ? parsed.data.error.message
        : `Backend request failed (${response.status}).`,
    );
  }
  return schema.parse(data);
}

export function errorText(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 401)
    return "Authorization failed. Check your operator token and reconnect.";
  if (error instanceof ApiRequestError && error.status === 403)
    return "The backend denied this operation. Check this operator's permissions.";
  if (error instanceof TypeError)
    return "Cannot reach the backend. Check its address, network connection, and allowed browser origin.";
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "The backend did not answer in time. Its operation may still be running.";
  // Schema errors can contain backend data; keep the public message small.
  if (error instanceof Error && error.name === "ZodError")
    return "The backend response does not match this client's protocol.";
  return error instanceof Error
    ? error.message
    : "An unexpected backend error occurred.";
}

export function submissionMayHaveSucceeded(error: unknown): boolean {
  return !(
    error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500
  );
}
