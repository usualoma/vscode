/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { toDisposable, Disposable } from 'vs/base/common/lifecycle';
import { IMessagePassingProtocol } from 'vs/base/parts/ipc/common/ipc';
import { VSBuffer } from 'vs/base/common/buffer';
import { createMessageOfType, MessageType, isMessageOfType, ExtensionHostExitCode } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import { IInitData, UIKind } from 'vs/workbench/api/common/extHost.protocol';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { ILabelService } from 'vs/platform/label/common/label';
import { ILogService } from 'vs/platform/log/common/log';
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import * as platform from 'vs/base/common/platform';
import * as dom from 'vs/base/browser/dom';
import { URI } from 'vs/base/common/uri';
import { IExtensionHost, ExtensionHostLogFileName, ExtensionHostKind } from 'vs/workbench/services/extensions/common/extensions';
import { IProductService } from 'vs/platform/product/common/productService';
import { IBrowserWorkbenchEnvironmentService } from 'vs/workbench/services/environment/browser/environmentService';
import { joinPath } from 'vs/base/common/resources';
import { Registry } from 'vs/platform/registry/common/platform';
import { IOutputChannelRegistry, Extensions } from 'vs/workbench/services/output/common/output';
import { localize } from 'vs/nls';
import { generateUuid } from 'vs/base/common/uuid';
import { canceled, onUnexpectedError } from 'vs/base/common/errors';
import { Barrier } from 'vs/base/common/async';
import { ILayoutService } from 'vs/platform/layout/browser/layoutService';
import { FileAccess } from 'vs/base/common/network';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';

export interface IWebWorkerExtensionHostInitData {
	readonly autoStart: boolean;
	readonly extensions: IExtensionDescription[];
}

export interface IWebWorkerExtensionHostDataProvider {
	getInitData(): Promise<IWebWorkerExtensionHostInitData>;
}

export class WebWorkerExtensionHost extends Disposable implements IExtensionHost {

	public readonly kind = ExtensionHostKind.LocalWebWorker;
	public readonly remoteAuthority = null;
	public readonly lazyStart: boolean;

	private readonly _onDidExit = this._register(new Emitter<[number, string | null]>());
	public readonly onExit: Event<[number, string | null]> = this._onDidExit.event;

	private _isTerminating: boolean;
	private _protocolPromise: Promise<IMessagePassingProtocol> | null;
	private _protocol: IMessagePassingProtocol | null;

	private readonly _extensionHostLogsLocation: URI;
	private readonly _extensionHostLogFile: URI;

	constructor(
		lazyStart: boolean,
		private readonly _initDataProvider: IWebWorkerExtensionHostDataProvider,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@ILabelService private readonly _labelService: ILabelService,
		@ILogService private readonly _logService: ILogService,
		@IBrowserWorkbenchEnvironmentService private readonly _environmentService: IBrowserWorkbenchEnvironmentService,
		@IProductService private readonly _productService: IProductService,
		@ILayoutService private readonly _layoutService: ILayoutService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this.lazyStart = lazyStart;
		this._isTerminating = false;
		this._protocolPromise = null;
		this._protocol = null;
		this._extensionHostLogsLocation = joinPath(this._environmentService.extHostLogsPath, 'webWorker');
		this._extensionHostLogFile = joinPath(this._extensionHostLogsLocation, `${ExtensionHostLogFileName}.log`);
	}

