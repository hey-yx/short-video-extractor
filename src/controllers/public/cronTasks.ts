import { puppeteerManager } from "@/utils/puppeteer";

export async function resetPuppeteerInstance() {
  try {
    await puppeteerManager.closeBrowser();
    console.log("[Cron] 成功关闭 Puppeteer 实例");

    // 重新初始化实例
    await puppeteerManager.getPage();
    console.log("[Cron] 成功重新初始化 Puppeteer 实例");

    return {
      success: true,
      message: "Puppeteer 实例已重置并重新初始化",
    };
  } catch (error) {
    console.error("[Cron] 重置 Puppeteer 实例时出错:", error);
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "重置 Puppeteer 实例失败",
    };
  }
}
