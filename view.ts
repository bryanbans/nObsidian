/*
    This file is part of Notional and is licensed under the GNU General Public License v3.0.

    The Sync side panel: an at-a-glance view of the active note's Notion sync
    state, one-click actions (sync / push / pull), explicit conflict resolution,
    and a rolling activity log.
*/

import {
	ButtonComponent,
	ItemView,
	Notice,
	TFile,
	WorkspaceLeaf,
	debounce,
} from "obsidian";
import NObsidian from "main";
import {
	getSyncStatus,
	pullFileFromNotion,
	syncFile,
	uploadFile,
} from "service";
import { ServiceResult, SyncStatus } from "service/types";

export const VIEW_TYPE_SYNC = "notional-sync-view";

type ActivityEntry = {
	time: number;
	ok: boolean;
	message: string;
};

const relativeTime = (iso?: string): string => {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "unknown";

	const seconds = Math.round((Date.now() - then) / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
};

const clockTime = (ms: number): string => {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const shortenId = (id: string): string =>
	id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

export class SyncView extends ItemView {
	plugin: NObsidian;
	private activity: ActivityEntry[] = [];
	private status: SyncStatus | null = null;
	private currentFile: TFile | null = null;
	private busy = false;
	private debouncedRefresh: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: NObsidian) {
		super(leaf);
		this.plugin = plugin;
		this.debouncedRefresh = debounce(
			() => {
				void this.refresh();
			},
			400,
			true
		);
	}

	getViewType(): string {
		return VIEW_TYPE_SYNC;
	}

	getDisplayText(): string {
		return "Notional sync";
	}

	getIcon(): string {
		return "sync";
	}

	async onOpen(): Promise<void> {
		// Track the active note so the panel always reflects what's in focus.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.debouncedRefresh()
			)
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.debouncedRefresh())
		);
		await this.refresh();
	}

	async onClose(): Promise<void> {
		// Events registered via registerEvent are cleaned up automatically.
	}

	// Allow the plugin to refresh the panel after a background auto-sync.
	async refreshNow(): Promise<void> {
		await this.refresh();
	}

	private logActivity(ok: boolean, message: string): void {
		this.activity.unshift({ time: Date.now(), ok, message });
		if (this.activity.length > 20) this.activity.pop();
	}

	/**
	 * Re-read the active note's sync state (one Notion round-trip when linked)
	 * and re-render. Cheap to call; debounced on note switches.
	 */
	private async refresh(): Promise<void> {
		this.currentFile = this.app.workspace.getActiveFile();
		this.status = null;

		const file = this.currentFile;
		if (
			file &&
			file.extension === "md" &&
			this.plugin.hasValidNotionCredentials()
		) {
			const result = await getSyncStatus(this.plugin, file);
			if (result.error) {
				this.logActivity(
					false,
					`Status check failed: ${result.error.message}`
				);
			} else {
				this.status = result.data as SyncStatus;
			}
		}

		this.render();
	}

	private async runAction(
		label: string,
		action: (file: TFile) => Promise<ServiceResult>
	): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice(this.plugin.message["open-file"]);
			return;
		}
		if (!this.plugin.hasValidNotionCredentials()) {
			new Notice(this.plugin.message["config-settings"]);
			return;
		}

		this.busy = true;
		this.render();

		try {
			const result = await action(file);
			if (result.error) {
				this.logActivity(
					false,
					`${label} failed (${file.basename}): ${result.error.message}`
				);
				new Notice(`${result.error.message}${file.basename}`, 5000);
			} else {
				this.logActivity(true, `${label}: ${file.basename}`);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			this.logActivity(false, `${label} failed: ${message}`);
			new Notice(message, 5000);
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("notional-sync");

		const header = root.createDiv({ cls: "nob-header" });
		header.createEl("h4", { text: "Notional Sync", cls: "nob-title" });
		new ButtonComponent(header)
			.setIcon("refresh-cw")
			.setTooltip("Refresh status")
			.setDisabled(this.busy)
			.onClick(() => {
				void this.refresh();
			});

		this.renderConnection(root);
		this.renderNote(root);
		this.renderActivity(root);
	}

	private renderConnection(root: HTMLElement): void {
		const connected = this.plugin.hasValidNotionCredentials();
		const conn = root.createDiv({ cls: "nob-conn" });
		conn.createSpan({
			cls: `nob-dot ${connected ? "nob-ok" : "nob-bad"}`,
		});

		if (connected) {
			conn.createSpan({
				text: `Connected · DB ${shortenId(
					this.plugin.settings.databaseID
				)}`,
			});
			return;
		}

		conn.createSpan({ text: "Not configured" });
		root.createEl("p", {
			text: "Open Settings → Notional and add your Notion token and database to start syncing.",
			cls: "nob-muted",
		});
	}

	private renderNote(root: HTMLElement): void {
		const section = root.createDiv({ cls: "nob-section" });
		const file = this.currentFile;

		if (!file) {
			section.createEl("p", {
				text: "Open a markdown note to sync it.",
				cls: "nob-muted",
			});
			return;
		}

		section.createEl("div", { text: file.basename, cls: "nob-note-name" });

		if (file.extension !== "md") {
			section.createEl("div", {
				text: "Not a markdown note.",
				cls: "nob-muted",
			});
			return;
		}

		if (!this.plugin.hasValidNotionCredentials()) return;

		this.renderStatusMeta(section);
		this.renderConflict(section);
		this.renderActions(section);
	}

	private renderStatusMeta(section: HTMLElement): void {
		const status = this.status;
		const meta = section.createDiv({ cls: "nob-meta" });

		if (!status) {
			meta.createEl("div", {
				text: "Status unavailable.",
				cls: "nob-muted",
			});
			return;
		}

		if (!status.linked) {
			meta.createEl("div", {
				text: "Not yet linked to Notion. Push to create a page.",
				cls: "nob-muted",
			});
			return;
		}

		if (status.notionPageUrl) {
			const link = meta.createEl("a", {
				text: "Open in Notion ↗",
				href: status.notionPageUrl,
				cls: "nob-link-ext",
			});
			link.setAttr("target", "_blank");
			link.setAttr("rel", "noopener");
		}

		meta.createEl("div", {
			text: `Last synced: ${relativeTime(status.obsidianLastSyncedAt)}`,
			cls: "nob-muted",
		});

		const changes = meta.createDiv({ cls: "nob-changes" });
		changes.createSpan({
			text: `Local: ${status.hasLocalChanges ? "changed" : "clean"}`,
			cls: status.hasLocalChanges ? "nob-warn" : "nob-muted",
		});
		changes.createSpan({
			text: `Notion: ${status.hasRemoteChanges ? "changed" : "clean"}`,
			cls: status.hasRemoteChanges ? "nob-warn" : "nob-muted",
		});
	}

	private renderConflict(section: HTMLElement): void {
		if (!this.status?.conflict) return;

		const conflict = section.createDiv({ cls: "nob-conflict" });
		conflict.createEl("div", {
			text: "⚠ Conflict: both sides changed since the last sync. Choose which to keep.",
			cls: "nob-warn",
		});

		const buttons = conflict.createDiv({ cls: "nob-actions" });
		new ButtonComponent(buttons)
			.setButtonText("Keep local → Notion")
			.setDisabled(this.busy)
			.onClick(() =>
				this.runAction("Resolved (kept local)", (file) =>
					uploadFile(this.plugin, file)
				)
			);
		new ButtonComponent(buttons)
			.setButtonText("Keep Notion → local")
			.setWarning()
			.setDisabled(this.busy)
			.onClick(() =>
				this.runAction("Resolved (kept Notion)", (file) =>
					pullFileFromNotion(this.plugin, file, { force: true })
				)
			);
	}

	private renderActions(section: HTMLElement): void {
		const actions = section.createDiv({ cls: "nob-actions" });

		new ButtonComponent(actions)
			.setButtonText(this.busy ? "Working…" : "Sync")
			.setCta()
			.setDisabled(this.busy)
			.onClick(() =>
				this.runAction("Synced", (file) => syncFile(this.plugin, file))
			);
		new ButtonComponent(actions)
			.setButtonText("Push")
			.setTooltip("Overwrite the Notion page with this note")
			.setDisabled(this.busy)
			.onClick(() =>
				this.runAction("Pushed", (file) =>
					uploadFile(this.plugin, file)
				)
			);
		new ButtonComponent(actions)
			.setButtonText("Pull")
			.setTooltip("Update this note from Notion (stops on conflict)")
			.setDisabled(this.busy)
			.onClick(() =>
				this.runAction("Pulled", (file) =>
					pullFileFromNotion(this.plugin, file)
				)
			);
	}

	private renderActivity(root: HTMLElement): void {
		const section = root.createDiv({ cls: "nob-section nob-activity" });
		section.createEl("h5", { text: "Activity" });

		if (this.activity.length === 0) {
			section.createEl("div", {
				text: "No sync activity yet.",
				cls: "nob-muted",
			});
			return;
		}

		const list = section.createEl("ul", { cls: "nob-log" });
		for (const entry of this.activity) {
			const item = list.createEl("li");
			item.createSpan({
				text: entry.ok ? "✓" : "✗",
				cls: entry.ok ? "nob-ok-text" : "nob-bad-text",
			});
			item.createSpan({
				text: ` ${clockTime(entry.time)} `,
				cls: "nob-muted",
			});
			item.createSpan({ text: entry.message });
		}
	}
}
