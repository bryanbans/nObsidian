jest.mock("obsidian");
jest.mock("@tryfabric/martian", () => ({
	markdownToBlocks: jest.fn(),
}));

import { markdownToBlocks } from "@tryfabric/martian";
import { requestUrl } from "obsidian";
import notion from "../service/notion";
import { PluginSettings } from "../service/types";

const settings: PluginSettings = {
	notionAPIToken: "secret",
	databaseID: "database-id",
	bannerUrl: "",
	notionWorkspaceID: "",
	allowTags: false,
};

const paragraph = (content: string) => ({
	object: "block",
	type: "paragraph",
	paragraph: {
		rich_text: [{ text: { content } }],
	},
});

const bullet = (content: string, children: any[] = []) => ({
	object: "block",
	type: "bulleted_list_item",
	bulleted_list_item: {
		rich_text: [{ text: { content } }],
		children: children.length ? children : undefined,
	},
});

const getPatchBodies = () =>
	(requestUrl as jest.Mock).mock.calls
		.filter(([options]) => options.method === "PATCH")
		.map(([options]) => JSON.parse(options.body));

describe("notion.uploadFileContent", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(requestUrl as jest.Mock).mockImplementation((options) => {
			if (options.method === "GET") {
				return Promise.resolve({ json: { results: [] } });
			}

			const { children } = JSON.parse(options.body);
			return Promise.resolve({
				json: {
					results: children.map((_: unknown, index: number) => ({
						id: `${options.url}-block-${index}`,
					})),
				},
			});
		});
	});

	it("appends deeply nested blocks with recursive child requests", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue([
			bullet("Level 1", [
				bullet("Level 2", [
					bullet("Level 3", [paragraph("Level 4")]),
				]),
			]),
		]);

		const result = await notion.uploadFileContent(
			settings,
			"page-id",
			"nested markdown"
		);

		const patchBodies = getPatchBodies();

		expect(result.error).toBeNull();
		expect(patchBodies).toHaveLength(3);
		expect(
			patchBodies[0].children[0].bulleted_list_item.children
		).toBeUndefined();
		expect(
			patchBodies[1].children[0].bulleted_list_item.children
		).toBeUndefined();
		expect(
			patchBodies[2].children[0].bulleted_list_item.children
		).toHaveLength(1);
	});

	it("chunks append requests at Notion's 100 block limit", async () => {
		(markdownToBlocks as jest.Mock).mockReturnValue(
			Array.from({ length: 101 }, (_, index) =>
				paragraph(`Paragraph ${index}`)
			)
		);

		const result = await notion.uploadFileContent(
			settings,
			"page-id",
			"large markdown"
		);

		const patchBodies = getPatchBodies();

		expect(result.error).toBeNull();
		expect(patchBodies).toHaveLength(2);
		expect(patchBodies[0].children).toHaveLength(100);
		expect(patchBodies[1].children).toHaveLength(1);
	});
});
