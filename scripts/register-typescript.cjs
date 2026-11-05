// 只供仓库内无额外测试依赖的 Node self-check / benchmark 使用。
// 使用既有 TypeScript devDependency 即时转译 .ts/.tsx；Vite build 仍是应用级编译验证。
const fs = require('node:fs');
const ts = require('typescript');

function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
}

require.extensions['.ts'] = compileTypeScript;
require.extensions['.tsx'] = compileTypeScript;

// Vite 语义补齐（内置皮肤插件的 ?raw / ?inline 在 Node self-check 下的等价物）：
// .css?raw → 原始文本；图片?inline → data URI；普通图片 → 本地文件路径。
// Vite 的查询说明符由解析器处理；Node 侧等价：剥掉 ?raw / ?inline
// 进行路径解析，再挂回后缀交给下面的专用处理器。
const Module = require('node:module');
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  try {
    return origResolveFilename.call(this, request, ...args);
  } catch (err) {
    const suffix = typeof request === 'string' && request.endsWith('?raw') ? '?raw'
      : typeof request === 'string' && request.endsWith('?inline') ? '?inline' : '';
    if (suffix) return origResolveFilename.call(this, request.slice(0, -suffix.length), ...args) + suffix;
    throw err;
  }
};
require.extensions['.css?raw'] = (module, filename) => {
  module.exports = fs.readFileSync(filename.replace(/\?raw$/, ''), 'utf8');
};
for (const ext of ['.svg', '.png', '.jpg', '.jpeg', '.webp']) {
  require.extensions[ext] = (module, filename) => { module.exports = filename; };
}
const imageMime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
for (const [ext, mime] of Object.entries(imageMime)) {
  require.extensions[`${ext}?inline`] = (module, filename) => {
    module.exports = `data:${mime};base64,${fs.readFileSync(filename.replace(/\?inline$/, '')).toString('base64')}`;
  };
}
