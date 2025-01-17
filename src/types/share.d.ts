import { Context } from "elysia";
import { JWTPayloadSpec } from "@elysiajs/jwt";

declare global {
  namespace ItcoxTypes {
    type UserAuthPayload = {
      id: number;
      email: string;
      exp: number;
    };
    type UserAuthWithoutExp = Omit<UserAuthPayload, "exp">;

    interface ContextPro extends Context {
      jwt: {
        sign(
          morePayload: Record<string, string | number> & JWTPayloadSpec,
        ): Promise<string>;
        verify(
          token: string,
        ): Promise<(Record<string, string | number> & JWTPayloadSpec) | false>;
      };
      bearer: string | null;
    }
  }
}
