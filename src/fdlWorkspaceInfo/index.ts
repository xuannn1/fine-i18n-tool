import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

const ADAPTER_CONFIG_RELATIVE_PATH = path.join('packages', 'fui-adapter', 'config.ts');
const PLATFORM_CONFIG_RELATIVE_PATH = path.join('packages', 'data-platform', 'webpack', 'config.js');
const EXTENSION_CONFIGURATION_SECTION = 'fdlWorkspaceInfo';
const STATUS_BAR_ALIGNMENT_SETTING = 'statusBar.alignment';
const STATUS_BAR_PRIORITY_SETTING = 'statusBar.priority';
const DEFAULT_STATUS_BAR_ALIGNMENT = 'left';
const DEFAULT_STATUS_BAR_PRIORITY = 100;
const DEFAULT_PORT_CHECK_TIMEOUT_MS = 1500;
const DEFAULT_PORT_CHECK_CONFIRM_DELAY_MS = 400;
const DEFAULT_PORT_CHECK_FOCUS_DEBOUNCE_MS = 400;

const PORT_CHECK_ENABLED_SETTING = 'portCheck.enabled';
const PORT_CHECK_TIMEOUT_MS_SETTING = 'portCheck.timeoutMs';
const PORT_CHECK_INTERVAL_MS_SETTING = 'portCheck.intervalMs';
const PORT_CHECK_CONFIRM_OCCUPIED_SETTING = 'portCheck.confirmOccupied';
const PORT_CHECK_CONFIRM_DELAY_MS_SETTING = 'portCheck.confirmDelayMs';
const PORT_CHECK_FOCUS_DEBOUNCE_MS_SETTING = 'portCheck.focusDebounceMs';

type PortProbeStatus = 'ok' | 'occupied' | 'error' | 'skip';

export interface PortStatus {
    port: number;
    status: PortProbeStatus;
    message?: string;
}

export interface WorkspaceInfoResolved {
    devUrl: string;
    proxyUrl: string;
    proxySourceKey?: string;
    platformUrl: string;
    adapterPortStatus: PortStatus;
    platformPortStatus: PortStatus;
}

type WorkspaceInfoState =
    | { info: WorkspaceInfoResolved; configPath: string }
    | { error: string; configPath?: string };

interface PortProbeSettings {
    enablePortCheck: boolean;
    timeoutMs: number;
    intervalMs: number;
    confirmOccupied: boolean;
    confirmDelayMs: number;
}

type QuickPickActionItem = vscode.QuickPickItem & { action: () => void | PromiseLike<void> };

let outputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let portCheckIntervalId: ReturnType<typeof setInterval> | undefined;
let focusRefreshTimer: ReturnType<typeof setTimeout> | undefined;

