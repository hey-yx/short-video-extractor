import { Elysia } from "elysia";
import { cron } from "@elysiajs/cron";

import { parseVideo } from "@/controllers/public/parseVideo";
import { publicModels } from "@/models/public.model";

const plugin = new Elysia({ prefix: "/public" })
  .use(publicModels)
  .post("/parseVideo", parseVideo, { body: "parseVideo" });

export default plugin;
