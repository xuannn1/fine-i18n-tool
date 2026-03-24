import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as fs from 'fs';
import * as path from 'path';
import propertiesReader from 'properties-reader';
import * as vscode from 'vscode';
import PACKAGE from '../package.json';
import { getConfiguration, setConfiguration } from './configuration';
import { formatI18nValue } from './util';
import { activateFdlWorkspaceInfo, deactivateFdlWorkspaceInfo } from './fdlWorkspaceInfo';

/**
 * 国际化字典
 */
let i18nMap: Record<string, string> = {};

/**
 * 扫描国际化文件
 */
function registerI18nDocumentsLoad() {
    vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.fileName.endsWith('.properties')) {
            loadI18nFiles([doc.uri]);
        }
    });
}

/**
 * 提示
 */
function registerInlayHintsProvider() {
    const { selector, i18nFuncName } = getConfiguration();

    vscode.languages.registerInlayHintsProvider(selector, {
        provideInlayHints(document) {
            const hints: any[] = [];
            const text = document.getText();

            try {
                const ast = parse(text, {
                    sourceType: 'module',
                    plugins: ['typescript', 'jsx'],
                });

                traverse(ast, {
                    CallExpression(path) {
                        if ('name' in path.node.callee && path.node.callee.name === i18nFuncName && path.node.arguments.length > 0) {
                            const keyNode = path.node.arguments[0];

                            if (keyNode.type === 'StringLiteral') {
                                const key = keyNode.value;
                                const value = i18nMap[key] ?? '';
                                const formatValue = formatI18nValue(value);

                                if (formatValue) {
                                    const pos = document.positionAt(keyNode.end ?? 0);
                                    hints.push({
                                        position: pos,
                                        label: formatValue,
                                        paddingLeft: true,
                                    });
                                }
                            }
                        }
                    },
                });
            } catch (e) {
                // console.error(e);
            }

            return hints;
        },
    });
}

/**
 * 自动补全
 */
const TRIIGER_CHAR_LIST = ['"', "'", '`'];
function registerCompletionItemProvider() {
    const { selector, i18nFuncName } = getConfiguration();

    vscode.languages.registerCompletionItemProvider(
        selector,
        {
            provideCompletionItems: async function (document, position) {
                const linePrefix = document.lineAt(position).text.substr(0, position.character);
                if (TRIIGER_CHAR_LIST.some((char) => linePrefix.endsWith(`${i18nFuncName}(${char}`))) {
                    return Object.entries(i18nMap).map(([key, value]) => {
                        const formatValue = formatI18nValue(value);
                        const item = new vscode.CompletionItem(`${key}(${formatValue})`);
                        item.kind = vscode.CompletionItemKind.Value;
                        item.detail = `${key}: ${formatValue}`;
                        item.insertText = key;

                        return item;
                    });
                }

                return undefined;
            },
        },
        ...TRIIGER_CHAR_LIST
    );
}

/**
 * 载入国际化文件
 * @param uris
 */
async function loadI18nFiles(uris?: vscode.Uri[]) {
    const { i18nFileSuffixList } = getConfiguration();

    function updateI18nMap(uri: vscode.Uri, newI18nMap: Record<string, string>) {
        i18nMap = {
            ...i18nMap,
            ...newI18nMap,
        };

        console.log(`[${PACKAGE.name}] i18n file updated: ${uri.path}`);
    }

    const files =
        uris ??
        (await Promise.all(i18nFileSuffixList.map((i18nFileSuffix) => vscode.workspace.findFiles(`**/*${i18nFileSuffix}`, 'node_modules/**')))).flat(1);

    files.forEach((uri) => {
        const content = fs.readFileSync(uri.fsPath, 'utf-8');

        switch (path.extname(uri.fsPath)) {
            case '.properties':
                // @ts-ignore
                updateI18nMap(uri, propertiesReader(null).read(content).getAllProperties());
                break;
            case '.json': {
                updateI18nMap(uri, JSON.parse(content));
                break;
            }
            default: {
                break;
            }
        }
    });
}

export async function activate(context: vscode.ExtensionContext) {
    const configuration = setConfiguration({
        i18nFileSuffixList: (vscode.workspace.getConfiguration('fineI18nTool').get('i18nFileSuffix') as string).split(',').map((str) => str.trim()),
        i18nFuncName: vscode.workspace.getConfiguration('fineI18nTool').get('i18nFuncName') as string,
    });

    console.log(`[${PACKAGE.name}] configuration: ${JSON.stringify(configuration)}`);

    await loadI18nFiles();
    registerI18nDocumentsLoad();
    registerCompletionItemProvider();
    registerInlayHintsProvider();
    activateFdlWorkspaceInfo(context);
}

export function deactivate() {
    deactivateFdlWorkspaceInfo();
}