export function activateFdlWorkspaceInfo(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('FDL Workspace Info');
    logInfo('FDL Workspace Info activated');

    context.subscriptions.push(outputChannel);
    createOrReplaceStatusBarItem(context);
    context.subscriptions.push(
        vscode.commands.registerCommand('fdlWorkspaceInfo.refresh', () => {
            logInfo('Refreshing status bar');
            void refreshStatusBar();
        }),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('fdlWorkspaceInfo.openConfig', async () => {
            const workspaceFolder = getWorkspaceFolder();

            if (!workspaceFolder) {
                logWarn('Open config requested without an open workspace');
                return;
            }

            if (!shouldShowFdlStatusBar(workspaceFolder)) {
                await vscode.window.showInformationMessage('当前工作区不是 FDL 工程（未找到 fui-adapter / data-platform 配置路径）。');
                return;
            }

            const configUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, ADAPTER_CONFIG_RELATIVE_PATH));
            logInfo(`Opening config ${configUri.fsPath}`);
            const document = await vscode.workspace.openTextDocument(configUri);

            await vscode.window.showTextDocument(document, {
                preview: false,
            });
        }),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('fdlWorkspaceInfo.openItem', async (item: { value?: string }) => {
            if (!item || !item.value) {
                logWarn('Open URL requested without a value');
                return;
            }

            logInfo(`Opening URL ${item.value}`);
            await vscode.env.openExternal(vscode.Uri.parse(item.value));
        }),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('fdlWorkspaceInfo.showActions', async () => {
            logInfo('Showing status bar actions');
            const workspaceFolder = getWorkspaceFolder();

            if (!shouldShowFdlStatusBar(workspaceFolder)) {
                await vscode.window.showInformationMessage('当前工作区不是 FDL 工程（未找到 fui-adapter / data-platform 配置路径）。');
                return;
            }

            const workspaceInfo = await getWorkspaceInfoState();
            const quickPickItems: QuickPickActionItem[] = [];

            if ('info' in workspaceInfo) {
                const { devUrl, proxyUrl } = workspaceInfo.info;
                quickPickItems.push(
                    {
                        label: 'Open Dev URL',
                        description: devUrl,
                        action: () => vscode.commands.executeCommand('fdlWorkspaceInfo.openItem', { value: devUrl }),
                    },
                    {
                        label: 'Open Proxy URL',
                        description: proxyUrl,
                        action: () => vscode.commands.executeCommand('fdlWorkspaceInfo.openItem', { value: proxyUrl }),
                    },
                );
            }

            quickPickItems.push(
                {
                    label: 'Open FUI Adapter Config',
                    description: ADAPTER_CONFIG_RELATIVE_PATH,
                    action: () => vscode.commands.executeCommand('fdlWorkspaceInfo.openConfig'),
                },
                {
                    label: 'Refresh Workspace Info',
                    description: 'Reload dev/proxy/platform info from config files',
                    action: () => vscode.commands.executeCommand('fdlWorkspaceInfo.refresh'),
                },
            );

            const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: 'FDL Workspace Info actions',
            });

            if (!selectedItem) {
                logInfo('Status bar action menu dismissed');
                return;
            }

            logInfo(`Selected action: ${selectedItem.label}`);
            await (selectedItem as QuickPickActionItem).action();
        }),
    );

    const workspaceFolder = getWorkspaceFolder();
    logInfo(`Workspace folder: ${workspaceFolder ? workspaceFolder.uri.fsPath : '(none)'}`);

    if (workspaceFolder) {
        context.subscriptions.push(createConfigWatcher(workspaceFolder, ADAPTER_CONFIG_RELATIVE_PATH));
        context.subscriptions.push(createConfigWatcher(workspaceFolder, PLATFORM_CONFIG_RELATIVE_PATH));
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration(EXTENSION_CONFIGURATION_SECTION)) {
                return;
            }

            logInfo('Workspace info settings changed');
            createOrReplaceStatusBarItem(context);
            syncPortCheckInterval();
            void refreshStatusBar();
        }),
    );

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (!state.focused) {
                return;
            }

            const debounceMs = getPortCheckFocusDebounceMs();

            if (focusRefreshTimer) {
                clearTimeout(focusRefreshTimer);
                focusRefreshTimer = undefined;
            }

            focusRefreshTimer = setTimeout(() => {
                focusRefreshTimer = undefined;
                logInfo('Window focused: refreshing workspace info');
                void refreshStatusBar();
            }, debounceMs);
        }),
    );

    context.subscriptions.push({
        dispose() {
            clearPortCheckInterval();

            if (focusRefreshTimer) {
                clearTimeout(focusRefreshTimer);
                focusRefreshTimer = undefined;
            }
        },
    });

    syncPortCheckInterval();
    void refreshStatusBar();
}

