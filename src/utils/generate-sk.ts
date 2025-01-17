import { v4 as uuidv4 } from "uuid";
import CryptoJS from "crypto-js";

/**
 * 生成安全密钥
 * @param length 密钥长度，默认为32位
 * @param prefix 密钥前缀，默认为'sk'
 * @returns 生成的安全密钥
 */
export function generateSecretKey(
  length: number = 32,
  prefix: string = "sk",
): string {
  // 生成UUID
  const uuid = uuidv4();

  // 使用UUID和当前时间戳生成随机种子
  const timestamp = Date.now().toString();
  const randomSeed = uuid + timestamp;

  // 使用SHA256生成哈希
  const hash = CryptoJS.SHA256(randomSeed).toString();

  // 截取指定长度
  const secretKey = hash.slice(0, length);

  // 添加前缀，使用'-'作为分隔符
  return `${prefix}-${secretKey}`;
}

/**
 * 验证安全密钥格式是否正确
 * @param sk 待验证的安全密钥
 * @param prefix 密钥前缀，默认为'sk'
 * @returns 是否为有效的安全密钥
 */
export function validateSecretKey(sk: string, prefix: string = "sk"): boolean {
  if (!sk || typeof sk !== "string") return false;

  // 检查前缀
  if (!sk.startsWith(`${prefix}-`)) return false;

  // 检查剩余部分是否为有效的十六进制字符串
  const key = sk.slice(prefix.length + 1);
  const hexRegex = /^[0-9a-f]+$/i;
  return hexRegex.test(key);
}
