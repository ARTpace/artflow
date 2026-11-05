/**
 * safeMode.cjs —— 「工厂启动」的单一判定点（对标 Blender 的 `--factory-startup`）。
 *
 * 存在理由：用户数据搬到主进程文件之后，"问题出在代码还是出在我这套配置里" 需要一个
 * 秒级二分手段 —— 关不掉的插件 / 打不开的皮肤，往往就是某一条用户配置造成的。
 * 安全模式让应用以**全新安装的样子**启动：所有用户卷读出空值，插件按默认装载，
 * 不读 localStorage 里的旧键，也不装载用户装的外部插件。
 *
 * 两条语义，缺一不可：
 *  1. **读空**：不消费任何用户数据。文件**不删、不重写** —— 去掉环境变量正常启动即完全恢复。
 *  2. **拒写**：安全模式会话里任何一次"顺手保存"都会覆盖用户的真实配置，那正是这个项目
 *     一路在消灭的"静默丢数据"。写入一律返回 `ok:false` 并把话说清楚，让界面显式提示
 *     "安全模式下不保存"，而不是假装成功。
 *
 * 为什么是环境变量而不是命令行参数：打包后双击启动不会带环境变量，天然避免了
 * "用户不小心进了安全模式却以为自己的配置丢了"；要排查就显式 `ARTFLOW_SAFE_MODE=1`。
 *
 * 判定只在主进程发生一次，结果通过 `createConfigStore({ safeMode })` /
 * `createPluginProfileStore({ safeMode })` 注入，以及渲染层从配置快照里读到 ——
 * 存储层自己不读环境变量，方便回归脚本直接传 `safeMode: true` 做对拍。
 */

const SAFE_MODE_ENV = 'ARTFLOW_SAFE_MODE';

/** @param {NodeJS.ProcessEnv} [env] */
const isSafeMode = (env = process.env) => Boolean(env) && env[SAFE_MODE_ENV] === '1';

/** 读侧说明：一切正常，只是刻意忽略 —— 因此 `degraded` 仍为 false，不触发告警链路。 */
const SAFE_MODE_READ_MESSAGE = `安全模式：已忽略用户配置（${SAFE_MODE_ENV}=1）`;

/** 写侧说明：直接告诉用户"为什么不生效、怎么才能生效"。 */
const SAFE_MODE_WRITE_REJECTED = `安全模式：本次会话不写入用户数据（去掉 ${SAFE_MODE_ENV}=1 后正常启动即可保存）`;

/** 外部插件在安全模式下的一律回绝（安装 / 卸载 / 调用）。 */
const SAFE_MODE_EXTERNAL_PLUGIN_REJECTED = '安全模式：已忽略用户安装的外部插件';

/**
 * 窗口标题后缀。渲染层 `components/SafeModeBanner.tsx` 会自己改 `document.title`
 * （那是决定窗口标题的东西），主进程这一份是**兜底**：安全模式最常见的用途就是
 * 排查"启动失败"，那种情况下 React 可能压根没挂起来，标题就更得醒目。
 */
const SAFE_MODE_TITLE_SUFFIX = '安全模式';

module.exports = {
  SAFE_MODE_ENV,
  isSafeMode,
  SAFE_MODE_TITLE_SUFFIX,
  SAFE_MODE_READ_MESSAGE,
  SAFE_MODE_WRITE_REJECTED,
  SAFE_MODE_EXTERNAL_PLUGIN_REJECTED,
};
