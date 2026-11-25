export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "slug_taken"
  | "version_conflict"
  | "invalid_path"
  | "invalid_slug"
  | "too_large"
  | "standard_page"
  | "invalid_body"
  | "rate_limited"
  | "email_taken"
  | "forbidden"
  | "quota_exceeded";

/** An error the HTTP API, MCP tools and web pages all know how to present. */
export class AppError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409 | 422 | 429,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}
