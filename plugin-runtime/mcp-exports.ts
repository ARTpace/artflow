/** 启动期从已校验 manifest 收集的 MCP 命令白名单。headless 只投影这份名单里的命令。 */
export const MCP_EXPORT_REGISTRY = 'mcp.exports';

export type McpExportRegistry = ReadonlyMap<string, readonly string[]>;
