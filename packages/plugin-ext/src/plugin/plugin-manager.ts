// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import {
    PLUGIN_RPC_CONTEXT,
    AbstractPluginManagerExt,
    NotificationMain,
    MainMessageType,
    MessageRegistryMain,
    PluginManagerExt,
    PluginManager,
    Plugin,
    PluginAPI,
    ConfigStorage,
    PluginManagerInitializeParams,
    PluginManagerStartParams,
    TerminalServiceExt,
    LocalizationExt,
    ExtensionKind
} from '../common/plugin-api-rpc';
import { PluginMetadata, PluginJsonValidationContribution } from '../common/plugin-protocol';
import * as theia from '@theia/plugin';
import * as types from './types-impl';
import { join } from './path';
import { EnvExtImpl } from './env';
import { PreferenceRegistryExtImpl } from './preference-registry';
import { InternalStorageExt, Memento, GlobalState } from './plugin-storage';
import { ExtPluginApi } from '../common/plugin-ext-api-contribution';
import { RPCProtocol } from '../common/rpc-protocol';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { WebviewsExtImpl } from './webviews';
import { URI as Uri } from './types-impl';
import { InternalSecretsExt, SecretStorageExt } from '../plugin/secrets-ext';
import { PluginExt } from './plugin-context';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { PluginLogger } from './logger';

export interface PluginHost {

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadPlugin(plugin: Plugin): any;

    init(data: PluginMetadata[]): Promise<[Plugin[], Plugin[]]> | [Plugin[], Plugin[]];

    initExtApi(extApi: ExtPluginApi[]): void;

    loadTests?(): Promise<void>;
}

interface StopFn {
    (): void | Promise<void>;
}

interface StopOptions {
    /**
     * if terminating then stopping will ignore all errors,
     * since the main side is already gone and any requests are likely to fail
     * or hang
     */
    terminating: boolean
}

class ActivatedPlugin {
    constructor(public readonly pluginContext: theia.PluginContext,
        public readonly exports?: PluginAPI,
        public readonly stopFn?: StopFn) {
    }
}

export const MinimalTerminalServiceExt = Symbol('MinimalTerminalServiceExt');
export type MinimalTerminalServiceExt = Pick<TerminalServiceExt,
    'getEnvironmentVariableCollection' | '$initEnvironmentVariableCollections' | '$setShell'>;

