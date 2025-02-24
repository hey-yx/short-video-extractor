import { Elysia } from "elysia";
import { cron } from "@elysiajs/cron";

import { getCaptcha, clearExpiredCaptcha } from "@/controllers/public/captcha";
import {
  getEmailCaptcha,
  clearExpiredEmailCaptcha,
} from "@/controllers/public/emailCaptcha";
import { parseVideo } from "@/controllers/public/parseVideo";
import { publicModels } from "@/models/public.model";

const plugin = new Elysia({ prefix: "/public" })
  .use(publicModels)
  .use(
    cron({
      name: "Detection verification pool",
      pattern: "*/5 * * * *",
      run() {
        clearExpiredCaptcha(5);
        clearExpiredEmailCaptcha(10);
      },
    }),
  )
  .get("/captcha", getCaptcha)
  .get("/emailCaptcha", getEmailCaptcha, { query: "getEmailCaptcha" })
  .post("/parseVideo", parseVideo, { body: "parseVideo" });

export default plugin;
