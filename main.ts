import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	requestUrl,
} from "obsidian";

/**
 * Rootr Sync — v1
 *
 * One-directional push of a configured vault folder (or tagged notes) into a
 * Rootr workspace. Nothing is ever read from or written to Obsidian other
 * than the files the user explicitly opts into. No telemetry of any kind.
 */

const DEFAULT_BASE_URL = "https://rootr.io/api/v1";
/** Where someone without an account goes. `from` marks the funnel — the plugin
 *  itself sends no telemetry, so the landing page is the only measurable point. */
const SETUP_URL = "https://rootr.io/obsidian?from=plugin";
const AUTO_SYNC_DEBOUNCE_MS = 4000;

interface FileSyncRecord {
	rootrNodeId: string;
	/** Hash of the local file content at our last successful push. */
	lastPushedHash: string;
	/**
	 * Hash of the *remote* document content right after our last successful
	 * push. Conflict detection compares this against the remote content we
	 * read immediately before writing: if it differs, something else changed
	 * the document in Rootr and we must not overwrite it.
	 *
	 * We deliberately do NOT rely on a cached ETag here: the ETag returned by
	 * `PUT /documents/:id` is computed before post-write bookkeeping lands, so
	 * it no longer matches the server a moment later. Caching it produced a
	 * bogus "conflict" on every second consecutive push.
	 */
	lastRemoteHash: string;
}

interface FailedFile {
	path: string;
	reason: string;
}

interface LastSyncSummary {
	timestamp: string | null;
	successCount: number;
	failed: FailedFile[];
}

interface RootrSyncSettings {
	baseUrl: string;
	apiKey: string;
	workspaceId: string;
	syncFolder: string;
	syncTag: string;
	autoSyncOnSave: boolean;
	fileMap: Record<string, FileSyncRecord>;
	lastSync: LastSyncSummary;
}

const DEFAULT_SETTINGS: RootrSyncSettings = {
	baseUrl: DEFAULT_BASE_URL,
	apiKey: "",
	workspaceId: "",
	syncFolder: "",
	syncTag: "",
	autoSyncOnSave: false,
	fileMap: {},
	lastSync: {
		timestamp: null,
		successCount: 0,
		failed: [],
	},
};

/** Small non-cryptographic hash used only to decide whether a file's content
 * changed since our last push. Not used for security purposes. */
function hashContent(content: string): string {
	let hash = 5381;
	for (let i = 0; i < content.length; i++) {
		hash = (hash * 33) ^ content.charCodeAt(i);
	}
	return (hash >>> 0).toString(16);
}

/** Normalizes a vault-relative path (e.g. "Team/Notes/idea.md") into the
 * Rootr document path (e.g. "/Team/Notes/idea.md"), preserving folder
 * structure 1:1. */
function toRootrPath(vaultPath: string): string {
	return "/" + vaultPath.replace(/^\/+/, "");
}

interface RootrNode {
	id: string;
	path: string;
	[key: string]: unknown;
}

interface RootrDocument {
	id: string;
	path: string;
	content: string;
	etag: string;
	updatedAt: string;
}

class RootrConflictError extends Error {
	constructor(public path: string, detail?: string) {
		super(detail ?? "changed in Rootr since the last push");
	}
}

class RootrApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

/**
 * Turns an API failure into something a human can act on. Rootr returns
 * `{ code, message }`, and that message ("Invalid API key", "API key does not
 * belong to this workspace") is far more useful than a bare status number.
 */
function describeFailure(action: string, status: number, body: unknown): string {
	let serverMessage = "";
	if (body && typeof body === "object") {
		const b = body as { message?: unknown; code?: unknown };
		if (typeof b.message === "string") serverMessage = b.message;
		else if (typeof b.code === "string") serverMessage = b.code;
	}
	const hint =
		status === 401
			? " — check the API key in plugin settings."
			: status === 403
				? " — check the workspace ID, and that the key has docs:read + docs:write scopes."
				: status === 404
					? " — check the Rootr base URL and workspace ID."
					: status === 429
						? " — rate limited by Rootr; try again shortly."
						: "";
	return `${action} failed (HTTP ${status})${serverMessage ? `: ${serverMessage}` : ""}${hint}`;
}

class RootrClient {
	constructor(
		private baseUrl: string,
		private apiKey: string,
		private workspaceId: string
	) {}