export function deactivateFdlWorkspaceInfo(): void {
    logInfo('FDL Workspace Info deactivated');
    clearPortCheckInterval();

    if (focusRefreshTimer) {
        clearTimeout(focusRefreshTimer);
        focusRefreshTimer = undefined;
    }
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

function shouldShowFdlStatusBar(workspaceFolder: vscode.WorkspaceFolder | undefined): boolean {
    if (!workspaceFolder) {
        return false;
    }

    const root = workspaceFolder.uri.fsPath;
    const adapterExists = fs.existsSync(path.join(root, ADAPTER_CONFIG_RELATIVE_PATH));
    const platformExists = fs.existsSync(path.join(root, PLATFORM_CONFIG_RELATIVE_PATH));

    return adapterExists || platformExists;
}

function createConfigWatcher(workspaceFolder: vscode.WorkspaceFolder, relativePath: string): vscode.FileSystemWatcher {
    const pattern = new vscode.RelativePattern(workspaceFolder, relativePath);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange((uri) => {
        logInfo(`Config changed: ${uri.fsPath}`);
        void refreshStatusBar();
    });
    watcher.onDidCreate((uri) => {
        logInfo(`Config created: ${uri.fsPath}`);
        void refreshStatusBar();
    });
    watcher.onDidDelete((uri) => {
        logWarn(`Config deleted: ${uri.fsPath}`);
        void refreshStatusBar();
    });

    return watcher;
}

async function getWorkspaceInfoState(): Promise<WorkspaceInfoState> {
    const workspaceFolder = getWorkspaceFolder();

    if (!workspaceFolder) {
        return {
            error: 'No workspace folder is open',
        };
    }

    const adapterConfigPath = path.join(workspaceFolder.uri.fsPath, ADAPTER_CONFIG_RELATIVE_PATH);
    const platformConfigPath = path.join(workspaceFolder.uri.fsPath, PLATFORM_CONFIG_RELATIVE_PATH);

    if (!fs.existsSync(adapterConfigPath)) {
        return {
            error: `Cannot find ${ADAPTER_CONFIG_RELATIVE_PATH}`,
            configPath: adapterConfigPath,
        };
    }

    if (!fs.existsSync(platformConfigPath)) {
        return {
            error: `Cannot find ${PLATFORM_CONFIG_RELATIVE_PATH}`,
            configPath: platformConfigPath,
        };
    }

    try {
        const info = await readWorkspaceInfo(adapterConfigPath, platformConfigPath);
        logInfo(`Resolved devUrl=${info.devUrl}`);
        logInfo(`Resolved proxyUrl=${info.proxyUrl}`);
        logInfo(`Resolved platformUrl=${info.platformUrl}`);
        if (info.proxySourceKey) {
            logInfo(`Resolved proxySourceKey=${info.proxySourceKey}`);
        }

        return {
            info,
            configPath: adapterConfigPath,
        };
    } catch (error) {
        return {
            error: getErrorMessage(error),
            configPath: adapterConfigPath,
        };
    }
}

function createOrReplaceStatusBarItem(context: vscode.ExtensionContext): void {
    const statusBarOptions = getStatusBarOptions();

    if (statusBarItem) {
        statusBarItem.dispose();
    }

    statusBarItem = vscode.window.createStatusBarItem(statusBarOptions.alignment, statusBarOptions.priority);
    statusBarItem.command = 'fdlWorkspaceInfo.showActions';
    context.subscriptions.push(statusBarItem);
    logInfo(`Created status bar item with alignment=${statusBarOptions.alignmentLabel} priority=${statusBarOptions.priority}`);
    void refreshStatusBar();
}

function getStatusBarOptions(): {
    alignment: vscode.StatusBarAlignment;
    alignmentLabel: string;
    priority: number;
} {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIGURATION_SECTION);
    const alignmentValue = String(configuration.get(STATUS_BAR_ALIGNMENT_SETTING, DEFAULT_STATUS_BAR_ALIGNMENT)).toLowerCase();
    const priorityValue = Number(configuration.get(STATUS_BAR_PRIORITY_SETTING, DEFAULT_STATUS_BAR_PRIORITY));
    const alignment =
        alignmentValue === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
    const priority = Number.isFinite(priorityValue) ? priorityValue : DEFAULT_STATUS_BAR_PRIORITY;

    return {
        alignment,
        alignmentLabel: alignmentValue === 'right' ? 'right' : 'left',
        priority,
    };
}

