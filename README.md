# fine-i18n-tool

VS Code / Cursor 扩展：**国际化辅助**（Inlay Hint、自动补全）+ **FDL 前端工作区信息**（状态栏展示本地 dev / 代理相关 URL 与端口探测）。

![example](https://github.com/likeke1997/fine-i18n-tool/blob/master/images/example.gif)

---

## 功能概览

### 1. 国际化（fine-i18n-tool）

- 在 **JavaScript / TypeScript** 中，对配置的国际化方法名（默认 `t`）做 **Inlay Hint** 与 **自动补全**。
- 支持按后缀扫描 **`.properties`**、**`.json`** 等国际化资源（见设置 `fineI18nTool.i18nFileSuffix`）。
- 保存 `.properties` 时会刷新内存中的词条映射。

### 2. FDL Workspace Info

在 **FineDataLink 前端 monorepo 根目录**打开工作区时，在**状态栏**显示 `FDL` 相关信息（非该结构的工作区会自动隐藏，避免误报）：

- **Dev URL**：来自 `packages/fui-adapter/config.ts` 的 `PORT`、`WITH_HTTPS`。
- **Proxy URL**：来自同一文件中的 `SERVER_URL`（支持 `SERVERS.xxx` 或字符串 URL）。
- **Platform URL**：来自 `packages/data-platform/webpack/config.js` 的 `PORT`（拼为 `http://localhost:{PORT}/platform`）。
- **端口探测**：对本地 adapter / platform 端口做 TCP 探测；支持窗口聚焦后防抖刷新、可选定时重测、占用二次确认等（见设置 `fdlWorkspaceInfo.portCheck.*`）。

点击状态栏可打开快捷操作（打开 Dev / Proxy URL、打开 adapter 配置、刷新等）。

---

## 开发与打包

```bash
pnpm install
pnpm run compile      # 开发期 webpack 构建
pnpm run package      # 生产构建（与 vscode:prepublish 一致）
pnpm run package:vsix   # 先 webpack，再打 VSIX（使用 --no-dependencies，适配 pnpm 目录结构）
```

打好的 **`.vsix`** 一般在扩展根目录，文件名形如 `fine-i18n-tool-{version}.vsix`。在编辑器中选择 **Install from VSIX…** 安装后建议 **Reload Window**。

> 若使用 **pnpm** 安装依赖，`vsce` 默认的 `npm list` 校验容易误报，因此 `package:vsix` 已加上 `--no-dependencies`（运行时依赖已打进 `dist/extension.js`）。

---

## 设置说明

在 **设置** 中搜索扩展名或下列前缀即可。

### 国际化（`fineI18nTool.*`）

| 配置项 | 说明 |
|--------|------|
| `fineI18nTool.i18nFileSuffix` | 国际化文件后缀，多个用英文逗号分隔，例如 `_zh_CN.properties, zh_CN.json`。 |
| `fineI18nTool.i18nFuncName` | 代码里国际化方法名，默认 `t`。 |

### FDL Workspace Info（`fdlWorkspaceInfo.*`）

| 配置项 | 说明 |
|--------|------|
| `fdlWorkspaceInfo.statusBar.alignment` | 状态栏项在左侧或右侧。 |
| `fdlWorkspaceInfo.statusBar.priority` | 同侧中的优先级，数值越大越靠左。 |
| `fdlWorkspaceInfo.portCheck.enabled` | 是否启用 TCP 端口探测；关闭后仍显示 URL，无端口告警。 |
| `fdlWorkspaceInfo.portCheck.timeoutMs` | 单次 TCP 探测超时（毫秒）。 |
| `fdlWorkspaceInfo.portCheck.intervalMs` | 定时重新探测的间隔（毫秒），`0` 表示关闭。 |
| `fdlWorkspaceInfo.portCheck.confirmOccupied` | 首次判定占用后是否再测一次，减少瞬时误报。 |
| `fdlWorkspaceInfo.portCheck.confirmDelayMs` | 第二次占用确认前的等待时间（毫秒）。 |
| `fdlWorkspaceInfo.portCheck.focusDebounceMs` | 窗口重新获得焦点后，延迟刷新端口状态的防抖（毫秒）。 |

---

## 相关命令（命令面板）

- `Refresh Workspace Info`（`fdlWorkspaceInfo.refresh`）
- `Open FUI Adapter Config`（`fdlWorkspaceInfo.openConfig`）
- `Open URL`（`fdlWorkspaceInfo.openItem`）
- `Show Workspace Info Actions`（`fdlWorkspaceInfo.showActions`）

---

## 仓库

<https://github.com/likeke1997/fine-i18n-tool>
