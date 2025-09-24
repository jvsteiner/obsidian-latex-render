import {
	App,
	FileSystemAdapter,
	MarkdownPostProcessorContext,
	Plugin,
	PluginSettingTab,
	SectionCache,
	Setting,
	TFile,
	TFolder,
} from "obsidian";
import { Md5 } from "ts-md5";
import * as fs from "fs";
import * as temp from "temp";
import * as path from "path";
import { exec } from "child_process";

interface LatexRendererSettings {
	command: string;
	timeout: number;
	enableCache: boolean;
	cache: Array<[string, Set<string>]>;
	cacheFolder: string;
	additionalPackages: string;
	pngCopy: boolean;
	pngScale: string;
}

const DEFAULT_SETTINGS: LatexRendererSettings = {
	command: ``,
	timeout: 10000,
	enableCache: true,
	cache: [],
	cacheFolder: "svg-cache",
	additionalPackages: "",
	pngCopy: false,
	pngScale: "1",
};

export default class LatexRenderer extends Plugin {
	settings: LatexRendererSettings;
	cacheFolderPath: string;

	cache: Map<string, Set<string>>; // Key: md5 hash of latex source. Value: Set of file path names.

	async onload() {
		await this.loadSettings();
		// console.log("Loaded settings", this.settings);
		if (this.settings.enableCache) await this.loadCache();
		this.addSettingTab(new LatexRendererSettingTab(this.app, this));
		this.registerMarkdownCodeBlockProcessor("latex", (source, el, ctx) =>
			this.renderLatexToElement(source, el, ctx)
		);
	}

	onunload() {
		// if (this.settings.enableCache) this.unloadCache();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async loadCache() {
		// console.log("Loading cache", this.settings.cacheFolder);
		if (this.app.vault.adapter instanceof FileSystemAdapter) {
			this.cacheFolderPath = path.join(
				this.app.vault.adapter.getBasePath(),
				this.settings.cacheFolder
			);
		}
		if (!fs.existsSync(this.cacheFolderPath)) {
			fs.mkdirSync(this.cacheFolderPath);
			this.cache = new Map();
		} else {
			this.cache = new Map(this.settings.cache);
			// For some reason `this.cache` at this point is actually `Map<string, Array<string>>`
			for (const [k, v] of this.cache) {
				this.cache.set(k, new Set(v));
			}
		}
	}

	unloadCache() {
		fs.rmdirSync(this.cacheFolderPath, { recursive: true });
	}

	formatLatexSource(source: string) {
		return (
			"\\documentclass{standalone}\n" +
			this.settings.additionalPackages +
			source
		);
	}

	hashLatexSource(source: string) {
		return Md5.hashStr(source.trim());
	}

