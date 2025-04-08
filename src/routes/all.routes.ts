import { Elysia } from "elysia";
import CommonPlugin from "./public.routes";

import { publicModels } from "@/models/public.model";
import { parseVideo } from "@/controllers/public/parseVideo";
import { transferPlatform } from "@/controllers/platform-transfer";

const plugin = new Elysia()
	.use(CommonPlugin)
	.use(publicModels)
	// .post("/pv", parseVideo, { body: "parseVideo" })
	.post("/pv", transferPlatform, { body: "parseVideo" });

export default plugin;
