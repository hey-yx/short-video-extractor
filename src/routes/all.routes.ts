import { Elysia } from "elysia";
import CommonPlugin from "./public.routes";
import PuppeteerPlugin from "./puppeteer.routes";

const plugin = new Elysia().use(CommonPlugin).use(PuppeteerPlugin);

export default plugin;
