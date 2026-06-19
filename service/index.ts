import { TFile } from "obsidian";
import NObsidian from "main";
import { MarkdownWithFrontMatter, ServiceResult, SyncStatus } from "./types";
import notion from "./notion";
import {
	updateNotionPageUrlWithWorkspaceId,
	fromYamlFrontMatterToMarkdown,
	createNotionPageMentionUrl,
	getWikiLinksFromMarkdown,
	replaceWikiWithHyperLink,
} from "./utils";

export const uploadFile = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult> => {
	const contentWithFrontMatter = await initializeNotionPage(plugin, file);

	const content = await convertObsidianLinks(
		plugin,
		contentWithFrontMatter.__content
	);

	if (contentWithFrontMatter.notionPageId) {
		const uploadResult = await notion.uploadFileContent(
			plugin.settings,
			contentWithFrontMatter.notionPageId,
			content
		);

		if (!uploadResult.error) {
			const pageResult = await notion.retrievePage(
				plugin.settings,
				contentWithFrontMatter.notionPageId
			);
			if (pageResult.error) return pageResult;

			await updateSyncMetadata(
				plugin,
				file,
				contentWithFrontMatter,
				pageResult.data
			);
		}

		return uploadResult;
	}

	return { data: null, error: Error("Something happened") };
};

const inFlightPageInitializations = new WeakMap<
	NObsidian,
	Map<string, Promise<MarkdownWithFrontMatter>>
>();

export const initializeNotionPage = async (
	plugin: NObsidian,
	file: TFile
): Promise<MarkdownWithFrontMatter> => {
	let pluginInitializations = inFlightPageInitializations.get(plugin);
	if (!pluginInitializations) {
		pluginInitializations = new Map();
		inFlightPageInitializations.set(plugin, pluginInitializations);
	}

	const existingInitialization = pluginInitializations.get(file.basename);
	if (existingInitialization) return existingInitialization;

	const initialization = initializeNotionPageContent(plugin, file).finally(
		() => {
			pluginInitializations.delete(file.basename);
		}
	);
	pluginInitializations.set(file.basename, initialization);

	return initialization;
};

const initializeNotionPageContent = async (
	plugin: NObsidian,
	file: TFile
): Promise<MarkdownWithFrontMatter> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const settings = plugin.settings;
	const notionWorkspaceID = settings.notionWorkspaceID;

	if (!contentWithFrontMatter.notionPageId) {
		const { data } = await notion.createEmptyPage(
			settings,
			file.basename
		);
		const { url: rawNotionPageUrl, id: notionPageId } = data;

		const notionPageUrl = updateNotionPageUrlWithWorkspaceId(
			rawNotionPageUrl,
			notionWorkspaceID
		);

		contentWithFrontMatter.notionPageId = notionPageId;
		contentWithFrontMatter.notionPageUrl = notionPageUrl;
		contentWithFrontMatter.notionLastEditedTime = data.last_edited_time;
		contentWithFrontMatter.obsidianLastSyncedAt =
			new Date().toISOString();

		const processedMarkdown = fromYamlFrontMatterToMarkdown(
			contentWithFrontMatter
		);

		plugin.updateMarkdownFile(file, processedMarkdown);
	}

	return contentWithFrontMatter;
};

const updateSyncMetadata = async (
	plugin: NObsidian,
	file: TFile,
	contentWithFrontMatter: MarkdownWithFrontMatter,
	notionPage: any,
	content = contentWithFrontMatter.__content
) => {
	const processedMarkdown = fromYamlFrontMatterToMarkdown({
		...contentWithFrontMatter,
		__content: content,
		notionPageUrl:
			notionPage.url || contentWithFrontMatter.notionPageUrl,
		notionLastEditedTime:
			notionPage.last_edited_time ||
			contentWithFrontMatter.notionLastEditedTime,
		obsidianLastSyncedAt: new Date().toISOString(),
	});

	await plugin.updateMarkdownFile(file, processedMarkdown);
};

const isAfter = (current?: string, previous?: string): boolean => {
	if (!current || !previous) return Boolean(current);
	return Date.parse(current) > Date.parse(previous);
};

const hasLocalChangesSinceLastSync = (
	file: TFile,
	contentWithFrontMatter: MarkdownWithFrontMatter
): boolean => {
	const lastSyncedAt = contentWithFrontMatter.obsidianLastSyncedAt;
	if (!lastSyncedAt || !file.stat?.mtime) return false;

	return file.stat.mtime > Date.parse(lastSyncedAt) + 1000;
};

const hasNotionChangesSinceLastSync = (
	contentWithFrontMatter: MarkdownWithFrontMatter,
	notionPage: any
): boolean => {
	return isAfter(
		notionPage.last_edited_time,
		contentWithFrontMatter.notionLastEditedTime
	);
};

/**
 * Inspect the sync state of a note without mutating anything.
 *
 * Local-change detection is cheap (file mtime vs. recorded sync time), but
 * remote-change detection needs a Notion round-trip, so this issues one
 * retrievePage call when the note is linked. The GUI uses this to render
 * status and to decide whether a conflict needs user resolution.
 */
