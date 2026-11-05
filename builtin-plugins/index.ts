/**
 * builtin-plugins/index.ts —— 可选内置插件注册表；不可关闭的本体模块由 core-modules 独立启动。
 * 新增内置插件：在本目录建 <name>/manifest.json（+ 可选 activate），然后在此追加一行。
 * 外部目录只扫描声明式 JSON（无 entry）。可执行插件仍必须随软件编译。
 *
 * 三类目录边界（互不重叠）：
 *   - builtin-plugins/  内置插件：编译进本体，装完不可改。
 *   - capabilities/     能力库：被内置/第三方插件复用的纯实现（解析器、导出合成等），不含插件行为。
 *   - plugins/          第三方插件：播种到 userData/plugins/，装完可直接改 plugin.js。
 *   - plugin-runtime/   插件运行时：kernel / loader / 服务定义。
 *
 * 注意：`builtin.formats-files` / `builtin.formats-image-doc` / `builtin.formats-reader` /
 * `builtin.formats-pureref` / `builtin.commands-core` / `builtin.media` / `builtin.core-extensions` /
 * `builtin.project-portable` 已迁出本表 —— 它们以 editable channel 形态
 * （runtime.mode = "editable"）随包播种到 userData/plugins/，由 plugin-runtime/editable-loader.ts 在启动时
 * 读 plugin.js 源码并受信任执行。装完可直接改这些文件，无需重编译宿主。
 * （解析器实现 / React 组件作为宿主能力注入，留在 capabilities/ 做库。）
 */

import type { BuiltinPluginModule } from '../plugin-runtime/loader';
import { CARD_PLUGINS } from './cards';
import { onlineVideoPlugin } from './online-video';
import { uiSkinPickerPlugin } from './ui-skin-picker';
import { aiProvidersPlugin } from './ai-providers';
import { workspacePanelsPlugin } from './workspace-panels';
import { formatsPsdPlugin } from './formats-psd';
import { toolsCanvasPlugin } from './tools-canvas';
import { cutoutPlugin } from './cutout';
import { perfMonitorPlugin } from './perf-monitor';
import { assetLibraryPlugin } from './asset-library';
import { headlessPlugin } from './headless';
import { canvasToolbarsPlugin } from './canvas-toolbars';
import { studioChromePlugin } from './studio-chrome';
import { externalPluginsPlugin } from './external-plugins';

export const BUILTIN_PLUGINS: BuiltinPluginModule[] = [
  ...CARD_PLUGINS,
  onlineVideoPlugin,
  uiSkinPickerPlugin,
  aiProvidersPlugin,
  workspacePanelsPlugin,
  formatsPsdPlugin,
  toolsCanvasPlugin,
  cutoutPlugin,
  perfMonitorPlugin,
  assetLibraryPlugin,
  headlessPlugin,
  canvasToolbarsPlugin,
  studioChromePlugin,
  externalPluginsPlugin,
];