function getPortProbeSettings(): PortProbeSettings {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIGURATION_SECTION);
    const timeoutRaw = Number(configuration.get(PORT_CHECK_TIMEOUT_MS_SETTING, DEFAULT_PORT_CHECK_TIMEOUT_MS));
    const intervalRaw = Number(configuration.get(PORT_CHECK_INTERVAL_MS_SETTING, 0));
    const confirmDelayRaw = Number(
        configuration.get(PORT_CHECK_CONFIRM_DELAY_MS_SETTING, DEFAULT_PORT_CHECK_CONFIRM_DELAY_MS),
    );

    return {
        enablePortCheck: configuration.get<boolean>(PORT_CHECK_ENABLED_SETTING, true) !== false,
        timeoutMs: Number.isFinite(timeoutRaw) ? Math.min(60000, Math.max(500, timeoutRaw)) : DEFAULT_PORT_CHECK_TIMEOUT_MS,
        intervalMs: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.min(3600000, intervalRaw) : 0,
        confirmOccupied: configuration.get<boolean>(PORT_CHECK_CONFIRM_OCCUPIED_SETTING, true) !== false,
        confirmDelayMs: Number.isFinite(confirmDelayRaw)
            ? Math.min(5000, Math.max(0, confirmDelayRaw))
            : DEFAULT_PORT_CHECK_CONFIRM_DELAY_MS,
    };
}

function getPortCheckFocusDebounceMs(): number {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIGURATION_SECTION);
    const raw = Number(configuration.get(PORT_CHECK_FOCUS_DEBOUNCE_MS_SETTING, DEFAULT_PORT_CHECK_FOCUS_DEBOUNCE_MS));

    if (!Number.isFinite(raw)) {
        return DEFAULT_PORT_CHECK_FOCUS_DEBOUNCE_MS;
    }

    return Math.min(10000, Math.max(0, raw));
}

function clearPortCheckInterval(): void {
    if (portCheckIntervalId) {
        clearInterval(portCheckIntervalId);
        portCheckIntervalId = undefined;
    }
}