	private url(path: string): string {
		return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
	}

	private headers(extra?: Record<string, string>): Record<string, string> {
		return {
			"x-api-key": this.apiKey,
			"Content-Type": "application/json",
			...extra,
		};
	}

	/** Looks up an existing node by path. Returns null if not found (404). */
	async getNodeByPath(rootrPath: string): Promise<RootrNode | null> {
		const res = await requestUrl({
			url: this.url(
				`/workspaces/${encodeURIComponent(this.workspaceId)}/nodes/by-path?path=${encodeURIComponent(
					rootrPath
				)}`
			),
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status === 404) return null;
		if (res.status >= 200 && res.status < 300) {
			return res.json as RootrNode;
		}
		throw new RootrApiError(res.status, describeFailure(`Looking up ${rootrPath}`, res.status, res.json));
	}

	/** Creates a document (and any missing parent folders) at the given path. */
	async createDocument(rootrPath: string, content: string): Promise<RootrNode> {
		const res = await requestUrl({
			url: this.url(`/workspaces/${encodeURIComponent(this.workspaceId)}/nodes`),
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({
				type: "DOCUMENT",
				path: rootrPath,
				createParents: true,
				content,
			}),
			throw: false,
		});
		if (res.status >= 200 && res.status < 300) {
			return res.json as RootrNode;
		}
		throw new RootrApiError(res.status, describeFailure(`Creating ${rootrPath}`, res.status, res.json));
	}

	async getDocument(id: string): Promise<RootrDocument> {
		const res = await requestUrl({
			url: this.url(`/documents/${encodeURIComponent(id)}`),
			method: "GET",
			headers: this.headers(),
			throw: false,
		});
		if (res.status >= 200 && res.status < 300) {
			return res.json as RootrDocument;
		}
		throw new RootrApiError(res.status, describeFailure("Reading the document in Rootr", res.status, res.json));
	}

	/** Full replace with optimistic locking. Throws RootrConflictError on 412. */
	async putDocument(id: string, content: string, etag: string, path: string): Promise<{ etag: string }> {
		const res = await requestUrl({
			url: this.url(`/documents/${encodeURIComponent(id)}`),
			method: "PUT",
			headers: this.headers({ "If-Match": etag }),
			body: JSON.stringify({ content }),
			throw: false,
		});
		if (res.status === 412) {
			throw new RootrConflictError(path);
		}
		if (res.status >= 200 && res.status < 300) {
			const json = res.json as { etag?: string } | undefined;
			return { etag: (json && json.etag) || etag };
		}
		throw new RootrApiError(res.status, describeFailure(`Updating ${path}`, res.status, res.json));
	}
}

export default class RootrSyncPlugin extends Plugin {
	settings!: RootrSyncSettings;
	private pendingAutoSync: Map<string, number> = new Map();
	private settingsTab!: RootrSyncSettingTab;