	addRandomPrefixToIds(svgStr: string) {
		function generateRandomPrefix() {
			let letters = "abcdefghijklmnopqrstuvwxyz";
			letters += letters.toUpperCase();
			let prefix = "";
			for (let i = 0; i < 4; i++) {
				prefix += letters[Math.floor(Math.random() * letters.length)];
			}
			return prefix;
		}

		// Generate a random 4-letter prefix
		const randomPrefix = generateRandomPrefix();

		// Replace the id substrings
		let updatedSvgStr = svgStr
			.toString()
			.replace(/xlink:href='#g/g, `xlink:href='#g${randomPrefix}`);

		updatedSvgStr = updatedSvgStr
			.toString()
			.replace(/<path id='g/g, `<path id='g${randomPrefix}`);

		const encoder = new TextEncoder();
		const updatedArrayBuffer = encoder.encode(updatedSvgStr);

		return updatedSvgStr;
	}

	async renderLatexToElement(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		return new Promise<void>((resolve, reject) => {
			let md5Hash = this.hashLatexSource(source);
			let svgPath = path.join(this.cacheFolderPath, `${md5Hash}.svg`);

			// SVG file has already been cached
			// Could have a case where svgCache has the key but the cached file has been deleted
			if (
				this.settings.enableCache &&
				this.cache.has(md5Hash) &&
				fs.existsSync(svgPath)
			) {
				// console.log("Using cached SVG: ", md5Hash);
				//skip - the DOM API or the Obsidian helper functions don't seem to have a way to insert an SVG element
				el.innerHTML = '<img src="data:image/svg+xml;utf8,' + encodeURIComponent(fs.readFileSync(svgPath).toString()) + '" alt=""/>';
				this.addFileToCache(md5Hash, ctx.sourcePath);
				resolve();
			} else {
				// console.log("Rendering SVG: ", md5Hash);

				this.renderLatexToSVG(source, md5Hash, svgPath)
					.then((v: string) => {
						if (this.settings.enableCache)
							this.addFileToCache(md5Hash, ctx.sourcePath);
						//skip - the DOM API or the Obsidian helper functions don't seem to have a way to insert an SVG element
						el.innerHTML = '<img src="data:image/svg+xml;utf8,' + encodeURIComponent(v) + '" alt=""/>';
						resolve();
					})
					.catch((err) => {
						//skip - the DOM API or the Obsidian helper functions don't seem to have a way to insert an SVG element
						el.innerHTML = err;
						reject(err);
					});
			}
		}).then(() => {
			if (this.settings.enableCache)
				setTimeout(() => this.cleanUpCache(), 1000);
		});
	}

	renderLatexToSVG(source: string, md5Hash: string, svgPath: string) {
		return new Promise(async (resolve, reject) => {
			source = this.formatLatexSource(source);

			temp.mkdir("obsidian-latex-renderer", (err, dirPath) => {
				if (err) reject(err);
				fs.writeFileSync(path.join(dirPath, md5Hash + ".tex"), source);
				exec(
					this.settings.command.replace(/{file-path}/g, md5Hash),
					{ timeout: this.settings.timeout, cwd: dirPath },
					async (err, stdout, stderr) => {
						if (err) reject([err, stdout, stderr]);
						else {
							let svgData = fs.readFileSync(
								path.join(dirPath, md5Hash + ".svg")
							);
							let pngData = await this.svgStringToPngArrayBuffer(
								svgData.toString()
							);
							if (this.settings.pngCopy) {
								fs.writeFileSync(
									path.join(
										this.cacheFolderPath,
										md5Hash + ".png"
									),
									Buffer.from(pngData)
								);
							}
							let svgDataStr = this.addRandomPrefixToIds(
								svgData.toString()
							);
							if (this.settings.enableCache) {
								fs.writeFileSync(svgPath, svgDataStr);
							}
							resolve(svgDataStr);
						}
					}
				);
			});
		});
	}

	async saveCache() {
		let temp = new Map();
		for (const [k, v] of this.cache) {
			temp.set(k, [...v]);
		}
		this.settings.cache = [...temp];
		await this.saveSettings();
	}

	addFileToCache(hash: string, file_path: string) {
		if (!this.cache.has(hash)) {
			this.cache.set(hash, new Set());
		}
		this.cache.get(hash)?.add(file_path);
	}

	async cleanUpCache() {
		let file_paths = new Set<string>();
		for (const fps of this.cache.values()) {
			for (const fp of fps) {
				file_paths.add(fp);
			}
		}

		for (const file_path of file_paths) {
			let file = this.app.vault.getAbstractFileByPath(file_path);
			if (file == null) {
				this.removeFileFromCache(file_path);
			} else {
				if (file instanceof TFile) {
					await this.removeUnusedCachesForFile(file);
				}
			}
		}
		await this.saveCache();
	}

	async removeUnusedCachesForFile(file: TFile) {
		let hashes_in_file = await this.getLatexHashesFromFile(file);
		let hashes_in_cache = this.getLatexHashesFromCacheForFile(file);
		for (const hash of hashes_in_cache) {
			if (!hashes_in_file.contains(hash)) {
				this.cache.get(hash)?.delete(file.path);
				if (this.cache.get(hash)?.size == 0) {
					this.removeSVGFromCache(hash);
				}
			}
		}
	}

	removeSVGFromCache(key: string) {
		this.cache.delete(key);
		fs.rmSync(path.join(this.cacheFolderPath, `${key}.svg`));
	}

	removeFileFromCache(file_path: string) {
		for (const hash of this.cache.keys()) {
			this.cache.get(hash)?.delete(file_path);
			if (this.cache.get(hash)?.size == 0) {
				this.removeSVGFromCache(hash);
			}
		}
	}

	async svgStringToPngArrayBuffer(svgString: string): Promise<ArrayBuffer> {
		return new Promise<ArrayBuffer>((resolve, reject) => {
			// Create a new image element
			const img = new Image();

			// Encode the SVG string into a data URL
			const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
			const url = URL.createObjectURL(svgBlob);

			// Set up the image load handler to draw on canvas
			img.onload = () => {
				// Create a canvas element
				const canvas = document.createElement("canvas");
				const context = canvas.getContext("2d");

				if (!context) {
					reject(new Error("Unable to get canvas 2D context"));
					return;
				}

				// Set canvas dimensions to match the image
				canvas.width = img.width * parseFloat(this.settings.pngScale);
				canvas.height = img.height * parseFloat(this.settings.pngScale);

				// Draw the SVG image on the canvas
				context.drawImage(img, 0, 0, canvas.width, canvas.height);

				// Revoke the object URL
				URL.revokeObjectURL(url);

				// Convert the canvas content to a Blob (PNG format)
				canvas.toBlob((blob) => {
					if (!blob) {
						reject(
							new Error("Canvas toBlob() resulted in a null blob")
						);
						return;
					}

					// Create a FileReader to convert the Blob to an ArrayBuffer
					const reader = new FileReader();
					reader.onloadend = () => {
						if (reader.result) {
							resolve(reader.result as ArrayBuffer);
						} else {
							reject(
								new Error("FileReader failed to read the blob")
							);
						}
					};
					reader.readAsArrayBuffer(blob);
				}, "image/png");
			};

			// Handle image load error
			img.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error("Failed to load SVG string as an image"));
			};

			// Set the image source to the data URL
			img.src = url;
		});
	}

	getLatexHashesFromCacheForFile(file: TFile) {
		let hashes: string[] = [];
		let path = file.path;
		for (const [k, v] of this.cache.entries()) {
			if (v.has(path)) {
				hashes.push(k);
			}
		}
		return hashes;
	}

	async getLatexHashesFromFile(file: TFile) {
		let hashes: string[] = [];
		let sections = this.app.metadataCache.getFileCache(file)?.sections;
		if (sections != undefined) {
			let lines = (await this.app.vault.read(file)).split("\n");
			for (const section of sections) {
				if (
					section.type != "code" &&
					lines[section.position.start.line].match("``` *latex") ==
						null
				)
					continue;
				let source = lines
					.slice(
						section.position.start.line + 1,
						section.position.end.line
					)
					.join("\n");
				let hash = this.hashLatexSource(source);
				hashes.push(hash);
			}
		}
		return hashes;
	}
}

