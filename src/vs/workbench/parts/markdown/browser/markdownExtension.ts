/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import types = require('vs/base/common/types');
import URI from 'vs/base/common/uri';
import {EventType} from 'vs/base/common/events';
import {FileChangeType, FileChangesEvent, EventType as FileEventType} from 'vs/platform/files/common/files';
import paths = require('vs/base/common/paths');
import {getBaseThemeId} from 'vs/platform/theme/common/themes';
import {IWorkbenchContribution} from 'vs/workbench/common/contributions';
import {IFrameEditor} from 'vs/workbench/browser/parts/editor/iframeEditor';
import {MarkdownEditorInput} from 'vs/workbench/parts/markdown/common/markdownEditorInput';
import {IWorkbenchEditorService} from 'vs/workbench/services/editor/common/editorService';
import {IWorkspaceContextService} from 'vs/workbench/services/workspace/common/contextService';
import {IConfigurationService, IConfigurationServiceEvent} from 'vs/platform/configuration/common/configuration';
import {IModelService} from 'vs/editor/common/services/modelService';
import {IEventService} from 'vs/platform/event/common/event';
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';
import {IModeService} from 'vs/editor/common/services/modeService';
import {IThemeService} from 'vs/workbench/services/themes/common/themeService';
import {IDisposable, dispose} from 'vs/base/common/lifecycle';
import {IEditorGroupService} from 'vs/workbench/services/group/common/groupService';

interface ILanguageConfiguration {
	markdown: {
		styles: string[];
	};
}

// This extension tracks markdown files for changes to update markdown editors and inputs accordingly.
export class MarkdownFileTracker implements IWorkbenchContribution {

	private static RELOAD_MARKDOWN_DELAY = 300; // delay before reloading markdown preview after user typing

	private fileChangeListener: IDisposable;
	private configFileChangeListener: IDisposable;
	private themeChangeListener: IDisposable;
	private editorInputChangeListener: IDisposable;
	private markdownConfigurationThumbprint: string;
	private markdownConfigurationPaths: string[];
	private reloadTimeout: number;
	private hasModelListenerOnResourcePath: { [resource: string]: boolean; };

	constructor(
		@IModeService private modeService: IModeService,
		@IEventService private eventService: IEventService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IModelService private modelService: IModelService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThemeService private themeService: IThemeService
	) {
		this.markdownConfigurationPaths = [];
		this.hasModelListenerOnResourcePath = Object.create(null);

		this.configureMode(themeService.getTheme());

		this.registerListeners();
	}

	private registerListeners(): void {
		this.fileChangeListener = this.eventService.addListener2(FileEventType.FILE_CHANGES, (e: FileChangesEvent) => this.onFileChanges(e));
		this.configFileChangeListener = this.configurationService.onDidUpdateConfiguration(e => this.onConfigFileChange(e));

		// reload markdown editors when their resources change
		this.editorInputChangeListener = this.editorGroupService.onEditorsChanged(() => this.onEditorsChanged());

		// initially read the config for CSS styles in preview
		this.readMarkdownConfiguration(this.configurationService.getConfiguration<ILanguageConfiguration>());

		// listen to theme changes
		this.themeChangeListener = this.themeService.onDidThemeChange(themeId => {
			this.configureMode(themeId);
			this.reloadMarkdownEditors(true);
		});
	}

	private onEditorsChanged(): void {
		let input = this.editorService.getActiveEditorInput();
		if (input instanceof MarkdownEditorInput) {
			let markdownResource = input.getResource();
			let editorModel = this.modelService.getModel(markdownResource);
			if (editorModel && !this.hasModelListenerOnResourcePath[markdownResource.toString()]) {
				let toUnbind: IDisposable[] = [];
				let unbind = () => {
					toUnbind = dispose(toUnbind);

					this.hasModelListenerOnResourcePath[markdownResource.toString()] = false;
				};

				// Listen on changes to the underlying resource of the markdown preview
				toUnbind.push(editorModel.onDidChangeContent(() => {
					if (this.reloadTimeout) {
						window.clearTimeout(this.reloadTimeout);
					}

					this.reloadTimeout = setTimeout(() => {
						if (!this.reloadMarkdownEditors(false, markdownResource)) {
							unbind();
						}
					}, MarkdownFileTracker.RELOAD_MARKDOWN_DELAY);
				}));

				// Mark as being listened
				this.hasModelListenerOnResourcePath[markdownResource.toString()] = true;

				// Unbind when input or model gets disposed
				toUnbind.push(input.addListener2(EventType.DISPOSE, unbind));
				toUnbind.push(editorModel.onWillDispose(unbind));
			}
		}
	}

	private configureMode(theme: string): void {
		if (theme) {
			let baseTheme = getBaseThemeId(theme);
			this.modeService.configureMode('text/x-web-markdown', { theme: baseTheme });
		}
	}

	public getId(): string {
		return 'vs.markdown.filetracker';
	}

	private onConfigFileChange(e: IConfigurationServiceEvent): void {

		// reload markdown editors if styles change
		if (this.readMarkdownConfiguration(e.config)) {
			this.reloadMarkdownEditors(true);
		}
	}

	private readMarkdownConfiguration(languageConfiguration: ILanguageConfiguration): boolean {
		let oldMarkdownConfigurationThumbprint = this.markdownConfigurationThumbprint;
		let newMarkdownConfigurationThumbprint: string;

		// Reset old
		this.markdownConfigurationThumbprint = null;
		this.markdownConfigurationPaths = [];

		if (languageConfiguration) {
			let markdownConfiguration = languageConfiguration.markdown;
			if (markdownConfiguration && types.isArray(markdownConfiguration.styles)) {
				newMarkdownConfigurationThumbprint = markdownConfiguration.styles.join('');

				let styles: string[] = markdownConfiguration.styles.map((style: string) => paths.makePosixAbsolute(paths.normalize(style)));
				this.markdownConfigurationPaths = styles;
			}
		}

		// Remember as current
		this.markdownConfigurationThumbprint = newMarkdownConfigurationThumbprint;

		return (oldMarkdownConfigurationThumbprint !== newMarkdownConfigurationThumbprint);
	}

	private onFileChanges(e: FileChangesEvent): void {

		// If any of the markdown CSS styles have updated, reload all markdown editors
		if (this.markdownConfigurationPaths.length && e.containsAny(this.markdownConfigurationPaths.map((p) => this.contextService.toResource(p)), FileChangeType.UPDATED)) {
			this.reloadMarkdownEditors(true);
		}
	}

	private reloadMarkdownEditors(clearIFrame: boolean, resource?: URI): boolean {
		let didReload = false;

		let editors = this.editorService.getVisibleEditors();
		editors.forEach((editor) => {

			// Only applicable to markdown editor inputs in iframe editors
			let input = editor.input;
			if (input instanceof MarkdownEditorInput && editor instanceof IFrameEditor) {
				if (!resource || resource.toString() === input.getResource().toString()) {
					(<IFrameEditor>editor).reload(clearIFrame);
					didReload = true;
				}
			}
		});

		return didReload;
	}

	public dispose(): void {
		if (this.fileChangeListener) {
			this.fileChangeListener.dispose();
			this.fileChangeListener = null;
		}

		if (this.configFileChangeListener) {
			this.configFileChangeListener.dispose();
			this.configFileChangeListener = null;
		}

		if (this.editorInputChangeListener) {
			this.editorInputChangeListener.dispose();
			this.editorInputChangeListener = null;
		}
	}
}