function syncPortCheckInterval(): void {
    clearPortCheckInterval();
    const { intervalMs } = getPortProbeSettings();

    if (!intervalMs) {
        return;
    }

    portCheckIntervalId = setInterval(() => {
        void refreshStatusBar();
    }, intervalMs);
    logInfo(`Port check interval started: ${intervalMs}ms`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function refreshStatusBar(): Promise<void> {
    if (!statusBarItem) {
        return;
    }

    const workspaceFolder = getWorkspaceFolder();

    if (!shouldShowFdlStatusBar(workspaceFolder)) {
        statusBarItem.text = '';
        statusBarItem.tooltip = undefined;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.color = undefined;
        statusBarItem.hide();
        logInfo('Status bar hidden: not an FDL workspace');
        return;
    }

    const workspaceInfo = await getWorkspaceInfoState();

    if ('info' in workspaceInfo) {
        const info = workspaceInfo.info;
        const devPort = getPortLabel(info.devUrl);
        const proxyPort = getPortLabel(info.proxyUrl);
        const hasPortWarning = hasPortWarningState(info);
        statusBarItem.text = hasPortWarning
            ? `FDL $(warning) ${devPort} | ${proxyPort}`
            : `FDL $(link-external) ${devPort} | ${proxyPort}`;
        statusBarItem.tooltip = createTooltip(info);
        statusBarItem.backgroundColor = hasPortWarning
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
        statusBarItem.color = hasPortWarning ? new vscode.ThemeColor('statusBarItem.warningForeground') : undefined;
        statusBarItem.show();
        logInfo(`Status bar updated: ${statusBarItem.text}`);
        return;
    }

    const err = 'error' in workspaceInfo ? workspaceInfo.error : 'Unknown error';
    const errPath = 'configPath' in workspaceInfo && workspaceInfo.configPath ? workspaceInfo.configPath : '';

    statusBarItem.text = 'FDL $(warning) Config error';
    statusBarItem.tooltip = [err, errPath ? `Config: ${errPath}` : ''].filter(Boolean).join('\n');
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    statusBarItem.show();
    logWarn(`Status bar updated with warning: ${err}`);
}

async function readWorkspaceInfo(adapterConfigPath: string, platformConfigPath: string): Promise<WorkspaceInfoResolved> {
    const configText = fs.readFileSync(adapterConfigPath, 'utf8');
    const platformConfigText = fs.readFileSync(platformConfigPath, 'utf8');
    const servers = parseServers(configText);
    const port = parseNumberProperty(configText, 'PORT');
    const withHttps = parseBooleanProperty(configText, 'WITH_HTTPS');
    const serverUrlExpression = parsePropertyExpression(configText, 'SERVER_URL');
    const platformPort = parseModuleExportsNumberProperty(platformConfigText, 'PORT');
    const proxyUrl = resolveServerUrl(serverUrlExpression, servers);
    const proxySourceKey = getServerUrlSourceKey(serverUrlExpression);
    const devProtocol = withHttps ? 'https' : 'http';
    const probe = getPortProbeSettings();
    let portStatuses: [PortStatus, PortStatus];

    if (!probe.enablePortCheck) {
        portStatuses = [
            { port, status: 'skip' },
            { port: platformPort, status: 'skip' },
        ];
    } else {
        portStatuses = await Promise.all([
            detectPortStatusMaybeConfirm(port, probe),
            detectPortStatusMaybeConfirm(platformPort, probe),
        ]);
    }

    return {
        devUrl: `${devProtocol}://localhost:${port}`,
        proxyUrl,
        proxySourceKey,
        platformUrl: `http://localhost:${platformPort}/platform`,
        adapterPortStatus: portStatuses[0],
        platformPortStatus: portStatuses[1],
    };
}

function parseServers(configText: string): Record<string, string> {
    const serversMatch = configText.match(/const\s+SERVERS\s*=\s*{([\s\S]*?)\n};/);

    if (!serversMatch) {
        throw new Error('SERVERS block not found');
    }

    const serversBlock = serversMatch[1];
    const serverMap: Record<string, string> = {};
    const serverEntryRegex = /^\s*(?:'([^']+)'|"([^"]+)"|([^\s:'"]+))\s*:\s*'([^']+)'\s*,?\s*$/gm;
    let match = serverEntryRegex.exec(serversBlock);

    while (match) {
        const key = match[1] || match[2] || match[3];
        if (key) {
            serverMap[key] = match[4];
        }
        match = serverEntryRegex.exec(serversBlock);
    }

    return serverMap;
}

function parseNumberProperty(configText: string, propertyName: string): number {
    const value = parsePropertyExpression(configText, propertyName);
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue)) {
        throw new Error(`Expected ${propertyName} to be a number, got ${value}`);
    }

    return parsedValue;
}

function parseModuleExportsNumberProperty(configText: string, propertyName: string): number {
    const value = parseModuleExportsPropertyExpression(configText, propertyName);
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue)) {
        throw new Error(`Expected ${propertyName} to be a number, got ${value}`);
    }

    return parsedValue;
}

function parseBooleanProperty(configText: string, propertyName: string): boolean {
    const value = parsePropertyExpression(configText, propertyName);

    if (value === 'true') {
        return true;
    }

    if (value === 'false') {
        return false;
    }

    throw new Error(`Expected ${propertyName} to be a boolean, got ${value}`);
}

