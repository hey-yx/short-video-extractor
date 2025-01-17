import CryptoJS from "crypto-js";

/**
 * 生成随机盐值
 * @returns 16字节的随机盐值
 */
export function generateSalt(): string {
  return CryptoJS.lib.WordArray.random(16).toString();
}

/**
 * 使用SHA256对密码进行哈希
 * @param password 原始密码
 * @param salt 盐值
 * @param iterations 迭代次数
 * @returns 哈希后的密码
 */
export function hashPassword(
  password: string,
  salt: string,
  iterations: number = 1000,
): string {
  let hash = password;
  // 先加盐
  hash = hash + salt;
  // 多次迭代哈希
  for (let i = 0; i < iterations; i++) {
    hash = CryptoJS.SHA256(hash).toString();
  }
  // 将盐值和哈希结果拼接存储
  return `${salt}:${hash}:${iterations}`;
}

/**
 * 验证密码
 * @param password 待验证的密码
 * @param hashedPassword 数据库中存储的密码哈希
 * @returns 密码是否匹配
 */
export function verifyPassword(
  password: string,
  hashedPassword: string,
): boolean {
  const [salt, hash, iterations] = hashedPassword.split(":");
  const newHash = hashPassword(password, salt, parseInt(iterations));
  return newHash === hashedPassword;
}
