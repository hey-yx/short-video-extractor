/** URL 提取与平台短链识别（纯函数） */

/** 从分享文案中提取 URL（支持 "7.87 Pjm:/ 复制打开抖音 https://v.douyin.com/xxx/" 这类） */
export function extractUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s"'<>）」』\]]+/g);
  if (!m || m.length === 0) return null;
  // 去掉尾标点
  return m[0]!.replace(/[.,;:!?，。；：！？]+$/, '');
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