	async onload() {
		await this.loadSettings();

		this.settingsTab = new RootrSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		this.addCommand({
			id: "rootr-push-selected-folder",
			name: "Push selected folder now",
			callback: () => {
				void this.pushConfiguredScope();
			},
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.settings.autoSyncOnSave) return;
				if (!(file instanceof TFile)) return;
				if (file.extension !== "md") return;
				if (!this.isFileInScope(file)) return;
				this.scheduleAutoSync(file);
			})
		);
	}

	onunload() {
		for (const timeoutId of this.pendingAutoSync.values()) {
			window.clearTimeout(timeoutId);
		}
		this.pendingAutoSync.clear();
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<RootrSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data, {
			fileMap: (data && data.fileMap) || {},
			lastSync: (data && data.lastSync) || { ...DEFAULT_SETTINGS.lastSync },
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.settingsTab?.refreshStatus();
	}

	private getClient(): RootrClient {
		return new RootrClient(this.settings.baseUrl || DEFAULT_BASE_URL, this.settings.apiKey, this.settings.workspaceId);
	}

	private isFileInScope(file: TFile): boolean {
		const folder = this.settings.syncFolder.trim().replace(/^\/+|\/+$/g, "");
		const tag = this.settings.syncTag.trim();

		let inFolder = false;
		if (folder) {
			inFolder = file.path === folder || file.path.startsWith(folder + "/");
		}

		let hasTag = false;
		if (tag) {
			const normalizedTag = tag.startsWith("#") ? tag.slice(1) : tag;
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = cache?.tags?.map((t) => t.tag.replace(/^#/, "")) ?? [];
			const frontmatterTags = (cache?.frontmatter?.tags as string[] | string | undefined) ?? [];
			const fmTags = Array.isArray(frontmatterTags) ? frontmatterTags : [frontmatterTags];
			hasTag = tags.includes(normalizedTag) || fmTags.includes(normalizedTag);
		}

		if (folder && tag) return inFolder || hasTag;
		if (folder) return inFolder;
		if (tag) return hasTag;
		return false;
	}

	private collectScopedFiles(): TFile[] {
		const folder = this.settings.syncFolder.trim().replace(/^\/+|\/+$/g, "");
		const tag = this.settings.syncTag.trim();
		const all = this.app.vault.getMarkdownFiles();

		if (!folder && !tag) return [];

		return all.filter((f) => this.isFileInScope(f));
	}

	private scheduleAutoSync(file: TFile) {
		const existing = this.pendingAutoSync.get(file.path);
		if (existing) window.clearTimeout(existing);
		const timeoutId = window.setTimeout(() => {
			this.pendingAutoSync.delete(file.path);
			void this.pushFiles([file], { isAuto: true });
		}, AUTO_SYNC_DEBOUNCE_MS);
		this.pendingAutoSync.set(file.path, timeoutId);
	}

	async pushConfiguredScope() {
		if (!this.settings.apiKey || !this.settings.workspaceId) {
			new Notice("Rootr Sync: set an API key and workspace ID in plugin settings first.");
			return;
		}
		const files = this.collectScopedFiles();
		if (files.length === 0) {
			new Notice("Rootr Sync: no files match the configured folder/tag.");
			return;
		}
		await this.pushFiles(files, { isAuto: false });
	}

	private async pushFiles(files: TFile[], opts: { isAuto: boolean }) {
		const client = this.getClient();
		// Failures from earlier runs are carried over on an auto-sync (which only
		// touches one file, so it can't speak for the rest of the scope) but the
		// counters below always describe *this* run.
		const failed: FailedFile[] = opts.isAuto ? [...this.settings.lastSync.failed] : [];
		const failedNow: FailedFile[] = [];
		let successCount = 0;

		for (const file of files) {
			// Clear any prior failure entry for this file before re-attempting.
			const failIdx = failed.findIndex((f) => f.path === file.path);
			if (failIdx >= 0) failed.splice(failIdx, 1);

			try {
				const pushed = await this.pushSingleFile(client, file);
				if (pushed) successCount++;
			} catch (err) {
				let reason: string;
				if (err instanceof RootrConflictError) {
					reason = `conflict — ${err.message}`;
				} else if (err instanceof RootrApiError) {
					reason = err.message;
				} else {
					reason = err instanceof Error ? err.message : String(err);
				}
				failedNow.push({ path: file.path, reason });
			}
		}

		failed.push(...failedNow);
		this.settings.lastSync = {
			timestamp: new Date().toISOString(),
			successCount,
			failed,
		};
		await this.saveSettings();

		if (opts.isAuto) {
			// Auto-sync stays quiet unless something needs attention.
			if (failedNow.length > 0) {
				new Notice(
					`Rootr Sync: auto-sync failed for ${failedNow.map((f) => f.path).join(", ")}. See plugin settings.`
				);
			}
		} else if (failedNow.length > 0) {
			new Notice(
				`Rootr Sync: pushed ${successCount}/${files.length} file(s). ${failedNow.length} conflict/error — see plugin settings.`
			);
		} else {
			new Notice(`Rootr Sync: pushed ${successCount} file(s) successfully.`);
		}
	}

	/** Pushes a single file, returns true on success, throws on failure. */
	private async pushSingleFile(client: RootrClient, file: TFile): Promise<boolean> {
		const content = await this.app.vault.read(file);
		const hash = hashContent(content);
		const rootrPath = toRootrPath(file.path);
		const record = this.settings.fileMap[file.path];

		if (record && record.lastPushedHash === hash) {
			// Nothing changed since our last successful push; skip the round trip.
			return true;
		}

		// Resolve the target node: the one we pushed to last time, or whatever
		// already lives at that path, or a new one.
		let nodeId = record?.rootrNodeId;
		if (!nodeId) {
			const existing = await client.getNodeByPath(rootrPath);
			if (!existing) {
				const created = await client.createDocument(rootrPath, content);
				await this.rememberPush(client, file.path, created.id, hash);
				return true;
			}
			nodeId = existing.id;
		}

		// Always read the current remote state immediately before writing. This
		// gives us (a) a fresh ETag — the one echoed by PUT goes stale the moment
		// it is issued — and (b) the remote content, which is what conflict
		// detection is actually based on.
		let doc: RootrDocument;
		try {
			doc = await client.getDocument(nodeId);
		} catch (err) {
			// The node we remembered is gone (deleted in Rootr). Fall back to a
			// path lookup / re-create rather than failing forever.
			if (err instanceof RootrApiError && (err.status === 404 || err.status === 403)) {
				delete this.settings.fileMap[file.path];
				const existing = await client.getNodeByPath(rootrPath);
				if (!existing) {
					const created = await client.createDocument(rootrPath, content);
					await this.rememberPush(client, file.path, created.id, hash);
					return true;
				}
				nodeId = existing.id;
				doc = await client.getDocument(nodeId);
			} else {
				throw err;
			}
		}

		const remoteHash = hashContent(doc.content ?? "");
		if (record) {
			// We have pushed this file before. Only flag a conflict when we know
			// what we left behind and the remote no longer matches it.
			if (record.lastRemoteHash && remoteHash !== record.lastRemoteHash) {
				throw new RootrConflictError(file.path, "changed in Rootr since the last push");
			}
		} else if (remoteHash !== hash) {
			// We have never pushed this file, yet a *different* document already
			// occupies that path in Rootr. Refuse rather than clobber it.
			throw new RootrConflictError(
				file.path,
				"a different document already exists at this path in Rootr — rename or remove it there first"
			);
		}

		await client.putDocument(nodeId, content, doc.etag, file.path);
		await this.rememberPush(client, file.path, nodeId, hash);
		return true;
	}

	/**
	 * Records what we just wrote. The remote hash is read back from Rootr rather
	 * than assumed to equal the local content, because Rootr normalizes markdown
	 * on write; assuming equality would make the next push look like a conflict.
	 */
	private async rememberPush(
		client: RootrClient,
		vaultPath: string,
		nodeId: string,
		localHash: string
	): Promise<void> {
		let remoteHash = "";
		try {
			const doc = await client.getDocument(nodeId);
			remoteHash = hashContent(doc.content ?? "");
		} catch {
			// Non-fatal: without a remote hash the next push re-reads and, finding
			// no baseline, falls back to the "path already occupied" check.
		}
		this.settings.fileMap[vaultPath] = {
			rootrNodeId: nodeId,
			lastPushedHash: localHash,
			lastRemoteHash: remoteHash,
		};
	}
}

class RootrSyncSettingTab extends PluginSettingTab {
	plugin: RootrSyncPlugin;
	private statusEl!: HTMLElement;

	constructor(app: App, plugin: RootrSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text:
				"Pushes a folder (or tagged notes) from this vault to a Rootr workspace. " +
				"Nothing is read or sent unless it's inside the folder/tag you configure below, " +
				"and only when you run the push command or (if enabled) save a matching file.",
		});

		// The two fields below are meaningless without a Rootr account, and until
		// now this screen gave no way to get one — people installed the plugin and
		// had nowhere to go. This is that link.
		new Setting(containerEl)
			.setName("Don't have a Rootr workspace yet?")
			.setDesc(
				"You need a workspace to push into. Creating one is free for up to 3 people and takes about a minute — the page below also shows where to copy the two values this screen asks for."
			)
			.addButton((button) =>
				button.setButtonText("Create one free").setCta().onClick(() => {
					window.open(SETUP_URL, "_blank");
				})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("A workspace-scoped Rootr API key with docs:read + docs:write scopes (Settings → Integrations in Rootr).")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("rootr_...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Workspace ID")
			.setDesc("The Rootr workspace to push into.")
			.addText((text) =>
				text
					.setPlaceholder("workspace id")
					.setValue(this.plugin.settings.workspaceId)
					.onChange(async (value) => {
						this.plugin.settings.workspaceId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// Without this, the first sign that a key or id is wrong is a failed push.
		new Setting(containerEl)
			.setName("Check connection")
			.setDesc("Confirms the key and workspace ID above actually work, before you push anything.")
			.addButton((button) =>
				button.setButtonText("Check connection").onClick(async () => {
					button.setDisabled(true);
					try {
						await this.checkConnection();
					} finally {
						button.setDisabled(false);
					}
				})
			);

		new Setting(containerEl)
			.setName("Folder to sync")
			.setDesc("Vault-relative folder path, e.g. \"Team/Project\". Leave blank to select by tag only.")
			.addText((text) =>
				text
					.setPlaceholder("Team/Project")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Tag to sync")
			.setDesc("Notes with this tag (anywhere in the vault) are also included, e.g. \"#rootr\".")
			.addText((text) =>
				text
					.setPlaceholder("#rootr")
					.setValue(this.plugin.settings.syncTag)
					.onChange(async (value) => {
						this.plugin.settings.syncTag = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync on save")
			.setDesc(
				"When enabled, saving a file inside the configured folder/tag automatically pushes just that file a few seconds later. Off by default — nothing syncs in the background otherwise."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncOnSave).onChange(async (value) => {
					this.plugin.settings.autoSyncOnSave = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Push now")
			.setDesc("Manually push the configured folder/tag to Rootr right now.")
			.addButton((button) =>
				button
					.setButtonText("Push selected folder now")
					.setCta()
					.onClick(() => {
						void this.plugin.pushConfiguredScope();
					})
			);

		new Setting(containerEl).setName("Status").setHeading();
		this.statusEl = containerEl.createDiv({ cls: "rootr-sync-status" });
		this.renderStatus();

		// Nobody needs this on first run — it has a working default. It used to be
		// the very first field on the screen, which made the plugin read as
		// developer-only to anyone who had just installed it.
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Rootr base URL")
			.setDesc(
				`Leave this alone unless you run Rootr on your own server. Default: ${DEFAULT_BASE_URL}`
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_BASE_URL)
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim() || DEFAULT_BASE_URL;
						await this.plugin.saveSettings();
					})
			);
	}

	/**
	 * Validates the key/workspace pair by reading the workspace itself, and
	 * reports back by name so the user can see they picked the right one.
	 * There is no endpoint that lists workspaces for an API key, so this
	 * confirms a pair rather than offering a picker.
	 */
	private async checkConnection(): Promise<void> {
		const { baseUrl, apiKey, workspaceId } = this.plugin.settings;
		if (!apiKey || !workspaceId) {
			new Notice("Rootr Sync: fill in the API key and workspace ID first.");
			return;
		}
		new Notice("Rootr Sync: checking…");
		try {
			const res = await requestUrl({
				url: `${baseUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}`,
				method: "GET",
				headers: { "x-api-key": apiKey },
				throw: false,
			});
			if (res.status >= 200 && res.status < 300) {
				const name = (res.json as { name?: string } | null)?.name;
				new Notice(
					name
						? `Rootr Sync: connected to "${name}".`
						: "Rootr Sync: connected."
				);
				return;
			}
			if (res.status === 401 || res.status === 403) {
				new Notice(
					"Rootr Sync: the API key was rejected for that workspace. Check that the key belongs to this workspace and has document read and write access."
				);
				return;
			}
			if (res.status === 404) {
				new Notice("Rootr Sync: no workspace with that ID. Check the workspace ID.");
				return;
			}
			new Notice(`Rootr Sync: connection check failed (HTTP ${res.status}).`);
		} catch (err) {
			new Notice(
				`Rootr Sync: could not reach Rootr — ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	refreshStatus() {
		if (this.statusEl) this.renderStatus();
	}

	private renderStatus() {
		this.statusEl.empty();
		const { lastSync } = this.plugin.settings;

		const lastSyncText = lastSync.timestamp
			? new Date(lastSync.timestamp).toLocaleString()
			: "never";
		this.statusEl.createEl("p", { text: `Last sync: ${lastSyncText}` });
		this.statusEl.createEl("p", { text: `Files pushed in that sync: ${lastSync.successCount}` });

		if (lastSync.failed.length > 0) {
			this.statusEl.createEl("p", {
				text: `Failed / conflicted (${lastSync.failed.length}):`,
			});
			const list = this.statusEl.createEl("ul");
			for (const f of lastSync.failed) {
				list.createEl("li", { text: `${f.path} — ${f.reason}` });
			}
		} else {
			this.statusEl.createEl("p", { text: "No conflicts or failures." });
		}
	}
}
