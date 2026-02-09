import type { ContentInfo, ApiResponse } from "@/types/content";
import type { Context } from "elysia";
import { extractUrl, isValidUrl, extractMainDomain } from "@/utils/extractUrl";

import { parseXiaohongshuContent } from "@/controllers/core/xiaohongshu";
import { DouyinApiParser } from "@/utils/api-parser";

const douyinParser = new DouyinApiParser();

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
      message: "无法辨别 url 真实性",
      errorCode: 1201,
    };
  }

  switch (mainDomain) {
    case "xiaohongshu.com":
    case "xhslink.com": {
      return await parseXiaohongshuContent({
        body: { url: rawUrl },
      } as Context);
    }
    case "douyin.com": {
      const apiResult = await douyinParser.parseVideo(rawUrl);

      if (apiResult) {
        return {
          success: true,
          data: {
            title: apiResult.title,
            author: {
              name: apiResult.author.name,
              url: apiResult.author.avatar,
            },
            resources: apiResult.resources,
          },
          message: "获取抖音内容成功",
        };
      }

      return {
        success: false,
        data: null,
        message: "抖音解析失败，请确保链接有效",
        errorCode: 1204,
      };
    }
    default:
      return {
        success: false,
        data: null,
        message: "无法识别的平台",
        errorCode: 1202,
      };
  }
}
