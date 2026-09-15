import * as Schema from "effect/Schema";

export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export const appError = (code: string, message: string) => new AppError({ code, message });
