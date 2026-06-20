jest.mock("obsidian");
jest.mock("../service/notion");

import {
	convertObsidianLinks,
	getSyncStatus,
	initializeNotionPage,
	pullFileFromNotion,
	runWithConcurrency,
} from "../service/index";
import notion from "../service/notion";

import NObsidian from "main";
import { TFile, App, PluginManifest } from "obsidian";

describe("initializeNotionPage", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Some note";
	});

	it("does not create a Notion page when the note already has a notionPageId", async () => {
		// The default getContent mock returns a note that already has
		// notionPageId "12345", so no new page should be created.
		const result = await initializeNotionPage(pluginMock, fileMock);

		expect(pluginMock.getContent).toHaveBeenCalledWith(fileMock);
		expect(notion.createEmptyPage).not.toHaveBeenCalled();
		expect(result.notionPageId).toBe("12345");
	});

	it("creates a Notion page and writes back front matter when notionPageId is missing", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Body without front matter.",
		});
		(notion.createEmptyPage as jest.Mock).mockResolvedValueOnce({
			data: {
				id: "new-page-id",
				url: "https://www.notion.so/new-page-id",
			},
			error: null,
		});

		const result = await initializeNotionPage(pluginMock, fileMock);

		expect(notion.createEmptyPage).toHaveBeenCalledWith(
			pluginMock.settings,
			fileMock.basename
		);
		expect(result.notionPageId).toBe("new-page-id");
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalled();
	});

	it("shares in-flight initialization for the same file", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValue({
			__content: "Body without front matter.",
		});
		(notion.createEmptyPage as jest.Mock).mockResolvedValue({
			data: {
				id: "shared-page-id",
				url: "https://www.notion.so/shared-page-id",
			},
			error: null,
		});

		const results = await Promise.all([
			initializeNotionPage(pluginMock, fileMock),
			initializeNotionPage(pluginMock, fileMock),
		]);

		expect(pluginMock.getContent).toHaveBeenCalledTimes(1);
		expect(notion.createEmptyPage).toHaveBeenCalledTimes(1);
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledTimes(1);
		expect(results[0].notionPageId).toBe("shared-page-id");
		expect(results[1].notionPageId).toBe("shared-page-id");
	});
});

describe("runWithConcurrency", () => {
	it("caps active workers and preserves result order", async () => {
		let activeWorkers = 0;
		let maxActiveWorkers = 0;

		const results = await runWithConcurrency(
			[1, 2, 3, 4, 5],
			2,
			async (item) => {
				activeWorkers += 1;
				maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
				await Promise.resolve();
				activeWorkers -= 1;
				return item * 2;
			}
		);

		expect(maxActiveWorkers).toBeLessThanOrEqual(2);
		expect(results).toEqual([2, 4, 6, 8, 10]);
	});

	it("rejects invalid concurrency values", async () => {
		await expect(
			runWithConcurrency([1], 0, async (item) => item)
		).rejects.toThrow("Concurrency must be a positive integer");
	});
});

describe("convertObsidianLinks", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Linked note";
		pluginMock.fileNameToFile.set(fileMock.basename, fileMock);
	});

	it("converts wiki-links into Notion page mention markers", async () => {
		const result = await convertObsidianLinks(
			pluginMock,
			"See [[Linked note|the linked note]]."
		);

		expect(result).toBe(
			"See [the linked note](notional://notion-page/12345)."
		);
		expect(pluginMock.createEmptyMarkdownFile).not.toHaveBeenCalled();
	});
});

describe("pullFileFromNotion", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Synced note";
		fileMock.stat.mtime = Date.parse("2024-01-01T00:00:00.000Z");
	});

	it("updates the note body and sync metadata from Notion", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionPageUrl: "https://www.notion.so/page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					url: "https://www.notion.so/page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock);

		expect(result.error).toBeNull();
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledWith(
			fileMock,
			expect.stringContaining("Remote body")
		);
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledWith(
			fileMock,
			expect.stringContaining(
				"notionLastEditedTime: 2024-01-02T00:00:00.000Z"
			)
		);
	});

	it("preserves the note's own front matter when pulling", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
			customField: "keepme",
			aliases: ["one", "two"],
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock);

		expect(result.error).toBeNull();
		const written = (pluginMock.updateMarkdownFile as jest.Mock).mock
			.calls[0][1];
		expect(written).toContain("customField: keepme");
		expect(written).toContain("Remote body");
	});

	it("returns a conflict when Notion and Obsidian both changed", async () => {
		fileMock.stat.mtime = Date.parse("2024-01-03T00:00:00.000Z");
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock);

		expect(result.error?.message).toContain("Sync conflict");
		expect(pluginMock.updateMarkdownFile).not.toHaveBeenCalled();
	});

	it("overwrites local content when force-pulling through a conflict", async () => {
		fileMock.stat.mtime = Date.parse("2024-01-03T00:00:00.000Z");
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePageMarkdown as jest.Mock).mockResolvedValueOnce({
			data: {
				page: {
					id: "page-id",
					last_edited_time: "2024-01-02T00:00:00.000Z",
				},
				markdown: "Remote body",
			},
			error: null,
		});

		const result = await pullFileFromNotion(pluginMock, fileMock, {
			force: true,
		});

		expect(result.error).toBeNull();
		expect(pluginMock.updateMarkdownFile).toHaveBeenCalledWith(
			fileMock,
			expect.stringContaining("Remote body")
		);
	});
});

describe("getSyncStatus", () => {
	let pluginMock: NObsidian;
	let fileMock: TFile;

	beforeEach(() => {
		jest.clearAllMocks();
		pluginMock = new NObsidian(new App(), {} as PluginManifest);
		fileMock = new TFile();
		fileMock.basename = "Status note";
		fileMock.stat.mtime = Date.parse("2024-01-01T00:00:00.000Z");
	});

	it("reports an unlinked note without calling Notion", async () => {
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Body without front matter.",
		});

		const result = await getSyncStatus(pluginMock, fileMock);

		expect(result.error).toBeNull();
		expect(result.data.linked).toBe(false);
		expect(result.data.conflict).toBe(false);
		expect(notion.retrievePage).not.toHaveBeenCalled();
	});

	it("flags a conflict when both sides changed since the last sync", async () => {
		fileMock.stat.mtime = Date.parse("2024-01-03T00:00:00.000Z");
		(pluginMock.getContent as jest.Mock).mockResolvedValueOnce({
			__content: "Local body",
			notionPageId: "page-id",
			notionPageUrl: "https://www.notion.so/page-id",
			notionLastEditedTime: "2024-01-01T00:00:00.000Z",
			obsidianLastSyncedAt: "2024-01-01T00:00:00.000Z",
		});
		(notion.retrievePage as jest.Mock).mockResolvedValueOnce({
			data: {
				id: "page-id",
				last_edited_time: "2024-01-02T00:00:00.000Z",
			},
			error: null,
		});

		const result = await getSyncStatus(pluginMock, fileMock);

		expect(result.error).toBeNull();
		expect(result.data.linked).toBe(true);
		expect(result.data.hasLocalChanges).toBe(true);
		expect(result.data.hasRemoteChanges).toBe(true);
		expect(result.data.conflict).toBe(true);
	});
});
