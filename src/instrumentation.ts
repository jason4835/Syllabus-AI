import type { Instrumentation } from "next";

/**
 * Catches the server errors the application never saw.
 *
 * Routes here answer failures through `logApiError`, which is how almost every
 * error reaches the log drain and, now, the alert inbox. Almost. A route's
 * `try` block starts *after* it has resolved the caller:
 *
 *     const { userId } = await resolveVisitor();   // <- outside the try
 *     if (!userId) return fail("Sign in first.", 401);
 *     try { ...the actual work... } catch (err) { logApiError(...) }
 *
 * `resolveVisitor` reads and writes the store. So when the store is down --
 * disk full, Supabase unreachable, credentials rotated -- roughly twenty routes
 * throw before their own error handling exists. Next turns that into a 500 and
 * prints it to stderr, and nothing in this app is told. The failure most worth
 * being woken up for was the one failure that could not page anybody.
 *
 * `onRequestError` is Next's hook for precisely that: every uncaught server
 * error, from a route handler, a server component, or middleware. Fixing it
 * here rather than by moving twenty `try` blocks is the smaller diff AND the
 * more durable one -- a route written next year is covered without its author
 * knowing this file exists.
 *
 * No double reporting: an error that a route caught and logged never reaches
 * this hook, by definition.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  // Imported lazily, inside the hook. `instrumentation.ts` is evaluated before
  // the app boots, and a module-scope import here would drag the logger (and
  // everything it touches) into that phase for every runtime, including ones
  // that never use it.
  const { logApiError } = await import("@/lib/log");

  logApiError("server.unhandled", err, {
    // The path, never the query string: a calendar feed URL carries the
    // student's feed token, and this ends up in a log drain and an email.
    path: request.path.split("?")[0],
    method: request.method,
    // "render" vs "route" vs "middleware", and which of Next's phases --
    // enough to know where to look without opening a trace.
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
