import { Elysia } from "elysia";
import { cron } from "@elysiajs/cron";

import { parseVideo } from "@/controllers/public/parseVideo";
import { resetPuppeteerInstance } from "@/controllers/public/cronTasks";
import { publicModels } from "@/models/public.model";

const plugin = new Elysia({ prefix: "/public" })
  .use(publicModels)
  .use(
    cron({
      name: "reset-puppeteer",
      pattern: "0 */6 * * *", // 每6小时执行一次
      run() {
        return resetPuppeteerInstance();
      },
    }),
  )
  .post("/parseVideo", parseVideo, { body: "parseVideo" });

export default plugin;
