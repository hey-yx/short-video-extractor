import type { ContentInfo, ApiResponse } from "@/types/content";
import type { Context } from "elysia";

export async function parseDouyinContent({
	body,
}: Context): Promise<ApiResponse<ContentInfo>> {
	const { url } = body as { url: string };

	return {
		success: true,
		data: {
			title: "",
			author: { name: "", url: "" },
			resources: [],
		},
		message: "获取抖音视频成功",
	};
}