	private _getWebWorkerExtensionHostIframeSrc(): string {
		const suffix = this._environmentService.debugExtensionHost && this._environmentService.debugRenderer ? '?debugged=1' : '?';
		const iframeModulePath = 'vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html';
		if (platform.isWeb) {
			const webEndpointUrlTemplate = this._productService.webEndpointUrlTemplate;
			const commit = this._productService.commit;
			const quality = this._productService.quality;
			if (webEndpointUrlTemplate && commit && quality) {
				// Try to keep the web worker extension host iframe origin stable by storing it in workspace storage
				const key = 'webWorkerExtensionHostIframeStableOriginUUID';
				let stableOriginUUID = this._storageService.get(key, StorageScope.WORKSPACE);
				if (typeof stableOriginUUID === 'undefined') {
					stableOriginUUID = generateUuid();
					this._storageService.store(key, stableOriginUUID, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				}
				const baseUrl = (
					webEndpointUrlTemplate
						.replace('{{uuid}}', stableOriginUUID)
						.replace('{{commit}}', commit)
						.replace('{{quality}}', quality)
				);
				return `${baseUrl}/out/${iframeModulePath}${suffix}`;
			}

			console.warn(`The web worker extension host is started in a same-origin iframe!`);
		}

		const relativeExtensionHostIframeSrc = FileAccess.asBrowserUri(iframeModulePath, require);
		return `${relativeExtensionHostIframeSrc.toString(true)}${suffix}`;
	}

	public async start(): Promise<IMessagePassingProtocol> {
		if (!this._protocolPromise) {
			this._protocolPromise = this._startInsideIframe(this._getWebWorkerExtensionHostIframeSrc());
			this._protocolPromise.then(protocol => this._protocol = protocol);
		}
		return this._protocolPromise;
	}

	private async _startInsideIframe(webWorkerExtensionHostIframeSrc: string): Promise<IMessagePassingProtocol> {
		const emitter = this._register(new Emitter<VSBuffer>());

		const iframe = document.createElement('iframe');
		iframe.setAttribute('class', 'web-worker-ext-host-iframe');
		iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
		iframe.style.display = 'none';

		const vscodeWebWorkerExtHostId = generateUuid();
		iframe.setAttribute('src', `${webWorkerExtensionHostIframeSrc}&vscodeWebWorkerExtHostId=${vscodeWebWorkerExtHostId}`);

		const barrier = new Barrier();
		let port!: MessagePort;
		let barrierError: Error | null = null;
		let barrierHasError = false;
		let startTimeout: any = null;

		const rejectBarrier = (exitCode: number, error: Error) => {
			barrierError = error;
			barrierHasError = true;
			onUnexpectedError(barrierError);
			clearTimeout(startTimeout);
			this._onDidExit.fire([ExtensionHostExitCode.UnexpectedError, barrierError.message]);
			barrier.open();
		};

		const resolveBarrier = (messagePort: MessagePort) => {
			port = messagePort;
			clearTimeout(startTimeout);
			barrier.open();
		};

		startTimeout = setTimeout(() => {
			console.warn(`The Web Worker Extension Host did not start in 60s, that might be a problem.`);
		}, 60000);

		this._register(dom.addDisposableListener(window, 'message', (event) => {
			if (event.source !== iframe.contentWindow) {
				return;
			}
			if (event.data.vscodeWebWorkerExtHostId !== vscodeWebWorkerExtHostId) {
				return;
			}
			if (event.data.error) {
				const { name, message, stack } = event.data.error;
				const err = new Error();
				err.message = message;
				err.name = name;
				err.stack = stack;
				return rejectBarrier(ExtensionHostExitCode.UnexpectedError, err);
			}
			const { data } = event.data;
			if (barrier.isOpen() || !(data instanceof MessagePort)) {
				console.warn('UNEXPECTED message', event);
				const err = new Error('UNEXPECTED message');
				return rejectBarrier(ExtensionHostExitCode.UnexpectedError, err);
			}
			resolveBarrier(data);
		}));

		this._layoutService.container.appendChild(iframe);
		this._register(toDisposable(() => iframe.remove()));

		// await MessagePort and use it to directly communicate
		// with the worker extension host
		await barrier.wait();

		if (barrierHasError) {
			throw barrierError;
		}

		// Send over message ports for extension API
		const messagePorts = this._environmentService.options?.messagePorts ?? new Map();
		iframe.contentWindow!.postMessage(messagePorts, '*', [...messagePorts.values()]);

		port.onmessage = (event) => {
			const { data } = event;
			if (!(data instanceof ArrayBuffer)) {
				console.warn('UNKNOWN data received', data);
				this._onDidExit.fire([77, 'UNKNOWN data received']);
				return;
			}
			emitter.fire(VSBuffer.wrap(new Uint8Array(data, 0, data.byteLength)));
		};

		const protocol: IMessagePassingProtocol = {
			onMessage: emitter.event,
			send: vsbuf => {
				const data = vsbuf.buffer.buffer.slice(vsbuf.buffer.byteOffset, vsbuf.buffer.byteOffset + vsbuf.buffer.byteLength);
				port.postMessage(data, [data]);
			}
		};

		return this._performHandshake(protocol);
	}

	private async _performHandshake(protocol: IMessagePassingProtocol): Promise<IMessagePassingProtocol> {
		// extension host handshake happens below
		// (1) <== wait for: Ready
		// (2) ==> send: init data
		// (3) <== wait for: Initialized

		await Event.toPromise(Event.filter(protocol.onMessage, msg => isMessageOfType(msg, MessageType.Ready)));
		if (this._isTerminating) {
			throw canceled();
		}
		protocol.send(VSBuffer.fromString(JSON.stringify(await this._createExtHostInitData())));
		if (this._isTerminating) {
			throw canceled();
		}
		await Event.toPromise(Event.filter(protocol.onMessage, msg => isMessageOfType(msg, MessageType.Initialized)));
		if (this._isTerminating) {
			throw canceled();
		}

		// Register log channel for web worker exthost log
		Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels).registerChannel({ id: 'webWorkerExtHostLog', label: localize('name', "Worker Extension Host"), file: this._extensionHostLogFile, log: true });

		return protocol;
	}