function parsePropertyExpression(configText: string, propertyName: string): string {
    const configMatch = configText.match(/export\s+const\s+CONFIG\s*=\s*{([\s\S]*?)\n};/);

    if (!configMatch) {
        throw new Error('CONFIG block not found');
    }

    const configBlock = configMatch[1];
    const propertyRegex = new RegExp(
        `^\\s*${escapeRegExp(propertyName)}\\s*:\\s*('(?:\\\\.|[^'])*'|"(?:\\\\.|[^"])*"|[^,]+?)\\s*,?(?:\\s*//.*)?$`,
        'm',
    );
    const propertyMatch = configBlock.match(propertyRegex);

    if (!propertyMatch) {
        throw new Error(`${propertyName} not found`);
    }

    return propertyMatch[1].trim();
}

function parseModuleExportsPropertyExpression(configText: string, propertyName: string): string {
    const moduleExportsMatch = configText.match(/module\.exports\s*=\s*{([\s\S]*?)\n};/);

    if (!moduleExportsMatch) {
        throw new Error('module.exports block not found');
    }

    const configBlock = moduleExportsMatch[1];
    const propertyRegex = new RegExp(
        `^\\s*${escapeRegExp(propertyName)}\\s*:\\s*('(?:\\\\.|[^'])*'|"(?:\\\\.|[^"])*"|[^,]+?)\\s*,?(?:\\s*//.*)?$`,
        'm',
    );
    const propertyMatch = configBlock.match(propertyRegex);

    if (!propertyMatch) {
        throw new Error(`${propertyName} not found in module.exports`);
    }

    return propertyMatch[1].trim();
}

function resolveServerUrl(serverUrlExpression: string, servers: Record<string, string>): string {
    const stringMatch = serverUrlExpression.match(/^'([^']+)'$/) || serverUrlExpression.match(/^"([^"]+)"$/);

    if (stringMatch) {
        return stringMatch[1];
    }

    const serverReferenceMatch = serverUrlExpression.match(/^SERVERS\.([^\s]+)$/);

    if (serverReferenceMatch) {
        const serverKey = serverReferenceMatch[1];

        if (!Object.prototype.hasOwnProperty.call(servers, serverKey)) {
            throw new Error(`SERVER_URL references unknown key ${serverKey}`);
        }

        return servers[serverKey];
    }

    throw new Error(`Unsupported SERVER_URL expression: ${serverUrlExpression}`);
}

function getServerUrlSourceKey(serverUrlExpression: string): string | undefined {
    const serverReferenceMatch = serverUrlExpression.match(/^SERVERS\.([^\s]+)$/);
    return serverReferenceMatch ? serverReferenceMatch[1] : undefined;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function getPortLabel(url: string): string {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
    } catch {
        return url;
    }
}

function hasPortWarningState(info: WorkspaceInfoResolved): boolean {
    return [info.adapterPortStatus, info.platformPortStatus].some(
        (portStatus) => portStatus.status !== 'ok' && portStatus.status !== 'skip',
    );
}

function formatPortStatusLine(info: WorkspaceInfoResolved): string {
    return `端口检测：${formatPortStatus(info.adapterPortStatus)}，${formatPortStatus(info.platformPortStatus)}`;
}

function formatPortStatus(portStatus: PortStatus): string {
    if (portStatus.status === 'skip') {
        return `${portStatus.port} （未检测）`;
    }

    const statusLabel =
        {
            ok: '正常',
            occupied: '已占用',
            error: '检测失败',
        }[portStatus.status] || '未知';

    if (portStatus.status === 'occupied') {
        return `${portStatus.port} （已占用）`;
    }

    if (portStatus.message && portStatus.status === 'error') {
        return `${portStatus.port} ${statusLabel} (${portStatus.message})`;
    }

    return `${portStatus.port} ${statusLabel}`;
}

