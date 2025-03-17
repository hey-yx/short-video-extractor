import type { Elysia } from "elysia";

export const createAuthHook = (app: Elysia) =>
  app.derive(({ headers }) => {
    const auth = headers.authorization;
    return {
      bearer: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
    };
  });
