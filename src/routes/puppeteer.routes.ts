import { Elysia } from "elysia";
import { puppeteerModels } from "@/models/puppeteer.model";
import { parseVideo } from "@/controllers/puppeteer/parseVideo";

const plugin = new Elysia({ prefix: "/puppeteer" })
  .use(puppeteerModels)
  .post("/parse", parseVideo, { body: "parseVideo" });

export default plugin;