@injectable()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class AbstractPluginManagerExtImpl<P extends Record<string, any>> implements AbstractPluginManagerExt<P>, PluginManager {

    @inject(EnvExtImpl)
    protected readonly envExt: EnvExtImpl;

    @inject(MinimalTerminalServiceExt)
    protected readonly terminalService: MinimalTerminalServiceExt;

    @inject(InternalStorageExt)
    protected readonly storage: InternalStorageExt;

    @inject(InternalSecretsExt)
    protected readonly secrets: InternalSecretsExt;

    @inject(LocalizationExt)
    protected readonly localization: LocalizationExt;

    @inject(RPCProtocol)
    protected readonly rpc: RPCProtocol;

    // Cannot be Inversify-injected because it induces a dependency cycle
    protected host: PluginHost;

    private configStorage: ConfigStorage | undefined;
    private readonly registry = new Map<string, Plugin>();
    private readonly activations = new Map<string, (() => Promise<void>)[] | undefined>();
    /** promises to whether loading each plugin has been successful */
    private readonly loadedPlugins = new Map<string, Promise<boolean>>();
    private readonly activatedPlugins = new Map<string, ActivatedPlugin>();
    private readonly pluginContextsMap = new Map<string, theia.PluginContext>();

    private onDidChangeEmitter = new Emitter<void>();
    private messageRegistryProxy: MessageRegistryMain;
    private notificationMain: NotificationMain;
    private logger: PluginLogger;

    protected jsonValidation: PluginJsonValidationContribution[] = [];
    protected pluginKind = ExtensionKind.UI;
    protected ready = new Deferred();

    @postConstruct()
    initialize(): void {
        this.messageRegistryProxy = this.rpc.getProxy(PLUGIN_RPC_CONTEXT.MESSAGE_REGISTRY_MAIN);
        this.notificationMain = this.rpc.getProxy(PLUGIN_RPC_CONTEXT.NOTIFICATION_MAIN);
        this.logger = new PluginLogger(this.rpc, 'plugin-manager');
    }

    setPluginHost(pluginHost: PluginHost): void {
        this.host = pluginHost;
    }

    abstract $init(params: P): Promise<void>;

    async $stop(pluginId?: string): Promise<void> {
        if (!pluginId) {
            return this.stopAll();
        }
        this.registry.delete(pluginId);
        this.pluginContextsMap.delete(pluginId);
        this.loadedPlugins.delete(pluginId);
        const plugin = this.activatedPlugins.get(pluginId);
        if (!plugin) {
            return;
        }
        this.activatedPlugins.delete(pluginId);
        return this.stopPlugin(pluginId, plugin);
    }

    async terminate(): Promise<void> {
        return this.stopAll({ terminating: true });
    }

    protected async stopAll(options: StopOptions = { terminating: false }): Promise<void> {
        const promises = [];
        for (const [id, plugin] of this.activatedPlugins) {
            promises.push(this.stopPlugin(id, plugin, options));
        }

        this.registry.clear();
        this.loadedPlugins.clear();
        this.activatedPlugins.clear();
        this.pluginContextsMap.clear();
        await Promise.all(promises);
    }

    protected async stopPlugin(id: string, plugin: ActivatedPlugin, options: StopOptions = { terminating: false }): Promise<void> {
        let result;
        if (plugin.stopFn) {
            try {
                result = plugin.stopFn();
            } catch (e) {
                if (!options.terminating) {
                    this.logger.error(`[${id}]: failed to stop:`, e);
                }
            }
        }

        const pluginContext = plugin.pluginContext;
        if (pluginContext) {
            for (const subscription of pluginContext.subscriptions) {
                try {
                    subscription.dispose();
                } catch (e) {
                    if (!options.terminating) {
                        this.logger.error(`[${id}]: failed to dispose subscription:`, e);
                    }
                }
            }
        }

        try {
            await result;
        } catch (e) {
            if (!options.terminating) {
                this.logger.error(`[${id}]: failed to stop:`, e);
            }
        }
    }

    async $start(params: PluginManagerStartParams): Promise<void> {
        this.configStorage = params.configStorage;

        const [plugins, foreignPlugins] = await this.host.init(params.plugins);
        // add foreign plugins
        for (const plugin of foreignPlugins) {
            this.registerPlugin(plugin);
        }
        // add own plugins, before initialization
        for (const plugin of plugins) {
            this.registerPlugin(plugin);
        }

        // ensure plugins are registered before running activation events
        this.ready.resolve();
        // run eager plugins
        await this.$activateByEvent('*');
        for (const activationEvent of params.activationEvents) {
            await this.$activateByEvent(activationEvent);
        }

        if (this.host.loadTests) {
            return this.host.loadTests();
        }

        this.fireOnDidChange();
    }

    protected registerPlugin(plugin: Plugin): void {
        if (plugin.model.id === 'vscode.json-language-features' && this.jsonValidation.length) {
            // VS Code contributes all built-in validations via vscode.json-language-features;
            // we enrich them with Theia validations registered on startup.
            // Dynamic validations can be provided only via VS Code extensions.
            // Content is fetched by the extension later via vscode.workspace.openTextDocument.
            const contributes = plugin.rawModel.contributes = (plugin.rawModel.contributes || {});
            contributes.jsonValidation = (contributes.jsonValidation || []).concat(this.jsonValidation);
        }
        this.registry.set(plugin.model.id, plugin);
        const activationEvents = this.getActivationEvents(plugin);
        if (plugin.pluginPath && activationEvents) {
            const activation = () => this.$activatePlugin(plugin.model.id);
            // an internal activation event is a subject to change
            this.setActivation(`onPlugin:${plugin.model.id}`, activation);
            const unsupportedActivationEvents = activationEvents.filter(e => !this.isSupportedActivationEvent(e));
            if (unsupportedActivationEvents.length) {
                this.logger.warn(
                    `Unsupported activation events: ${unsupportedActivationEvents.join(', ')}, please open an issue: https://github.com/eclipse-theia/theia/issues/new`
                );
            }
            for (let activationEvent of activationEvents) {
                if (activationEvent === 'onUri') {
                    activationEvent = `onUri:${this.envExt.uriScheme}://${plugin.model.id}`;
                }
                this.setActivation(activationEvent, activation);
            }
        }
    }

    protected getActivationEvents(plugin: Plugin): string[] | undefined {
        const result = plugin.rawModel.activationEvents;
        return Array.isArray(result) ? result : undefined;
    }

    protected abstract isSupportedActivationEvent(activationEvent: string): boolean;

    protected setActivation(activationEvent: string, activation: () => Promise<void>): void {
        const activations = this.activations.get(activationEvent) || [];
        activations.push(activation);
        this.activations.set(activationEvent, activations);
    }

    protected async loadPlugin(plugin: Plugin, configStorage: ConfigStorage, visited = new Set<string>()): Promise<boolean> {
        // in order to break cycles
        if (visited.has(plugin.model.id)) {
            return true;
        }
        visited.add(plugin.model.id);

        let loading = this.loadedPlugins.get(plugin.model.id);
        if (!loading) {
            loading = (async () => {
                const progressId = await this.notificationMain.$startProgress({
                    title: `Activating ${plugin.model.displayName || plugin.model.name}`,
                    location: 'window'
                });
                try {
                    if (plugin.rawModel.extensionDependencies) {
                        for (const dependencyId of plugin.rawModel.extensionDependencies) {
                            const dependency = this.registry.get(dependencyId.toLowerCase());
                            if (dependency) {
                                const loadedSuccessfully = await this.loadPlugin(dependency, configStorage, visited);
                                if (!loadedSuccessfully) {
                                    throw new Error(`Dependent plugin '${dependency.model.displayName || dependency.model.id}' failed to activate.`);
                                }
                            } else {
                                throw new Error(`Dependent plugin '${dependencyId}' is not installed.`);
                            }
                        }
                    }

                    let pluginMain = this.host.loadPlugin(plugin);
                    // see https://github.com/TypeFox/vscode/blob/70b8db24a37fafc77247de7f7cb5bb0195120ed0/src/vs/workbench/api/common/extHostExtensionService.ts#L372-L376
                    pluginMain = pluginMain || {};
                    await this.startPlugin(plugin, configStorage, pluginMain);
                    return true;
                } catch (err) {
                    const message = `Activating plugin '${plugin.model.displayName || plugin.model.name}' failed:`;
                    this.messageRegistryProxy.$showMessage(MainMessageType.Error, message + ' ' + err.message, {}, []);
                    this.logger.error(message, err);
                    return false;
                } finally {
                    this.notificationMain.$stopProgress(progressId);
                }
            })();
        }
        this.loadedPlugins.set(plugin.model.id, loading);
        return loading;
    }

    async $updateStoragePath(path: string | undefined): Promise<void> {
        if (this.configStorage) {
            this.configStorage.hostStoragePath = path;
        }
        this.pluginContextsMap.forEach((pluginContext: theia.PluginContext, pluginId: string) => {
            pluginContext.storagePath = path ? join(path, pluginId) : undefined;
        });
    }

    async $activateByEvent(activationEvent: string): Promise<void> {
        // Prevent the plugin manager from performing activations before plugins are registered
        await this.ready.promise;
        if (activationEvent.endsWith(':*')) {
            const baseEvent = activationEvent.substring(0, activationEvent.length - 2);
            await this.activateByBaseEvent(baseEvent);
        } else {
            await this.activateBySingleEvent(activationEvent);
        }
    }

    protected async activateByBaseEvent(baseEvent: string): Promise<void> {
        await Promise.all(Array.from(this.activations.keys(), activation => activation.startsWith(baseEvent) && this.activateBySingleEvent(activation)));
    }

    protected async activateBySingleEvent(activationEvent: string): Promise<void> {
        const activations = this.activations.get(activationEvent);
        if (!activations) {
            return;
        }
        this.activations.set(activationEvent, undefined);
        const pendingActivations = [];
        while (activations.length) {
            pendingActivations.push(activations.pop()!());
        }
        await Promise.all(pendingActivations);
    }

    async $activatePlugin(id: string): Promise<void> {
        const plugin = this.registry.get(id);
        if (plugin && this.configStorage) {
            await this.loadPlugin(plugin, this.configStorage);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async startPlugin(plugin: Plugin, configStorage: ConfigStorage, pluginMain: any): Promise<void> {
        const subscriptions: theia.Disposable[] = [];
        const asAbsolutePath = (relativePath: string): string => join(plugin.pluginFolder, relativePath);
        const logPath = join(configStorage.hostLogPath, plugin.model.id); // todo check format
        const storagePath = configStorage.hostStoragePath ? join(configStorage.hostStoragePath, plugin.model.id) : undefined;
        const secrets = new SecretStorageExt(plugin, this.secrets);
        const globalStoragePath = join(configStorage.hostGlobalStoragePath, plugin.model.id);
        const extension = new PluginExt(this, plugin);
        const extensionModeValue = plugin.isUnderDevelopment ? types.ExtensionMode.Development : types.ExtensionMode.Production;

        const pluginContext: theia.PluginContext = {
            extensionPath: extension.extensionPath,
            extensionUri: extension.extensionUri,
            globalState: new GlobalState(plugin.model.id, true, this.storage),
            workspaceState: new Memento(plugin.model.id, false, this.storage),
            subscriptions: subscriptions,
            asAbsolutePath: asAbsolutePath,
            logPath: logPath,
            storagePath: storagePath,
            storageUri: storagePath ? Uri.file(storagePath) : undefined,
            secrets,
            globalStoragePath: globalStoragePath,
            globalStorageUri: Uri.file(globalStoragePath),
            environmentVariableCollection: this.terminalService.getEnvironmentVariableCollection(plugin.model.id),
            extensionMode: extensionModeValue,
            extension,
            logUri: Uri.file(logPath),
            languageModelAccessInformation: {
                /** @stubbed LanguageModelChat */
                onDidChange: (listener, thisArgs?, disposables?) => Event.None(listener, thisArgs, disposables),
                canSendRequest(chat: theia.LanguageModelChat): boolean | undefined {
                    return undefined;
                }
            }
        };
        this.pluginContextsMap.set(plugin.model.id, pluginContext);

        let stopFn = undefined;
        if (typeof pluginMain[plugin.lifecycle.stopMethod] === 'function') {
            stopFn = pluginMain[plugin.lifecycle.stopMethod];
        }
        const id = plugin.model.displayName || plugin.model.id;
        if (typeof pluginMain[plugin.lifecycle.startMethod] === 'function') {
            await this.localization.initializeLocalizedMessages(plugin, this.envExt.language);
            const pluginExport = await pluginMain[plugin.lifecycle.startMethod].apply(getGlobal(), [pluginContext]);
            this.logger.debug(`Calling activation function on plugin ${id}`);
            this.activatedPlugins.set(plugin.model.id, new ActivatedPlugin(pluginContext, pluginExport, stopFn));
        } else {
            // https://github.com/TypeFox/vscode/blob/70b8db24a37fafc77247de7f7cb5bb0195120ed0/src/vs/workbench/api/common/extHostExtensionService.ts#L400-L401
            this.logger.debug(`Plugin ${id}, ${plugin.lifecycle.startMethod} method is undefined so the module is the extension's exports`);
            this.activatedPlugins.set(plugin.model.id, new ActivatedPlugin(pluginContext, pluginMain));
        }
    }

    getPluginKind(): theia.ExtensionKind {
        return this.pluginKind;
    }

    getAllPlugins(): Plugin[] {
        return Array.from(this.registry.values());
    }
    getPluginExport(pluginId: string): PluginAPI | undefined {
        const activePlugin = this.activatedPlugins.get(pluginId);
        if (activePlugin) {
            return activePlugin.exports;
        }
        return undefined;
    }

    getPluginById(pluginId: string): Plugin | undefined {
        return this.registry.get(pluginId);
    }

    isRunning(pluginId: string): boolean {
        return this.registry.has(pluginId);
    }

    isActive(pluginId: string): boolean {
        return this.activatedPlugins.has(pluginId);
    }

    activatePlugin(pluginId: string): PromiseLike<void> {
        return this.$activatePlugin(pluginId);
    }

    get onDidChange(): theia.Event<void> {
        return this.onDidChangeEmitter.event;
    }

    protected fireOnDidChange(): void {
        this.onDidChangeEmitter.fire(undefined);
    }

}

@injectable()
export class PluginManagerExtImpl extends AbstractPluginManagerExtImpl<PluginManagerInitializeParams> implements PluginManagerExt {

    @inject(PreferenceRegistryExtImpl)
    protected readonly preferencesManager: PreferenceRegistryExtImpl;

    @inject(WebviewsExtImpl)
    protected readonly webview: WebviewsExtImpl;

    private supportedActivationEvents: Set<string>;

    async $init(params: PluginManagerInitializeParams): Promise<void> {
        this.storage.init(params.globalState, params.workspaceState);

        this.envExt.setQueryParameters(params.env.queryParams);
        this.envExt.setUIKind(params.env.uiKind);
        this.envExt.setLanguage(params.env.language);
        this.terminalService.$setShell(params.env.shell);
        this.envExt.setApplicationName(params.env.appName);
        this.envExt.setAppHost(params.env.appHost);
        this.envExt.setAppRoot(params.env.appRoot);
        this.envExt.setAppUriScheme(params.env.appUriScheme);

        this.preferencesManager.init(params.preferences);

        if (params.extApi) {
            this.host.initExtApi(params.extApi);
        }

        this.webview.init(params.webview);
        this.jsonValidation = params.jsonValidation;
        this.pluginKind = params.pluginKind;

        this.supportedActivationEvents = new Set(params.supportedActivationEvents ?? []);
    }

    protected isSupportedActivationEvent(activationEvent: string): boolean {
        return this.supportedActivationEvents.has(activationEvent.split(':')[0]);
    }

}

// for electron
function getGlobal(): Window | NodeJS.Global | null {
    return typeof self === 'undefined' ? typeof global === 'undefined' ? null : global : self;
}
