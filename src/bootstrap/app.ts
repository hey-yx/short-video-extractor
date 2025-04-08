import { Elysia } from "elysia";
import globalRouterPlugin from "@/routes/all.routes";
import { errorHook } from "@/hooks";
import { cors } from "@elysiajs/cors";
import "dayjs/locale/zh-cn";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
// import { puppeteerManager } from "@/utils/puppeteer";

// 设置全局语言为中文
dayjs.locale("zh-cn");
dayjs.extend(utc);

// 启动时打开两个标签页
// (async () => {
// 	await puppeteerManager.createNewPage(false);
// })();

const ClientAddrs = [
	"http://localhost:5173",
	/^https:\/\/.*\.lite\.vusercontent\.net$/,
	/^https:\/\/.*\.itcox\.cn$/,
];

export const createApp = () => {
	const app = new Elysia()
		.onError((error) => {
			return errorHook(error);
		})
		.use(
			cors({
				origin: [...ClientAddrs],
			}),
		)
		.get(
			"/",
			() =>
				"welcome to short-video-extractor server, please visit https://github.com/itcox/short-video-extractor for more information",
		)
		.use(globalRouterPlugin);

	return app;
};
