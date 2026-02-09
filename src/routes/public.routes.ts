import { Elysia } from "elysia";

import { transferPlatform } from "@/controllers/platform-transfer";
import { publicModels } from "@/models/public.model";
import {
  getCacheStats,
  clearAllCache,
  deleteCache,
} from "@/controllers/cache.controller";

const plugin = new Elysia({ prefix: "/public" })
  .use(publicModels)
  .post("/parseVideo", transferPlatform, { body: "parseVideo" })
  // 缓存管理接口
  .get("/cache/stats", getCacheStats)
  .post("/cache/clear", clearAllCache)
  .post("/cache/delete", deleteCache);

export default plugin;
