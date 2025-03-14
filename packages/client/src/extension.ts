import { logger } from '@internal/common-utils/log';
import { createDisposableList } from 'utils-disposables';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { Utils as UriUtils } from 'vscode-uri';

import * as addWords from './addWords';
import { registerCspellInlineCompletionProviders } from './autocomplete';
import { CSpellClient } from './client';
import { registerSpellCheckerCodeActionProvider } from './codeAction';
import type { InjectableCommandHandlers } from './commands';
import * as commands from './commands';
import { updateDocumentRelatedContext } from './context';
import { SpellingExclusionsDecorator, SpellingIssueDecorator } from './decorate';
import * as di from './di';
import type { ExtensionApi } from './extensionApi';
import * as ExtensionRegEx from './extensionRegEx';
import * as settingsViewer from './infoViewer/infoView';
import { IssueTracker } from './issueTracker';
import { activateFileIssuesViewer, activateIssueViewer } from './issueViewer';
import * as modules from './modules';
import type { ConfigTargetLegacy, CSpellSettings } from './settings';
import * as settings from './settings';
import { sectionCSpell } from './settings';
import { getSectionName } from './settings/vsConfig';
import { initStatusBar } from './statusbar';
import { logErrors, silenceErrors } from './util/errors';
import { performance } from './util/perf';
import { activate as activateWebview } from './webview';

performance.mark('cspell_done_import');

const debugMode = false;

modules.init();

