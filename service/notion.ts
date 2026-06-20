/*
    Originally created by EasyChris (2022) as Upload2Notion.ts
    Renamed and modified by Quan Phan (2023)

    This file is part of Notional and is licensed under the GNU General Public License v3.0.
    Modifications by the Notional maintainers are tracked in the project's Git history.

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

import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";
import { markdownToBlocks } from "@tryfabric/martian";
import { PluginSettings, ServiceResult } from "./types";
import { getNotionPageMentionId } from "./utils";

// Notion requires every request to pin an API version. Keep this current with
// the latest stable release: https://developers.notion.com/reference/versioning
const NOTION_VERSION = "2022-06-28";
const MAX_BLOCKS_PER_APPEND = 100;

type NotionBlock = {
	id?: string;
	type?: string;
	has_children?: boolean;
	[key: string]: any;
};

type NotionPage = {
	id: string;
	url?: string;
	last_edited_time?: string;
	[key: string]: any;
};

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// Wrap requestUrl with retry/backoff for rate limits (429) and transient 5xx
// errors, then throw on any remaining failure so existing try/catch handlers
// keep working. Honors a Retry-After header when present.
const notionRequest = async (
	options: RequestUrlParam
): Promise<RequestUrlResponse> => {
	for (let attempt = 0; ; attempt++) {
		const response = await requestUrl({ ...options, throw: false });
		if (response.status === undefined || response.status < 400) {
			return response;
		}

		const retryable = RETRYABLE_STATUSES.has(response.status);
		if (!retryable || attempt >= MAX_RETRIES) {
			let detail = `status ${response.status}`;
			try {
				if (response.json?.message) detail = response.json.message;
			} catch {
				// non-JSON body; keep the status text
			}
			throw Error(`Notion API ${response.status}: ${detail}`);
		}

		const retryAfter = Number(
			response.headers?.["retry-after"] ??
				response.headers?.["Retry-After"]
		);
		const backoff =
			Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000
				: 2 ** attempt * 500;
		await sleep(backoff);
	}
};

const getBlockChildren = (block: NotionBlock): NotionBlock[] => {
	if (Array.isArray(block.children)) return block.children;
	if (!block.type) return [];

	const typedBlock = block[block.type];
	if (!typedBlock || !Array.isArray(typedBlock.children)) return [];

	return typedBlock.children;
};

const hasNestedChildren = (block: NotionBlock): boolean => {
	return getBlockChildren(block).some((child) => {
		const childChildren = getBlockChildren(child);
		return childChildren.length > 0 || hasNestedChildren(child);
	});
};

const removeBlockChildren = (block: NotionBlock): NotionBlock => {
	const blockWithoutChildren = { ...block };
	delete blockWithoutChildren.children;

	if (block.type && blockWithoutChildren[block.type]) {
		const typedBlock = { ...blockWithoutChildren[block.type] };
		delete typedBlock.children;
		blockWithoutChildren[block.type] = typedBlock;
	}

	return blockWithoutChildren;
};

const prepareBlockForAppend = (block: NotionBlock): NotionBlock => {
	return hasNestedChildren(block) ? removeBlockChildren(block) : block;
};

const chunkBlocks = (blocks: NotionBlock[]): NotionBlock[][] => {
	const chunks: NotionBlock[][] = [];
	for (let index = 0; index < blocks.length; index += MAX_BLOCKS_PER_APPEND) {
		chunks.push(blocks.slice(index, index + MAX_BLOCKS_PER_APPEND));
	}
	return chunks;
};

const appendBlockChildren = async (
	settings: PluginSettings,
	blockId: string,
	blocks: NotionBlock[]
) => {
	const notionAPIToken = settings.notionAPIToken;

	return notionRequest({
		url: `https://api.notion.com/v1/blocks/${blockId}/children`,
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${notionAPIToken}`,
			"Notion-Version": NOTION_VERSION,
		},
		body: JSON.stringify({ children: blocks }),
	});
};

const appendBlocksRecursively = async (
	settings: PluginSettings,
	parentBlockId: string,
	blocks: NotionBlock[]
) => {
	let lastResponse = null;

	for (const chunk of chunkBlocks(blocks)) {
		const appendableBlocks = chunk.map(prepareBlockForAppend);
		lastResponse = await appendBlockChildren(
			settings,
			parentBlockId,
			appendableBlocks
		);

		const createdBlocks = lastResponse.json?.results || [];
		for (const [index, originalBlock] of chunk.entries()) {
			if (!hasNestedChildren(originalBlock)) continue;

			const createdBlockId = createdBlocks[index]?.id;
			if (!createdBlockId) {
				throw Error("Notion did not return an ID for a created block");
			}

			await appendBlocksRecursively(
				settings,
				createdBlockId,
				getBlockChildren(originalBlock)
			);
		}
	}

	return lastResponse;
};

const getAuthHeaders = (settings: PluginSettings) => ({
	Authorization: `Bearer ${settings.notionAPIToken}`,
	"Notion-Version": NOTION_VERSION,
});

const getJsonHeaders = (settings: PluginSettings) => ({
	"Content-Type": "application/json",
	...getAuthHeaders(settings),
});

const convertPageMentionLinks = (value: any): any => {
	if (Array.isArray(value)) {
		return value.map(convertPageMentionLinks);
	}

	if (!value || typeof value !== "object") return value;

	const notionPageId = getNotionPageMentionId(value.text?.link?.url || "");
	if (value.type === "text" && notionPageId) {
		return {
			type: "mention",
			mention: {
				type: "page",
				page: {
					id: notionPageId,
				},
			},
			annotations: value.annotations,
		};
	}

	const convertedValue = { ...value };
	for (const key of Object.keys(convertedValue)) {
		convertedValue[key] = convertPageMentionLinks(convertedValue[key]);
	}

	return convertedValue;
};

const richTextToMarkdown = (richText: any[] = []): string => {
	return richText
		.map((text) => {
			const plainText = text.plain_text || text.text?.content || "";
			if (text.href) return `[${plainText}](${text.href})`;
			if (text.text?.link?.url) {
				return `[${plainText}](${text.text.link.url})`;
			}
			return plainText;
		})
		.join("");
};

const indentMarkdown = (markdown: string): string => {
	return markdown
		.split("\n")
		.map((line) => (line ? `\t${line}` : line))
		.join("\n");
};

// Block types that carry no standalone text (navigational markers) or are pure
// layout containers whose children are rendered anyway. These are skipped
// without a placeholder so pulled notes don't fill up with noise.
const IGNORED_BLOCK_TYPES = new Set([
	"table_of_contents",
	"breadcrumb",
	"child_page",
	"child_database",
	"link_to_page",
	"column_list",
	"column",
	"synced_block",
	"template",
	// Rendered by their parent "table" block, never standalone.
	"table_row",
]);

const mediaLinkToMarkdown = (block: NotionBlock, type: string): string => {
	const typed = block[type] || {};
	const url = typed.url || typed.external?.url || typed.file?.url || "";
	if (!url) return "";

	const label = richTextToMarkdown(typed.caption) || typed.name || type;
	return `[${label}](${url})`;
};

const tableToMarkdown = (block: NotionBlock): string => {
	const rows = getBlockChildren(block).filter(
		(child) => child.type === "table_row"
	);
	if (rows.length === 0) return "";

	const toCells = (row: NotionBlock): string[] =>
		(row.table_row?.cells || []).map((cell: any[]) =>
			richTextToMarkdown(cell).replace(/\|/g, "\\|").replace(/\n/g, " ").trim()
		);

	const renderRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
	const header = toCells(rows[0]);
	const separator = header.map(() => "---");
	const body = rows.slice(1).map(toCells);

	return [
		renderRow(header),
		renderRow(separator),
		...body.map(renderRow),
	].join("\n");
};

const calloutToMarkdown = (text: string, body: string, foldable = false): string => {
	const lines = [`> [!note]${foldable ? "-" : ""} ${text}`.trimEnd()];
	if (body) {
		for (const line of body.split("\n")) {
			lines.push(line ? `> ${line}` : ">");
		}
	}
	return lines.join("\n");
};

const blockToMarkdown = (block: NotionBlock): string => {
	const children = getBlockChildren(block)
		.map(blockToMarkdown)
		.filter(Boolean)
		.join("\n");
	const nestedMarkdown = children ? `\n${indentMarkdown(children)}` : "";

	switch (block.type) {
		case "paragraph":
			return `${richTextToMarkdown(block.paragraph?.rich_text)}${
				children ? `\n${children}` : ""
			}`.trim();
		case "heading_1":
			return `# ${richTextToMarkdown(block.heading_1?.rich_text)}`;
		case "heading_2":
			return `## ${richTextToMarkdown(block.heading_2?.rich_text)}`;
		case "heading_3":
			return `### ${richTextToMarkdown(block.heading_3?.rich_text)}`;
		case "bulleted_list_item":
			return `- ${richTextToMarkdown(
				block.bulleted_list_item?.rich_text
			)}${nestedMarkdown}`;
		case "numbered_list_item":
			return `1. ${richTextToMarkdown(
				block.numbered_list_item?.rich_text
			)}${nestedMarkdown}`;
		case "to_do":
			return `- [${block.to_do?.checked ? "x" : " "}] ${richTextToMarkdown(
				block.to_do?.rich_text
			)}${nestedMarkdown}`;
		case "quote":
			return `> ${richTextToMarkdown(block.quote?.rich_text)}${
				children ? `\n${children}` : ""
			}`;
		case "code":
			return `\`\`\`${block.code?.language || ""}\n${richTextToMarkdown(
				block.code?.rich_text
			)}\n\`\`\``;
		case "divider":
			return "---";
		case "image": {
			const image = block.image;
			const url = image?.external?.url || image?.file?.url || "";
			const caption = richTextToMarkdown(image?.caption);
			return url ? `![${caption}](${url})` : "";
		}
		case "callout":
			return calloutToMarkdown(
				richTextToMarkdown(block.callout?.rich_text),
				children
			);
		case "toggle":
			return calloutToMarkdown(
				richTextToMarkdown(block.toggle?.rich_text),
				children,
				true
			);
		case "equation":
			return block.equation?.expression
				? `$$${block.equation.expression}$$`
				: "";
		case "table":
			return tableToMarkdown(block);
		case "bookmark":
		case "embed":
		case "link_preview":
		case "video":
		case "file":
		case "pdf":
		case "audio":
			return mediaLinkToMarkdown(block, block.type);
		default: {
			// Unknown/unsupported type: never drop it silently. Preserve any
			// text, nested children, and media URL, and flag it so the user
			// knows the conversion was imperfect.
			const typed = block.type ? block[block.type] : undefined;
			const text = typed?.rich_text
				? richTextToMarkdown(typed.rich_text)
				: "";
			const body = [text, children].filter(Boolean).join("\n");

			if (block.type && IGNORED_BLOCK_TYPES.has(block.type)) {
				return body;
			}

			const label = (block.type || "unknown").replace(/_/g, " ");
			const url =
				typed?.external?.url || typed?.file?.url || typed?.url || "";
			const marker = `> [!missing] Unsupported Notion block (${label})${
				url ? `: ${url}` : ""
			}`;

			return body ? `${marker}\n${body}` : marker;
		}
	}
};

const LIST_ITEM_TYPES = new Set([
	"bulleted_list_item",
	"numbered_list_item",
	"to_do",
]);

const blocksToMarkdown = (blocks: NotionBlock[]): string => {
	const parts: string[] = [];
	let previousType: string | undefined;

	for (const block of blocks) {
		const markdown = blockToMarkdown(block);
		if (!markdown) continue;

		if (parts.length > 0) {
			// Keep consecutive list items tight; separate everything else with
			// a blank line.
			const tight =
				LIST_ITEM_TYPES.has(block.type || "") &&
				LIST_ITEM_TYPES.has(previousType || "");
			parts.push(tight ? "\n" : "\n\n");
		}

		parts.push(markdown);
		previousType = block.type;
	}

	return parts.join("");
};

const retrievePage = async (
	settings: PluginSettings,
	notionPageId: string
): Promise<ServiceResult> => {
	let res = null;

	try {
		res = await notionRequest({
			url: `https://api.notion.com/v1/pages/${notionPageId}`,
			method: "GET",
			headers: getAuthHeaders(settings),
		});

		return { data: res.json, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error retrieving Notion page: ${error}`),
		};
	}
};

const retrieveBlockChildren = async (
	settings: PluginSettings,
	blockId: string
): Promise<ServiceResult> => {
	let res = null;
	const blocks: NotionBlock[] = [];
	let startCursor: string | null = null;

	try {
		do {
			const cursorQuery = startCursor
				? `?start_cursor=${encodeURIComponent(startCursor)}`
				: "";
			res = await notionRequest({
				url: `https://api.notion.com/v1/blocks/${blockId}/children${cursorQuery}`,
				method: "GET",
				headers: getAuthHeaders(settings),
			});

			for (const block of res.json.results || []) {
				if (block.has_children) {
					const childrenResult = await retrieveBlockChildren(
						settings,
						block.id
					);
					if (childrenResult.error) return childrenResult;
					const typedBlock = block[block.type] || {};
					block[block.type] = {
						...typedBlock,
						children: childrenResult.data,
					};
				}
				blocks.push(block);
			}

			startCursor = res.json.has_more ? res.json.next_cursor : null;
		} while (startCursor);

		return { data: blocks, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error retrieving Notion block children: ${error}`),
		};
	}
};

const retrievePageMarkdown = async (
	settings: PluginSettings,
	notionPageId: string
): Promise<ServiceResult> => {
	const pageResult = await retrievePage(settings, notionPageId);
	if (pageResult.error) return pageResult;

	const childrenResult = await retrieveBlockChildren(settings, notionPageId);
	if (childrenResult.error) return childrenResult;

	return {
		data: {
			page: pageResult.data as NotionPage,
			markdown: blocksToMarkdown(childrenResult.data),
		},
		error: null,
	};
};

const validateToken = async (
	settings: PluginSettings
): Promise<ServiceResult> => {
	let res = null;

	try {
		res = await notionRequest({
			url: "https://api.notion.com/v1/users/me",
			method: "GET",
			headers: getAuthHeaders(settings),
		});

		return { data: res.json, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Could not reach Notion with this token: ${error}`),
		};
	}
};

const retrieveDatabase = async (
	settings: PluginSettings,
	databaseId: string
): Promise<ServiceResult> => {
	let res = null;

	try {
		res = await notionRequest({
			url: `https://api.notion.com/v1/databases/${databaseId}`,
			method: "GET",
			headers: getAuthHeaders(settings),
		});

		return { data: res.json, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Could not access this Notion database: ${error}`),
		};
	}
};

const createDatabase = async (
	settings: PluginSettings,
	parentPageId: string,
	title = "Obsidian Notes"
): Promise<ServiceResult> => {
	let res = null;

	const body = {
		parent: { type: "page_id", page_id: parentPageId },
		title: [{ type: "text", text: { content: title } }],
		properties: {
			// "Name" is the title column uploads write to; "Tags" backs the
			// optional Convert tags setting.
			Name: { title: {} },
			Tags: { multi_select: {} },
		},
	};

	try {
		res = await notionRequest({
			url: "https://api.notion.com/v1/databases",
			method: "POST",
			headers: getJsonHeaders(settings),
			body: JSON.stringify(body),
		});

		return { data: res.json, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error creating Notion database: ${error}`),
		};
	}
};

const createEmptyPage = async (
	settings: PluginSettings,
	title: string,
	tags: string[] = []
): Promise<ServiceResult> => {
	let res = null;

	const { databaseID, allowTags, bannerUrl } = settings;

	const bodyString: any = {
		parent: { database_id: databaseID },
		properties: {
			Name: {
				title: [{ text: { content: title } }],
			},
			Tags: {
				multi_select:
					allowTags && tags ? tags.map((tag) => ({ name: tag })) : [],
			},
		},
	};

	if (bannerUrl) {
		bodyString.cover = {
			type: "external",
			external: { url: bannerUrl },
		};
	}

	try {
		res = await notionRequest({
			url: `https://api.notion.com/v1/pages`,
			method: "POST",
			headers: {
				...getJsonHeaders(settings),
			},
			body: JSON.stringify(bodyString),
		});

		return { data: res.json, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error creating empty notion page ${error}`),
		};
	}
};

const addContentToPage = async (
	settings: PluginSettings,
	notionPageId: string,
	content: string
): Promise<ServiceResult> => {
	let res = null;

	const blocks = convertPageMentionLinks(markdownToBlocks(content));

	try {
		res = await appendBlocksRecursively(settings, notionPageId, blocks);
		return { data: res?.json || null, error: null };
	} catch (error) {
		return {
			data: res,
			error: Error(`Error adding content to Notion page: ${error}`),
		};
	}
};

const clearPageContent = async (
	settings: PluginSettings,
	notionPageId: string
): Promise<ServiceResult> => {
	try {
		// Retrieve the list of block children for the given page ID
		const listResponse = await notionRequest({
			url: `https://api.notion.com/v1/blocks/${notionPageId}/children`,
			method: "GET",
			headers: {
				...getAuthHeaders(settings),
			},
		});

		// Check if the response contains blocks and delete them if it does
		if (listResponse && listResponse.json && listResponse.json.results) {
			for (const block of listResponse.json.results) {
				// Each block has an ID, which you can use to delete it
				await notionRequest({
					url: `https://api.notion.com/v1/blocks/${block.id}`,
					method: "DELETE",
					headers: {
						...getAuthHeaders(settings),
					},
				});
			}
		}

		return {
			data: "Success! All content cleared from the Notion page.",
			error: null,
		};
	} catch (error) {
		return {
			data: null,
			error: Error(`Error clearing content from Notion page: ${error}`),
		};
	}
};

const uploadFileContent = async (
	settings: PluginSettings,
	notionPageId: string,
	content: string
): Promise<ServiceResult> => {
	const { error } = await clearPageContent(settings, notionPageId);
	if (error) {
		return { data: null, error };
	}

	const uploadResult = await addContentToPage(
		settings,
		notionPageId,
		content
	);

	return uploadResult;
};

const notion = {
	validateToken,
	retrieveDatabase,
	createDatabase,
	createEmptyPage,
	retrievePage,
	retrievePageMarkdown,
	uploadFileContent,
};

export default notion;
