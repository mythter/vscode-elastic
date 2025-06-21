import * as vscode from 'vscode';
import path = require('path');
import * as fs from 'fs';
import * as os from 'os';
import { ElasticCompletionItemProvider } from './ElasticCompletionItemProvider';
import { ElasticCodeLensProvider } from './ElasticCodeLensProvider';
import { ElasticContentProvider } from './ElasticContentProvider';
import { ElasticDecoration } from './ElasticDecoration';
import { ElasticMatch } from './ElasticMatch';
import { ElasticMatches } from './ElasticMatches';
import axios, { AxiosError, AxiosResponse } from 'axios';
import stripJsonComments from './helpers';
import { JsonPanel } from './jsonPanel';
import * as https from 'https';
import * as tls from 'tls';
const jsonPanel = new JsonPanel();

export async function activate(context: vscode.ExtensionContext) {
    getHost(context);
    getCert(context);
    const languages = ['es', 'elasticsearch'];
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(languages, new ElasticCodeLensProvider(context)));

    let resultsProvider = new ElasticContentProvider();
    vscode.workspace.registerTextDocumentContentProvider('elasticsearch', resultsProvider);

    let esMatches: ElasticMatches;
    let decoration: ElasticDecoration;

    function checkEditor(document: vscode.TextDocument): Boolean {
        if (document === vscode.window.activeTextEditor!.document && document.languageId == 'es') {
            if (esMatches == null || decoration == null) {
                esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
                decoration = new ElasticDecoration(context);
            }
            return true;
        }
        return false;
    }

    if (vscode.window.activeTextEditor && checkEditor(vscode.window.activeTextEditor!.document)) {
        esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
        decoration!.UpdateDecoration(esMatches);
    }

    vscode.workspace.onDidChangeTextDocument(e => {
        if (checkEditor(e.document)) {
            esMatches = new ElasticMatches(vscode.window.activeTextEditor!);
            decoration.UpdateDecoration(esMatches);
        }
    });

    vscode.window.onDidChangeTextEditorSelection(e => {
        if (checkEditor(e.textEditor.document)) {
            esMatches.UpdateSelection(e.textEditor);
            decoration.UpdateDecoration(esMatches);
        }
    });

    let esCompletionHover = new ElasticCompletionItemProvider(context);

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(languages, esCompletionHover, '/', '?', '&', '"'));
    context.subscriptions.push(vscode.languages.registerHoverProvider(languages, esCompletionHover));

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.execute', (em: ElasticMatch) => {
            if (!em) {
                em = esMatches.Selection;
            }
            executeQuery(context, resultsProvider, em);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.setHost', () => {
            setHost(context);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.setCert', () => {
            setCert(context);
        }),
    );

    vscode.commands.registerCommand('extension.setClip', (uri, query) => {
        // var ncp = require('copy-paste');
        // ncp.copy(query, function () {
        // vscode.window.showInformationMessage('Copied to clipboard');
        // });
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.open', (em: ElasticMatch) => {
            var column = 0;
            let uri = vscode.Uri.file(em.File.Text);
            return vscode.workspace
                .openTextDocument(uri)
                .then(textDocument =>
                    vscode.window.showTextDocument(
                        textDocument,
                        column ? (column > vscode.ViewColumn.Three ? vscode.ViewColumn.One : column) : undefined,
                        true,
                    ),
                );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lint', (em: ElasticMatch) => {
            try {
                let l = em.Method.Range.start.line + 1;
                const editor = vscode.window.activeTextEditor;
                const config = vscode.workspace.getConfiguration('editor');
                const tabSize = (config.get('elasticsearch.indentTabSize') ?? vscode.workspace.getConfiguration('editor').get('tabSize')) as number;

                editor!.edit(editBuilder => {
                    if (em.HasBody) {
                        let txt = editor!.document.getText(em.Body.Range);
                        editBuilder.replace(em.Body.Range, JSON.stringify(JSON.parse(em.Body.Text), null, tabSize));
                    }
                });
            } catch (error: any) {
                console.log(error.message);
            }
        }),
    );
}

async function setHost(context: vscode.ExtensionContext): Promise<string> {
    const host = await vscode.window.showInputBox(<vscode.InputBoxOptions>{
        prompt: 'Please enter the elastic host',
        ignoreFocusOut: true,
        value: getHost(context),
    });

    context.workspaceState.update('elasticsearch.host', host);
    vscode.workspace.getConfiguration().update('elasticsearch.host', host);
    return host || 'localhost:9200';
}

export function getHost(context: vscode.ExtensionContext): string {
    return context.workspaceState.get('elasticsearch.host') || vscode.workspace.getConfiguration().get('elasticsearch.host', 'localhost:9200');
}

async function setCert(context: vscode.ExtensionContext): Promise<string | undefined> {
    let pathToCert: string | undefined;

    const option = await vscode.window.showQuickPick(['📂 Choose File', '⌨️ Enter file path'], {
        placeHolder: 'Select how you want to specify certificate file path',
    });

    if (!option) return;

    if (option.startsWith('📂')) {
        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Choose File',
            filters: {
                'All files': ['*'],
            },
        });

        if (fileUris && fileUris.length > 0) {
            pathToCert = fileUris[0].fsPath;
        }
    } else {
        pathToCert = await vscode.window.showInputBox({
            prompt: 'Enter certificate file path',
            ignoreFocusOut: true,
            value: getCert(context),
        });
    }

    if (pathToCert && !fs.existsSync(pathToCert!)) {
        vscode.window.showErrorMessage(`file at path "${pathToCert}" does not exist`);
    } else {
        context.workspaceState.update('elasticsearch.certFilePath', pathToCert);
        vscode.workspace.getConfiguration().update('elasticsearch.certFilePath', pathToCert);
    }

    return pathToCert;
}