export async function activate(context: ExtensionContext): Promise<ExtensionApi> {
    performance.mark('cspell_activate_start');

    const logOutput = vscode.window.createOutputChannel('Code Spell Checker', { log: true });
    const dLogger = bindLoggerToOutput(logOutput);
    setOutputChannelLogLevel();

    // Get the cSpell Client
    const client = await CSpellClient.create(context);
    context.subscriptions.push(client, logOutput, dLogger);

    di.set('client', client);
    di.set('extensionContext', context);

    ExtensionRegEx.activate(context, client);

    // Start the client.
    await client.start();
    const statusBar = initStatusBar(context, client);

    const issueTracker = new IssueTracker(client);
    di.set('issueTracker', issueTracker);

    function triggerGetSettings(delayInMs = 0) {
        setTimeout(triggerGetSettingsNow, delayInMs);
    }

    function triggerGetSettingsNow() {
        silenceErrors(client.triggerSettingsRefresh(), 'triggerGetSettings')
            .then(() => {
                settingsViewer.update();
                statusBar.refresh();
                return;
            })
            .catch(() => undefined);
    }

    function triggerConfigChange() {
        triggerGetSettings();
    }

    const configWatcher = vscode.workspace.createFileSystemWatcher(settings.configFileLocationGlob);
    const decorator = new SpellingIssueDecorator(issueTracker);
    const decoratorExclusions = new SpellingExclusionsDecorator(context, client);
    activateIssueViewer(context, issueTracker);
    activateFileIssuesViewer(context, issueTracker);

    const extensionCommand: InjectableCommandHandlers = {
        'cSpell.toggleTraceMode': () => decoratorExclusions.toggleEnabled(),
    };

    // Push the disposable to the context's subscriptions so that the
    // client can be deactivated on extension deactivation
    context.subscriptions.push(
        issueTracker,
        configWatcher,
        configWatcher.onDidChange(triggerConfigChange),
        configWatcher.onDidCreate(triggerConfigChange),
        configWatcher.onDidDelete(triggerConfigChange),
        vscode.workspace.onDidSaveTextDocument(handleOnDidSaveTextDocument),
        vscode.workspace.onDidRenameFiles(handleRenameFile),
        vscode.workspace.onDidDeleteFiles(handleDeleteFile),
        vscode.workspace.onDidCreateFiles(handleCreateFile),
        vscode.workspace.onDidOpenTextDocument(handleOpenFile),
        vscode.workspace.onDidChangeConfiguration(handleConfigChange),
        vscode.window.onDidChangeActiveTextEditor(handleOnDidChangeActiveTextEditor),
        vscode.window.onDidChangeVisibleTextEditors(handleOnDidChangeVisibleTextEditors),
        vscode.languages.onDidChangeDiagnostics(handleOnDidChangeDiagnostics),
        decorator,
        decoratorExclusions,
        registerSpellCheckerCodeActionProvider(issueTracker),

        ...commands.registerCommands(extensionCommand),

        /*
         * We need to listen for all change events and see of `cSpell` section changed.
         * When it does, we have to trigger the server to fetch the settings again.
         * This is to handle a bug in the language-server synchronize configuration. It will not synchronize
         * if the section didn't already exist. This leads to a poor user experience in situations like
         * adding a word to be ignored for the first time.
         */
        vscode.workspace.onDidChangeConfiguration(handleOnDidChangeConfiguration),
    );

    await registerCspellInlineCompletionProviders(context.subscriptions).catch(() => undefined);

    function handleOnDidChangeConfiguration(event: vscode.ConfigurationChangeEvent) {
        if (event.affectsConfiguration(sectionCSpell)) {
            triggerGetSettings();
        }
    }

    /** Watch for changes to possible configuration files. */
    function handleOnDidSaveTextDocument(event: vscode.TextDocument) {
        detectPossibleCSpellConfigChange([event.uri]);
    }

    function handleRenameFile(event: vscode.FileRenameEvent) {
        const uris = event.files.map((f) => f.newUri).concat(event.files.map((f) => f.oldUri));
        detectPossibleCSpellConfigChange(uris);
    }

    function handleDeleteFile(event: vscode.FileDeleteEvent) {
        detectPossibleCSpellConfigChange(event.files);
    }

    function handleCreateFile(event: vscode.FileCreateEvent) {
        detectPossibleCSpellConfigChange(event.files);
    }

    function handleOpenFile(_doc: vscode.TextDocument) {
        // detectPossibleCSpellConfigChange([doc.uri]);
    }

    function handleConfigChange(event: vscode.ConfigurationChangeEvent) {
        if (event.affectsConfiguration(getSectionName('logLevel'))) {
            setOutputChannelLogLevel();
        }
    }

    function handleOnDidChangeActiveTextEditor(e?: vscode.TextEditor) {
        logErrors(updateDocumentRelatedContext(client, e?.document), 'handleOnDidChangeActiveTextEditor');
    }

    function handleOnDidChangeVisibleTextEditors(_e: readonly vscode.TextEditor[]) {
        logErrors(updateDocumentRelatedContext(client, vscode.window.activeTextEditor?.document), 'handleOnDidChangeVisibleTextEditors');
    }

    function handleOnDidChangeDiagnostics(e: vscode.DiagnosticChangeEvent) {
        const activeTextEditor = vscode.window.activeTextEditor;
        if (!activeTextEditor) return;

        const uris = new Set(e.uris.map((u) => u.toString()));
        if (uris.has(activeTextEditor.document.uri.toString())) {
            setTimeout(() => {
                logErrors(updateDocumentRelatedContext(client, activeTextEditor.document), 'handleOnDidChangeDiagnostics');
            }, 10);
        }
    }

    function detectPossibleCSpellConfigChange(files: ReadonlyArray<vscode.Uri>) {
        for (const uri of files) {
            if (settings.configFilesToWatch.has(UriUtils.basename(uri))) {
                triggerGetSettings();
                break;
            }
        }
    }

    // infoViewer.activate(context, client);
    settingsViewer.activate(context, client);

    function registerConfig(path: string) {
        client.registerConfiguration(path);
    }

    const methods = {
        enableLocale: (target: ConfigTargetLegacy | boolean, locale: string) => commands.enableDisableLocaleLegacy(target, locale, true),
        disableLocale: (target: ConfigTargetLegacy | boolean, locale: string) => commands.enableDisableLocaleLegacy(target, locale, false),
    };

    const server = {
        registerConfig,
        triggerGetSettings,
        enableLanguageId: commands.enableLanguageIdCmd,
        disableLanguageId: commands.disableLanguageIdCmd,
        enableCurrentLanguage: commands.enableCurrentLanguage,
        disableCurrentLanguage: commands.disableCurrentLanguage,
        addWordToUserDictionary: addWords.addWordToUserDictionary,
        addWordToWorkspaceDictionary: addWords.addWordToWorkspaceDictionary,
        enableLocale: methods.enableLocale,
        disableLocale: methods.disableLocale,
        updateSettings: () => false,
        cSpellClient: () => client,
        getConfigurationForDocument: (doc: vscode.TextDocument) => client.getConfigurationForDocument(doc),

        // Legacy
        enableLocal: methods.enableLocale,
        disableLocal: methods.disableLocale,
    };

    activateWebview(context);

    performance.mark('cspell_activate_end');
    performance.measure('cspell_activation', 'cspell_activate_start', 'cspell_activate_end');
    return server;
}

function bindLoggerToOutput(logOutput: vscode.LogOutputChannel): vscode.Disposable {
    const disposableList = createDisposableList();
    const console = {
        log: debugMode ? logOutput.info.bind(logOutput) : logOutput.debug.bind(logOutput),
        error: logOutput.error.bind(logOutput),
        info: logOutput.info.bind(logOutput),
        warn: logOutput.warn.bind(logOutput),
    };
    logger.setConnection({ console, onExit: (fn) => disposableList.push(fn) });
    logger.logTime = false;
    logger.logSequence = false;
    return disposableList;
}

performance.mark('cspell_done_load');

function setOutputChannelLogLevel(level?: CSpellSettings['logLevel']) {
    const logLevel = level ?? (settings.getSettingFromVSConfig('logLevel', undefined) || 'Error');
    logger.level = logLevel;
}
