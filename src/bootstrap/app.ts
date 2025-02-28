import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import globalRouterPlugin from "@/routes/all.routes";
import authWhitelist from "@/bootstrap/auth-whitelist";
import { errorHook, createAuthHook } from "@/hooks";
import { cors } from "@elysiajs/cors";
import { jwt } from "@elysiajs/jwt";
import "dayjs/locale/zh-cn";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

// 设置全局语言为中文
dayjs.locale("zh-cn");
dayjs.extend(utc);

const ClientAddrs = [
  "http://localhost:5173",
  /^https:\/\/.*\.vusercontent\.net$/,
  "https://short-video-extractor.itcox.cn",
];

export const createApp = () => {
  const app = new Elysia()
    .onError((error) => {
      return errorHook(error as any);
    })
    .use(
      cors({
        origin: [...ClientAddrs],
      }),
    )
    .use(
      jwt({
        name: "jwt",
        secret: Bun.env.JWT_SECRET as string,
        exp: "7d",
      }),
    )
    .use(staticPlugin())
    .use(createAuthHook)
    .onBeforeHandle(authWhitelist)
    .get("/", () => "Hello Elysia")
    .use(globalRouterPlugin);

  return app;
};
