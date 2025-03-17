import type { ErrorHandler } from "elysia";

export const errorHook: ErrorHandler = ({ code, error, set }) => {
  set.status = 400;
  const message = code !== "UNKNOWN" ? error.toString() : "Bad Request";
  return new Response(message, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
};