	public override dispose(): void {
		if (this._isTerminating) {
			return;
		}
		this._isTerminating = true;
		if (this._protocol) {
			this._protocol.send(createMessageOfType(MessageType.Terminate));
		}
		super.dispose();
	}

	getInspectPort(): number | undefined {
		return undefined;
	}

	enableInspectPort(): Promise<boolean> {
		return Promise.resolve(false);
	}

	private async _createExtHostInitData(): Promise<IInitData> {
		const [telemetryInfo, initData] = await Promise.all([this._telemetryService.getTelemetryInfo(), this._initDataProvider.getInitData()]);
		const workspace = this._contextService.getWorkspace();
		return {
			commit: this._productService.commit,
			version: this._productService.version,
			parentPid: -1,
			environment: {
				isExtensionDevelopmentDebug: this._environmentService.debugRenderer,
				appName: this._productService.nameLong,
				appHost: this._productService.embedderIdentifier ?? (platform.isWeb ? 'web' : 'desktop'),
				appUriScheme: this._productService.urlProtocol,
				appLanguage: platform.language,
				extensionDevelopmentLocationURI: this._environmentService.extensionDevelopmentLocationURI,
				extensionTestsLocationURI: this._environmentService.extensionTestsLocationURI,
				globalStorageHome: this._environmentService.globalStorageHome,
				workspaceStorageHome: this._environmentService.workspaceStorageHome,
			},
			workspace: this._contextService.getWorkbenchState() === WorkbenchState.EMPTY ? undefined : {
				configuration: workspace.configuration || undefined,
				id: workspace.id,
				name: this._labelService.getWorkspaceLabel(workspace),
				transient: workspace.transient
			},
			resolvedExtensions: [],
			hostExtensions: [],
			extensions: initData.extensions,
			telemetryInfo,
			logLevel: this._logService.getLevel(),
			logsLocation: this._extensionHostLogsLocation,
			logFile: this._extensionHostLogFile,
			autoStart: initData.autoStart,
			remote: {
				authority: this._environmentService.remoteAuthority,
				connectionData: null,
				isRemote: false
			},
			uiKind: platform.isWeb ? UIKind.Web : UIKind.Desktop
		};
	}
}
