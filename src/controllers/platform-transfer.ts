import type { ContentInfo, ApiResponse } from "@/types/content";
import type { Context } from "elysia";
import { extractUrl, isValidUrl, extractMainDomain } from "@/utils/extractUrl";

import { parseXiaohongshuContent } from "@/controllers/xiaohongshu";
import { parseDouyinContent } from "@/controllers/douyin";
import { parseKuaishouContent } from "@/controllers/kuaishou";

export async function transferPlatform({
	body,
}: Context): Promise<ApiResponse<ContentInfo | null>> {
	const { url } = body as { url: string };

	const rawUrl = extractUrl(url);
	const mainDomain = extractMainDomain(rawUrl as string);

	if (!rawUrl || (rawUrl && !isValidUrl(rawUrl))) {
		return {
			success: false,
			data: null,
			message: "无法辨别 url 真实性🫠",
			errorCode: 1201,
		};
	}

	switch (mainDomain) {
		case "xiaohongshu.com":
		case "xhslink.com":
			return await parseXiaohongshuContent({
				body: { url: rawUrl },
			} as Context);
		case "douyin.com":
			return {
				success: false,
				data: null,
				message: "此平台解析功能仍在开发中📍",
				errorCode: 1203,
			};
		// return await parseDouyinContent({ body: { url: rawUrl } } as Context);
		case "kuaishou.com":
			return {
				success: false,
				data: null,
				message: "此平台解析功能仍在开发中📍",
				errorCode: 1203,
			};
		// return await parseKuaishouContent({ body: { url: rawUrl } } as Context);
		default:
			return {
				success: false,
				data: null,
				message: "无法识别的平台💀",
				errorCode: 1202,
			};
	}
}
