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
import { puppeteerManager } from "@/utils/puppeteer";

// 设置全局语言为中文
dayjs.locale("zh-cn");
dayjs.extend(utc);

// 启动时打开两个标签页
(async () => {
  await puppeteerManager.createNewPage(false);
})();

const ClientAddrs = [
  "http://localhost:5173",
  /^https:\/\/.*\.lite\.vusercontent\.net$/,
  /^https:\/\/.*\.itcox\.cn$/,
];

export const createApp = () => {
  const app = new Elysia()
    .onError((error) => {
      return errorHook(error);
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
