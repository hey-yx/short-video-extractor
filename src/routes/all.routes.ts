import { Elysia } from "elysia";
import CommonPlugin from "./public.routes";

import { publicModels } from "@/models/public.model";
import { parseVideo } from "@/controllers/public/parseVideo";

const plugin = new Elysia()
  .use(CommonPlugin)
  .use(publicModels)
  .post("/pv", parseVideo, { body: "parseVideo" });

export default plugin;