export const getSyncStatus = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const notionPageId = contentWithFrontMatter.notionPageId;

	if (!notionPageId) {
		const status: SyncStatus = {
			linked: false,
			hasLocalChanges: false,
			hasRemoteChanges: false,
			conflict: false,
		};
		return { data: status, error: null };
	}

	const pageResult = await notion.retrievePage(plugin.settings, notionPageId);
	if (pageResult.error) return pageResult;

	const hasRemoteChanges = hasNotionChangesSinceLastSync(
		contentWithFrontMatter,
		pageResult.data
	);
	const hasLocalChanges = hasLocalChangesSinceLastSync(
		file,
		contentWithFrontMatter
	);

	const status: SyncStatus = {
		linked: true,
		notionPageId,
		notionPageUrl: contentWithFrontMatter.notionPageUrl,
		obsidianLastSyncedAt: contentWithFrontMatter.obsidianLastSyncedAt,
		notionLastEditedTime: pageResult.data.last_edited_time,
		hasLocalChanges,
		hasRemoteChanges,
		conflict: hasLocalChanges && hasRemoteChanges,
	};

	return { data: status, error: null };
};

export const pullFileFromNotion = async (
	plugin: NObsidian,
	file: TFile,
	options: { force?: boolean } = {}
): Promise<ServiceResult> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const notionPageId = contentWithFrontMatter.notionPageId;

	if (!notionPageId) {
		return {
			data: null,
			error: Error("Missing notionPageId for "),
		};
	}

	const notionPageResult = await notion.retrievePageMarkdown(
		plugin.settings,
		notionPageId
	);
	if (notionPageResult.error) return notionPageResult;

	const { page, markdown } = notionPageResult.data;
	const hasRemoteChanges = hasNotionChangesSinceLastSync(
		contentWithFrontMatter,
		page
	);
	const hasLocalChanges = hasLocalChangesSinceLastSync(
		file,
		contentWithFrontMatter
	);

	if (!options.force && hasRemoteChanges && hasLocalChanges) {
		return {
			data: null,
			error: Error("Sync conflict: both Obsidian and Notion changed "),
		};
	}

	await updateSyncMetadata(
		plugin,
		file,
		contentWithFrontMatter,
		page,
		markdown
	);

	return { data: notionPageResult.data, error: null };
};

export const syncFile = async (
	plugin: NObsidian,
	file: TFile
): Promise<ServiceResult> => {
	const contentWithFrontMatter = await plugin.getContent(file);
	const notionPageId = contentWithFrontMatter.notionPageId;

	if (!notionPageId) return uploadFile(plugin, file);

	const pageResult = await notion.retrievePage(plugin.settings, notionPageId);
	if (pageResult.error) return pageResult;

	const hasRemoteChanges = hasNotionChangesSinceLastSync(
		contentWithFrontMatter,
		pageResult.data
	);
	const hasLocalChanges = hasLocalChangesSinceLastSync(
		file,
		contentWithFrontMatter
	);

	if (hasRemoteChanges && hasLocalChanges) {
		return {
			data: null,
			error: Error("Sync conflict: both Obsidian and Notion changed "),
		};
	}

	if (hasRemoteChanges) return pullFileFromNotion(plugin, file);

	return uploadFile(plugin, file);
};

export const runWithConcurrency = async <T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw Error("Concurrency must be a positive integer");
	}

	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	const runWorker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await worker(items[index], index);
		}
	};

	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => runWorker()
	);
	await Promise.all(workers);

	return results;
};

/**
 * Convert Obsidian wiki-link into a Notion page mention marker.
 *
 * The marker is emitted as a markdown link so Martian preserves it in rich text.
 * service/notion.ts converts that marker into a Notion page mention before
 * appending blocks.
 *
 * @param markdown Original markdown content of an Obsidian markdown file
 * @returns Same markdown content, with wiki-link turned into mention markers.
 */
export const convertObsidianLinks = async (
	plugin: NObsidian,
	markdown: string
): Promise<string> => {
	const links = getWikiLinksFromMarkdown(markdown);
	let updatedMarkdown = markdown;

	for (const link of links) {
		let file: TFile | undefined;

		if (plugin.fileNameToFile.has(link.pageName)) {
			file = plugin.fileNameToFile.get(link.pageName);
		}

		// if file doesn't exist, create it
		if (!file) file = await plugin.createEmptyMarkdownFile(link.pageName);
		if (!file) continue;

		// If file exists but doesn't have a corresponding notion page
		// create an empty notion page
		const contentWithFrontMatter = await initializeNotionPage(
			plugin,
			file
		);
		const notionPageId = contentWithFrontMatter.notionPageId;

		if (notionPageId)
			updatedMarkdown = replaceWikiWithHyperLink(
				updatedMarkdown,
				link.rawLink,
				link.displayName,
				createNotionPageMentionUrl(notionPageId)
			);
	}

	return updatedMarkdown;
};
