/**
 * The minimal schema interface of the kernel's hand-written runtime parsers: a parser either
 * succeeds with its data or fails with the first issue, and a thrown error is reported as an
 * uninspectable value rather than escaping.
 */

export type RuntimeIssue = Readonly<{ message: string; path: readonly PropertyKey[] }>;
export type RuntimeParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; error: Readonly<{ issues: readonly RuntimeIssue[] }> }>;
export type RuntimeSchema<T> = Readonly<{
  safeParse: (value: unknown) => RuntimeParseResult<T>;
  parse: (value: unknown) => T;
}>;

export function createRuntimeSchema<T>(
  parser: (value: unknown) => RuntimeParseResult<T>,
): RuntimeSchema<T> {
  const safeParse = (value: unknown): RuntimeParseResult<T> => {
    try {
      return parser(value);
    } catch {
      return runtimeFailure("Runtime schema validation could not inspect the value safely.", []);
    }
  };
  return Object.freeze({
    safeParse,
    parse(value: unknown): T {
      const result = safeParse(value);
      if (result.success) return result.data;
      throw new Error(result.error.issues[0]?.message ?? "Runtime schema validation failed.");
    },
  });
}

export function runtimeFailure<T>(
  message: string,
  path: readonly PropertyKey[],
): RuntimeParseResult<T> {
  return { success: false, error: { issues: [{ message, path }] } };
}
