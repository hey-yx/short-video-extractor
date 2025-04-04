import { createApp } from "./app";
import { cron } from "@elysiajs/cron";

export const startServer = () => {
	const PORT = Bun.env.SERVER_PORT || 7777;
	const app = createApp();

	// 添加定时重启任务，每5小时执行一次
	app.use(
		cron({
			name: "restart-server",
			pattern: "0 */5 * * *", // 每5小时执行一次
			run() {
				console.log("Scheduled server restart initiated...");
				process.exit(0); // 退出进程，让 PM2 或其他进程管理工具重启服务
			},
		}),
	);

	app.listen(PORT, () =>
		console.log(`Server is running on http://localhost:${PORT}`),
	);
};