export function getCert(context: vscode.ExtensionContext): string | undefined {
    return context.workspaceState.get('elasticsearch.certFilePath') || vscode.workspace.getConfiguration().get('elasticsearch.certFilePath');
}

export async function executeQuery(context: vscode.ExtensionContext, resultsProvider: ElasticContentProvider, em: ElasticMatch) {
    const host = getHost(context);
    const pathToCert = getCert(context);
    const startTime = new Date().getTime();

    const config = vscode.workspace.getConfiguration();
    let asDocument = config.get('elasticsearch.showResultAsDocument');
    let skipCertVerification = (config.get('elasticsearch.skipSslCertificateVerification') as boolean) ?? false;
    let ignoreHostnameMismatch = (config.get('elasticsearch.ignoreHostnameMismatch') as boolean) ?? false;
    let tabSize = (config.get('elasticsearch.indentTabSize') ?? vscode.workspace.getConfiguration('editor').get('tabSize')) as number;

    const certData: string | undefined = await getCertData(pathToCert);

    const agent = new https.Agent({
        ca: certData,
        rejectUnauthorized: !skipCertVerification,
        checkServerIdentity: (host, cert) => {
            const err = tls.checkServerIdentity(host, cert);
            if (err) {
                if (ignoreHostnameMismatch && err.message.includes('Hostname/IP does not match certificate')) {
                    return undefined;
                }
                return err;
            }
            // no errors
            return undefined;
        },
    });

    const sbi = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    sbi.text = '$(search) Executing query ...';
    sbi.show();

    let response: any;
    try {
        const body = stripJsonComments(em.Body.Text);
        let url = host + (em.Path.Text.startsWith('/') ? '' : '/') + em.Path.Text;

        const request: any = {
            url,
            method: em.Method.Text as any,
            headers: { 'Content-Type': em.IsBulk ? 'application/x-ndjson' : 'application/json' },
            httpsAgent: agent,
        };

        if (body) {
            request.data = body;
        }

        response = await axios(request).catch(error => error as AxiosError<any, any>);
    } catch (error) {
        response = error;
    }

    sbi.dispose();
    const endTime = new Date().getTime();
    const error = response as AxiosError;
    const data = response as AxiosResponse<any>;

    let results = data.data;
    if (!results) results = data;
    if (asDocument) {
        try {
            results = JSON.stringify(error.isAxiosError ? error.response?.data : data.data, null, tabSize);
        } catch (error: any) {
            results = data.data || error.response?.data || error.message;
        }
        showResult(results, vscode.window.activeTextEditor!.viewColumn! + 1);
    } else {
        jsonPanel.render(results, `ElasticSearch Results[${endTime - startTime}ms]`);
    }
}

function getCertData(pathToCert: string | undefined): Promise<string | undefined> {
    if (!pathToCert) return Promise.resolve(undefined);

    return new Promise(resolve => {
        fs.readFile(pathToCert, 'utf8', (err, data) => {
            if (err) {
                vscode.window.showErrorMessage(`Could not read certificate file at path "${pathToCert}"`);
                resolve(undefined);
                return;
            }

            if (!isCertValid(data)) {
                vscode.window.showErrorMessage(`Certificate at path "${pathToCert}" is not valid`);
                resolve(undefined);
                return;
            }

            if (!data.includes('BEGIN CERTIFICATE')) {
                const lines = data.match(/.{1,64}/g) || [];
                resolve(`-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`);
                return;
            }

            resolve(data);
        });
    });
}

function isCertValid(data: string): boolean {
    const base64 = data.replace('-----BEGIN CERTIFICATE-----', '').replace('-----END CERTIFICATE-----', '').trim();

    // check is Base64
    const cleaned = base64.replace(/\s+/g, '');
    const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
    return base64Regex.test(cleaned);
}

function showResult(result: string, column?: vscode.ViewColumn): Thenable<void> {
    const tempResultFilePath = path.join(os.homedir(), '.vscode-elastic');
    const resultFilePath = vscode.workspace.rootPath || tempResultFilePath;

    let uri = vscode.Uri.file(path.join(resultFilePath, 'result.json'));
    if (!fs.existsSync(uri.fsPath)) {
        uri = uri.with({ scheme: 'untitled' });
    }
    return vscode.workspace
        .openTextDocument(uri)
        .then(textDocument =>
            vscode.window.showTextDocument(textDocument, column ? (column > vscode.ViewColumn.Three ? vscode.ViewColumn.One : column) : undefined, true),
        )
        .then(editor => {
            editor.edit(editorBuilder => {
                if (editor.document.lineCount > 0) {
                    const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                    editorBuilder.delete(
                        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine.range.start.line, lastLine.range.end.character)),
                    );
                }
                editorBuilder.insert(new vscode.Position(0, 0), result);
            });
        });
}

// this method is called when your extension is deactivated
export function deactivate() {}
