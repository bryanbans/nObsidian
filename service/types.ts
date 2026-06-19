/*
    Created by Quan Phan (2023). Reused PluginSettings from EasyChris (2022).

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

export type PluginSettings = {
	notionAPIToken: string;
	databaseID: string;
	bannerUrl: string;
	notionWorkspaceID: string;
	allowTags: boolean;
	bidirectionalSync: boolean;
};

export type StringKeys<T> = Exclude<
	{ [K in keyof T]: T[K] extends string ? K : never }[keyof T],
	undefined
>;

export type BooleanKeys<T> = Exclude<
	{ [K in keyof T]: T[K] extends boolean ? K : never }[keyof T],
	undefined
>;

export type MarkdownWithFrontMatter = {
	readonly [key: string]: string | string[] | undefined;
	readonly __content: string;
	notionPageId?: string;
	notionPageUrl?: string;
	notionLastEditedTime?: string;
	obsidianLastSyncedAt?: string;
	tags?: string[];
};

export type ServiceResult = {
	data: any;
	error: Error | null;
};

export type SyncStatus = {
	// Whether the note is linked to a Notion page yet.
	linked: boolean;
	notionPageId?: string;
	notionPageUrl?: string;
	obsidianLastSyncedAt?: string;
	notionLastEditedTime?: string;
	// Local file changed since the last recorded sync.
	hasLocalChanges: boolean;
	// Notion page changed since the last recorded sync.
	hasRemoteChanges: boolean;
	// Both sides changed: a sync would overwrite one of them.
	conflict: boolean;
};

export type BulkUploadFileResult = {
	fileName: string;
	error: Error | null;
};