class LatexRendererSettingTab extends PluginSettingTab {
	plugin: LatexRenderer;

	constructor(app: App, plugin: LatexRenderer) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl
			.createEl("p", {
				text: 'This plugin uses latex to render SVGs. The SVGs are cached and automatically removed if they are not being used.  The key thing is to find a command that will work on your system. Example: `export LIBGS=/opt/homebrew/lib/libgs.dylib && latex -interaction=nonstopmode -halt-on-error -shell-escape "{file-path}" && dvisvgm --no-fonts "{file-path}"`.   For more information please see the ',
			})
			.createEl("a", {
				text: "README",
				href: "https://github.com/jvsteiner/obsidian-latex-render",
			});

		new Setting(containerEl)
			.setName("Command to generate SVG")
			.setDesc(
				"The command to generate SVG from latex source. Use `{file-path}` as a placeholder for the file path."
			)
			.setClass("latex-render-settings")
			.addTextArea((text) =>
				text
					.setValue(this.plugin.settings.command.toString())
					.onChange(async (value) => {
						this.plugin.settings.command = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable caching of SVGs")
			.setDesc(
				"SVGs rendered by this plugin will be kept in `svg-cache`. The plugin will automatically keep track of used svgs and remove any that aren't being used"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableCache)
					.onChange(async (value) => {
						this.plugin.settings.enableCache = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Make a PNG copy of cached SVGs")
			.setDesc(
				"Cached SVGs rendered by this plugin will be rendered in PNG format in the cache directory."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.pngCopy)
					.onChange(async (value) => {
						this.plugin.settings.pngCopy = value;
						await this.plugin.saveSettings();
						this.plugin.unloadCache();
						this.plugin.loadCache();
					})
			);

		new Setting(containerEl)
			.setName("PNG scale factor")
			.setDesc(
				"If enabled above, PNG format copies will be scaled by the factor below."
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.pngScale).onChange(
					async (value) => {
						this.plugin.settings.pngScale = value;
						await this.plugin.saveSettings();
						this.plugin.unloadCache();
						this.plugin.loadCache();
					}
				);
			});

		new Setting(containerEl)
			.setName("Cache folder path")
			.setDesc(
				"SVGs rendered by this plugin will be kept in this folder, if set.  The default is `svg-cache`. The plugin will automatically keep track of used svgs and remove any that aren't being used"
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.cacheFolder)
					.onChange(async (value) => {
						this.plugin.settings.cacheFolder = value;
						await this.plugin.saveSettings();
						this.plugin.unloadCache();
						this.plugin.loadCache();
					})
			);
		new Setting(containerEl)
			.setName("Additional packages")
			.setDesc(
				"Latex packages typed here will be added to the standard latex source. This can be used to add custom packages or configurations to the latex source"
			)
			.setClass("latex-render-settings")
			.addTextArea((text) =>
				text
					.setValue(
						this.plugin.settings.additionalPackages.toString()
					)
					.onChange(async (value) => {
						this.plugin.settings.additionalPackages = value;
						await this.plugin.saveSettings();
						this.plugin.unloadCache();
						this.plugin.loadCache();
					})
			);
	}
}
