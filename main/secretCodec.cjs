/**
 * secretCodec.cjs —— `secrets` 卷的**值级**加密（Electron `safeStorage` / OS 钥匙串）。
 *
 * 存在理由：P1 把密钥从 localStorage 搬进了 `config/secrets.json`，解决了"换启动方式就要
 * 重填"和"按 origin 隔离"两个问题，但文件本身仍是**明文**。明文意味着：任何能读该文件的
 * 进程、任何一次把 userData 目录打包发给别人、任何一次云盘同步，密钥就泄露了。
 *
 * 设计要点：
 *  1. **值级而不是整文件级**。整篇加密会让 `stats()` 连键名都数不出来，而"存储管理面板"
 *     恰恰要展示键数与字节数；值级加密后文件仍是可解析的 JSON，只是值的形状变了。
 *  2. **带前缀自描述**（`enc:v1:`）。没有前缀的值 = 明文 —— 于是 P1/P2 写下的旧
 *     `secrets.json` 天然被读取（向后兼容零迁移），首次写入时自动升级成密文。
 *  3. **钥匙串不可用时不静默降级**。加密不可用时 `encode` 抛错（让写入显式失败、界面明说
 *     "这次没保存"），而不是悄悄写明文 —— 用户以为被加密了、实际没有，是最坏的结局。
 *     `decode` 遇到解不开的密文同样抛错，交由 `configStore` 的 preserved 机制原样保留，
 *     绝不让"这一次解不开"变成"密钥被从文件里抹掉"。
 *  4. **惰性取 `safeStorage`**：主进程在 `app.ready` 之前就构造了各存储卷，而
 *     `safeStorage.isEncryptionAvailable()` 在 ready 前不可靠 —— 所以每次调用时才解析。
 */

/** 密文前缀。`v1` 留给将来的算法/后端升级（换了就写 `enc:v2:`，旧值仍能按 v1 解）。 */
const CIPHER_PREFIX = 'enc:v1:';

/** 惰性解析 electron.safeStorage；拿不到（非 Electron 环境 / 单测）则视为不可用。 */
function defaultProvider() {
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    return electron && electron.safeStorage ? electron.safeStorage : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.safeStorage] 注入替身（回归脚本用），缺省取 electron.safeStorage
 * @returns {{encode: Function, decode: Function, available: () => boolean, describe: () => object}}
 */
function createSecretCodec({ safeStorage } = {}) {
  const resolve = () => (safeStorage !== undefined ? safeStorage : defaultProvider());

  const isAvailable = () => {
    const provider = resolve();
    if (!provider || typeof provider.encryptString !== 'function') return false;
    try {
      return typeof provider.isEncryptionAvailable === 'function' ? provider.isEncryptionAvailable() === true : true;
    } catch {
      return false;
    }
  };

  const encryptText = text => {
    const provider = resolve();
    const buffer = provider.encryptString(text);
    // Electron 返回 Buffer；回归替身可能直接给字符串。
    return Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(String(buffer), 'utf8').toString('base64');
  };

  const decryptText = payload => {
    const provider = resolve();
    const buffer = Buffer.from(payload, 'base64');
    const plain = provider.decryptString(buffer);
    if (typeof plain !== 'string') throw new Error('解密结果不是字符串');
    return plain;
  };

  return {
    available: isAvailable,

    /** 写盘前：字符串加密；非字符串（理论上不该出现）直通。不可用 → 抛错，绝不写明文。 */
    encode(value) {
      if (typeof value !== 'string' || value.length === 0) return value;
      if (!isAvailable()) throw new Error('系统钥匙串不可用，密钥无法加密保存（本次未写入）');
      return CIPHER_PREFIX + encryptText(value);
    },

    /** 读盘后：无前缀 = 明文旧值，直通（向后兼容）；有前缀但解不开 → 抛错由上层保留原文。 */
    decode(value) {
      if (typeof value !== 'string' || !value.startsWith(CIPHER_PREFIX)) return value;
      if (!isAvailable()) throw new Error('系统钥匙串不可用，无法解密已保存的密钥');
      return decryptText(value.slice(CIPHER_PREFIX.length));
    },

    /** 供"存储管理"面板展示的自我说明。 */
    describe() {
      return {
        encrypted: isAvailable(),
        scheme: isAvailable() ? 'safe-storage' : 'plaintext',
        prefix: CIPHER_PREFIX,
      };
    },
  };
}

module.exports = { createSecretCodec, CIPHER_PREFIX };
