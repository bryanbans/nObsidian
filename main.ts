/*
    Originally created by EasyChris (2022)
    Modified by Quan Phan (2023)

    This file is part of nObsidian and is licensed under the GNU General Public License v3.0.
    Modifications include <brief description of modifications>.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { App, Notice, Plugin, PluginManifest, TFile } from "obsidian";
import * as yamlFrontMatter from "yaml-front-matter";
import {
	PluginSettings,
	MarkdownWithFrontMatter,
	ServiceResult,
	BulkUploadFileResult,
} from "service/types";
import { NObsidianSettingTab } from "settingTab";
import { NoticeMessageConfig, getBasenameFromPath } from "service/utils";
import {
	pullFileFromNotion,
	runWithConcurrency,
	syncFile,
	uploadFile,
} from "service";
import { SyncView, VIEW_TYPE_SYNC } from "./view";

// Define your default settings
const DEFAULT_SETTINGS: PluginSettings = {
	notionAPIToken: "",
	databaseID: "",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
	bidirectionalSync: false,
};

const BULK_UPLOAD_CONCURRENCY = 3;

export default class NObsidian extends Plugin {
	settings: PluginSettings;
	message: { [key: string]: string };
	fileNameToFile: Map<string, TFile>;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.settings = DEFAULT_SETTINGS;
		this.message = NoticeMessageConfig(
			window.localStorage.getItem("language") || "en"
		);
		this.fileNameToFile = new Map<string, TFile>();
	}

	async onload() {
		// Retrieve settings from settings tab
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);

		// Register the sync side panel, ribbon icon, and opener command.
		this.registerView(
			VIEW_TYPE_SYNC,
			(leaf) => new SyncView(leaf, this)
		);
		this.addRibbonIcon("sync", "Open Nobsidion sync panel", () => {
			this.activateSyncView();
		});

		// Add commands to vault
		this.addCustomCommands();

		// Furnish the map
		const markdownFiles = this.app.vault.getMarkdownFiles();
		markdownFiles.forEach((file) => {
			this.fileNameToFile.set(file.basename, file);
		});

		// Register events
		this.registerCustomEvents();

		// Add settings tab to plugin
		this.addSettingTab(new NObsidianSettingTab(this.app, this));
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	addCustomCommands() {
		this.addCommand({
			id: "share-to-notion",
			name: "Upload current note to Notion",
			editorCallback: async () => {
				this.uploadCurrentNote();
			},
		});

		this.addCommand({
			id: "bulk-share-to-notion",
			name: "Upload entire vault to Notion",
			callback: async () => {
				this.bulkUpload();
			},
		});

		this.addCommand({
			id: "pull-current-note-from-notion",
			name: "Pull current note from Notion",
			editorCallback: async () => {
				this.pullCurrentNote();
			},
		});

		this.addCommand({
			id: "sync-current-note-with-notion",
			name: "Sync current note with Notion",
			editorCallback: async () => {
				this.syncCurrentNote();
			},
		});

		this.addCommand({
			id: "open-sync-panel",
			name: "Open sync panel",
			callback: () => {
				this.activateSyncView();
			},
		});
	}

	async activateSyncView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SYNC)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			leaf = rightLeaf;
			await leaf.setViewState({ type: VIEW_TYPE_SYNC, active: true });
		}

		workspace.revealLeaf(leaf);
	}

	registerCustomEvents() {
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile) {
					this.fileNameToFile.set(file.basename, file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					this.fileNameToFile.delete(file.basename);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					const oldName = getBasenameFromPath(oldPath);
					this.fileNameToFile.delete(oldName);
					this.fileNameToFile.set(file.basename, file);
				}
			})
		);
	}

	async uploadCurrentNote() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return null;
		}

		this.uploadFile(nowFile);
	}

	async bulkUpload() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const markdownFiles = this.app.vault.getMarkdownFiles();
		const results = await runWithConcurrency(
			markdownFiles,
			BULK_UPLOAD_CONCURRENCY,
			async (file): Promise<BulkUploadFileResult> => {
				try {
					const uploadResult = await this.uploadFile(file);
					return {
						fileName: file.basename,
						error: uploadResult.error,
					};
				} catch (error) {
					const uploadError =
						error instanceof Error ? error : Error(String(error));
					this.displayResult(
						{ data: null, error: uploadError },
						file.basename
					);
					return { fileName: file.basename, error: uploadError };
				}
			}
		);
		const failedUploads = results.filter((result) => result.error);

		if (failedUploads.length > 0) {
			const succeededUploads = results.length - failedUploads.length;
			new Notice(
				`Vault sync finished: ${succeededUploads}/${results.length} notes uploaded. ${failedUploads.length} failed.`,
				5000
			);
			return;
		}

		new Notice(this.message["all-sync-success"]);
	}

	async pullCurrentNote() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return null;
		}

		const pullResult = await pullFileFromNotion(this, nowFile);
		this.displayResult(pullResult, nowFile.basename);
	}

	async syncCurrentNote() {
		if (!this.hasValidNotionCredentials()) {
			new Notice(this.message["config-settings"]);
			return;
		}

		const nowFile = this.app.workspace.getActiveFile();
		if (!nowFile) {
			new Notice(this.message["open-file"]);
			return null;
		}

		const syncResult = await syncFile(this, nowFile);
		this.displayResult(syncResult, nowFile.basename);
	}

	hasValidNotionCredentials() {
		const { notionAPIToken, databaseID } = this.settings;
		return notionAPIToken !== "" && databaseID !== "";
	}

	async uploadFile(file: TFile): Promise<ServiceResult> {
		const uploadResult = await uploadFile(this, file);
		this.displayResult(uploadResult, file.basename);
		return uploadResult;
	}

	async getContent(file: TFile): Promise<MarkdownWithFrontMatter> {
		const content = await this.app.vault.read(file);
		const contentWithFrontMatter = yamlFrontMatter.loadFront(content);
		return contentWithFrontMatter;
	}

	async createEmptyMarkdownFile(pageName: string): Promise<TFile> {
		const newFilePath = `/${pageName}.md`;
		const newFile = await this.app.vault.create(newFilePath, "");
		// file create handler will update fileNameToFile Map
		// see registerCustomEvents
		return newFile;
	}

	async updateMarkdownFile(file: TFile, newContent: string): Promise<void> {
		await file.vault.modify(file, newContent);
	}

	displayResult(uploadResult: ServiceResult, pageName: string) {
		if (uploadResult.error) {
			const errorMessage = uploadResult.error.message;
			new Notice(`${errorMessage}${pageName}`, 5000);
			return;
		}

		new Notice(`${this.message["sync-success"]}${pageName}`);
	}
}