function createTooltip(info: WorkspaceInfoResolved): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.supportThemeIcons = true;
    tooltip.isTrusted = false;
    tooltip.appendMarkdown(`Dev URL: ${escapeMarkdown(info.devUrl)}  \n`);
    tooltip.appendMarkdown(`Proxy URL: ${escapeMarkdown(formatProxyTooltipValue(info))}  \n`);
    tooltip.appendMarkdown(`Platform URL: ${escapeMarkdown(info.platformUrl)}  \n`);
    tooltip.appendMarkdown(formatPortStatusTooltipMarkdown(info));
    return tooltip;
}

function formatPortStatusTooltipMarkdown(info: WorkspaceInfoResolved): string {
    const line = escapeMarkdown(formatPortStatusLine(info));
    const hasOccupiedPort = [info.adapterPortStatus, info.platformPortStatus].some((portStatus) => portStatus.status === 'occupied');
    return hasOccupiedPort ? `$(warning) ${line}` : line;
}

function formatProxyTooltipValue(info: WorkspaceInfoResolved): string {
    return info.proxySourceKey ? `${info.proxyUrl} (${info.proxySourceKey})` : info.proxyUrl;
}

function escapeMarkdown(value: string): string {
    return String(value).replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

async function detectPortStatusMaybeConfirm(port: number, probe: PortProbeSettings): Promise<PortStatus> {
    const first = await detectPortStatus(port, probe.timeoutMs);

    if (first.status !== 'occupied' || !probe.confirmOccupied) {
        return first;
    }

    await sleep(probe.confirmDelayMs);
    const second = await detectPortStatus(port, probe.timeoutMs);

    if (second.status === 'occupied') {
        return first;
    }

    if (second.status === 'ok') {
        logInfo(`端口 ${port} 二次探测未占用，视为正常`);
        return { port, status: 'ok' };
    }

    return second;
}

function detectPortStatus(port: number, timeoutMs: number): Promise<PortStatus> {
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PORT_CHECK_TIMEOUT_MS;

    return new Promise((resolve) => {
        const socket = net.createConnection({
            host: '127.0.0.1',
            port,
        });
        let settled = false;

        const finalize = (result: PortStatus) => {
            if (settled) {
                return;
            }

            settled = true;
            resolve(result);
        };

        socket.setTimeout(ms);
        socket.unref();
        socket.once('connect', () => {
            socket.destroy();
            logWarn(`检测端口 ${port}：已占用`);
            finalize({ port, status: 'occupied' });
        });
        socket.once('timeout', () => {
            socket.destroy();
            logError(`检测端口 ${port}：检测失败 (连接超时)`);
            finalize({ port, status: 'error', message: '连接超时' });
        });
        socket.once('error', (error: NodeJS.ErrnoException) => {
            const errorCode = error?.code;

            if (errorCode === 'ECONNREFUSED') {
                logInfo(`检测端口 ${port}：正常`);
                finalize({ port, status: 'ok' });
                return;
            }

            logError(`检测端口 ${port}：检测失败 (${getErrorMessage(error)})`);
            finalize({ port, status: 'error', message: getErrorMessage(error) });
        });
    });
}

function logInfo(message: string): void {
    log('INFO', message);
}

function logWarn(message: string): void {
    log('WARN', message);
}

function logError(message: string): void {
    log('ERROR', message);
}

function log(level: string, message: string): void {
    if (!outputChannel) {
        return;
    }

    outputChannel.appendLine(`[${level}] ${message}`);
}

export const fdlWorkspaceInfoTestExports = {
    readWorkspaceInfo,
    parseServers,
    parseNumberProperty,
    parseModuleExportsNumberProperty,
    parseBooleanProperty,
    parsePropertyExpression,
    parseModuleExportsPropertyExpression,
    resolveServerUrl,
    getServerUrlSourceKey,
    detectPortStatus,
    formatPortStatusLine,
    formatPortStatusTooltipMarkdown,
    formatProxyTooltipValue,
};
