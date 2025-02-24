import { Elysia } from "elysia";
import CommonPlugin from "./public.routes";

const plugin = new Elysia().use(CommonPlugin);

export default plugin;
