import { Elysia } from "elysia";
import CommonPlugin from "./public.routes";

import { publicModels } from "@/models/public.model";
import { transferPlatform } from "@/controllers/platform-transfer";

const plugin = new Elysia()
	.use(CommonPlugin)
	.use(publicModels)
	.post("/pv", transferPlatform, { body: "parseVideo" });

export default plugin;
