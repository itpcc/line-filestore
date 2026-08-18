import { Elysia, ParseError } from 'elysia';
import { parse as pathParse } from 'path';
import { mkdirSync, existsSync } from 'fs';
import {
	type FileMeta,
	type MsgEventType,
} from '../types';
import { cron, Patterns } from '@elysiajs/cron';
import { plugin as statePlugin } from '../state';
import { directus } from '../directus';
import { uploadFiles } from '@directus/sdk';
import { downloadGDriveFile, extractGDriveFileIds, fetchGDriveFileMeta } from '../gdrive';

export function sanitizeFilename(filename: string): string {
	// @see https://gist.github.com/barbietunnie/7bc6d48a424446c44ff4#file-sanitize-filename-js-L34
	const illegalRe = /[\/\?<>\\:\*\|":]/g;
	const controlRe = /[\x00-\x1f\x80-\x9f]/g;
	const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
	return filename
		.replace(illegalRe, '_')
		.replace(controlRe, '_')
		.replace(windowsReservedRe, '_')
		.replace(/\_{2,}/g, '_');
}

export const imageResizer = {
	async resize(blob: Blob | ArrayBuffer, width: number, height: number, format: "webp" | "png" = "webp"): Promise<Blob> {
		const img = new Bun.Image(blob);
		const resized = img.resize(width, height, { fit: "inside", withoutEnlargement: true });
		if (format === "png") {
			return await resized.png().blob();
		}
		return await resized.webp().blob();
	}
};

export async function extractVideoFrame(videoBlob: Blob, messageId: string): Promise<Blob> {
	const tempDir = './tmp';
	if (!existsSync(tempDir)) {
		mkdirSync(tempDir, { recursive: true });
	}
	const tempInputPath = `${tempDir}/temp_video_${messageId}_${Date.now()}`;
	await Bun.write(tempInputPath, videoBlob);

	try {
		// Extract single frame at 1s using ffmpeg
		const proc = Bun.spawn([
			"ffmpeg",
			"-loglevel", "quiet",
			"-y",
			"-i", tempInputPath,
			"-ss", "00:00:01",
			"-vframes", "1",
			"-f", "image2",
			"-c:v", "png",
			"-"
		]);
		let imgBuffer = await new Response(proc.stdout).arrayBuffer();
		let exitCode = await proc.exited;

		if (exitCode !== 0 || imgBuffer.byteLength === 0) {
			// Fallback: extract first frame without seeking
			const fallbackProc = Bun.spawn([
				"ffmpeg",
				"-loglevel", "quiet",
				"-y",
				"-i", tempInputPath,
				"-vframes", "1",
				"-f", "image2",
				"-c:v", "png",
				"-"
			]);
			imgBuffer = await new Response(fallbackProc.stdout).arrayBuffer();
			await fallbackProc.exited;
		}

		if (imgBuffer.byteLength > 0) {
			try {
				return await imageResizer.resize(imgBuffer, 400, 400, "webp");
			} catch (e) {
				return new Blob([imgBuffer], { type: "image/png" });
			}
		} else {
			throw new Error("FFMPEG failed to extract video frame");
		}
	} finally {
		// Clean up temp file
		const tempFile = Bun.file(tempInputPath);
		if (await tempFile.exists()) {
			await tempFile.delete();
		}
	}
}

export async function processDownload(msg: MsgEventType, store: typeof plugin.store) {
	const urls: FileMeta[] = [];
	const message = msg.event.message;
	const fileId = `${msg.destination}_${message.id}`;
	let hasThumbnailInUrls = false;

	let directusFileId: string | null = null;
	let directusPreviewId: string | null = null;
	const directusFilesIds: string[] = [];
	let originalBlob: Blob | null = null;
	let originalFilename: string | null = null;
	let originalOrigFilename: string | null = null;
	const filenameOk: [string, string][] = [];

	if (message.type === 'text') {
		const gdriveIds = extractGDriveFileIds(message.text);
		for (let idx = 0; idx < gdriveIds.length; idx++) {
			const gdriveId = gdriveIds[idx];
			try {
				const meta = await fetchGDriveFileMeta(gdriveId);
				const fNf = pathParse(meta.name);
				const fnSv = `file-${fileId}-${fNf.name.substring(0, 10)}`;
				const fnSvTrnc = (fnSv.length > 100) ? fnSv.substring(0, 100) : fnSv;
				const filename = gdriveIds.length > 1 && idx > 0
					? `${fnSvTrnc}_${idx}${fNf.ext}`
					: `${fnSvTrnc}${fNf.ext}`;
				urls.push({
					type: 'gdrive',
					url: gdriveId,
					filename,
					origFilename: meta.name
				});
			} catch (e: any) {
				console.error(`downloading | Google Drive metadata error for ${gdriveId}:`, e);
				store.outgoing_msg.push({
					event: msg,
					message: `Google Drive download skipped (${gdriveId}): ${e?.message ?? e}`
				});
			}
		}
	} else if (message.type === 'audio') {
		urls.push({
			type: message.contentProvider.type,
			url: (message.contentProvider.type === 'line') ?
				`https://api-data.line.me/v2/bot/message/${message.id}/content` :
				message.contentProvider.originalContentUrl,
			filename: `audio-${fileId}.ogg`,
			origFilename: null
		});
	} else if (message.type === 'file') {
		const fNf = pathParse(message.fileName);
		const fnSv = `file-${fileId}-${fNf.name.substring(0, 10)}`;
		const fnSvTrnc = (fnSv.length > 100) ? fnSv.substring(0, 100) : fnSv;
		urls.push({
			type: message.contentProvider.type,
			url: (message.contentProvider.type === 'line') ?
				`https://api-data.line.me/v2/bot/message/${message.id}/content` :
				message.contentProvider.originalContentUrl,
			filename: `${fnSvTrnc}${fNf.ext}`,
			origFilename: message.fileName
		});
	} else if (message.type === 'image' || message.type === 'video') {
		const filenamePfx = (message.type === 'image') ?
			`img-${fileId}${message?.imageSet?.id ?
				`-set_${message.imageSet.id}_${message.imageSet.index}` :
				''
			}` :
			`video-${fileId}`;

		urls.push({
			type: message.contentProvider.type,
			url: (message.contentProvider.type === 'line') ?
				`https://api-data.line.me/v2/bot/message/${message.id}/content` :
				message.contentProvider.originalContentUrl,
			filename: (message.type === 'image') ?
				`${filenamePfx}.jpg` :
				`${filenamePfx}.mp4`,
			origFilename: null
		});

		if (
			message.contentProvider.type === 'line' ||
			message.contentProvider?.previewImageUrl
		) {
			urls.push({
				type: message.contentProvider.type,
				url: (message.contentProvider.type === 'line') ?
					`https://api-data.line.me/v2/bot/message/${message.id}/content/preview` :
					message.contentProvider.previewImageUrl ?? '',
				filename: (message.type === 'image') ?
					`${filenamePfx}-preview.jpg` :
					`${filenamePfx}-preview.mp4`,
				origFilename: null
			});
			hasThumbnailInUrls = true;
		}
	}

	if (!urls.length) {
		let err = new ParseError(new Error('No suitable files to download'));
		err.cause = message;
		throw err;
	}

	if (urls.length) {
		console.info(
			'downloading | Getting file',
			msg.destination,
			'->',
			urls.map(url => url.filename)
		);

		const fetched = await Promise.all(urls.map(async (url) => {
			const sntFilename = sanitizeFilename(url.filename);
			const originalName = url.origFilename ?? url.filename;
			const sntOriginalName = sanitizeFilename(originalName);

			let resBlob: Blob;
			if (url.type === 'gdrive') {
				resBlob = await downloadGDriveFile(url.url);
			} else {
				const response = await fetch(
					url.url, {
					method: "GET",
					headers: url.type === 'line' ? {
						'Authorization': `Bearer ${process.env.ACCESS_TOKEN as string}`
					} : {},
				}
				);

				if (response.status !== 200) {
					let err = new ParseError(new Error('File not ready to be downloaded'));
					err.cause = response;
					throw err;
				}

				resBlob = await response.blob();
			}

			if (process.env.FILESTORE_PATH) {
				await Bun.write(
					`${(process.env.FILESTORE_PATH as string).replace(/\/$/, '')}/${sntFilename}`,
					resBlob
				);
			}

			// Upload to Directus
			const formData = new FormData();
			formData.append('file', resBlob, sntOriginalName);
			const uploadRes = await directus.request(uploadFiles(formData));
			const fileId = Array.isArray(uploadRes) ? uploadRes[0]?.id : uploadRes?.id;

			if (sntFilename.includes('-preview')) {
				directusPreviewId = fileId;
			} else if (!directusFileId) {
				directusFileId = fileId;
				originalBlob = resBlob;
				originalFilename = sntFilename;
				originalOrigFilename = url.origFilename ?? url.filename;
			} else {
				directusFilesIds.push(fileId);
			}

			if (sntFilename.match(/\.pdf$/gi) !== null) {
				store.paperless.push({
					event: msg,
					filename: url.filename,
					origFilename: url.origFilename ?? url.filename,
					response: resBlob
				});
			}

			return [sntFilename, url.origFilename ?? url.filename] as [string, string];
		}));

		filenameOk.push(...fetched);
	}

	// Custom thumbnail generation if not already downloaded
	const targetFilename = (message.type === 'file' && message.fileName)
		? message.fileName
		: (originalOrigFilename ?? '');
	const ext = targetFilename ? pathParse(targetFilename).ext.toLowerCase().replace(/^\./, '') : '';
	const isImg = message.type === 'image' || (['jpg', 'jpeg', 'png', 'gif', 'apng', 'webp'].includes(ext));
	const isVid = message.type === 'video' || (['mp4', 'wmv', 'webm'].includes(ext));
	const isPdf = ext === 'pdf';

	const shouldGeneratePreview = !hasThumbnailInUrls && (isImg || isVid || isPdf);

	let previewBlob: Blob | null = null;
	if (shouldGeneratePreview && originalBlob) {
		let previewAttempt = 1;
		while (previewAttempt <= 3) {
			try {
				if (isImg) {
					// Use imageResizer utility
					previewBlob = await imageResizer.resize(originalBlob, 400, 400, "webp");
				} else if (isVid) {
					previewBlob = await extractVideoFrame(originalBlob, message.id);
				} else if (isPdf) {
					if (!process.env.STIRLING_PDF_URL) {
						throw new Error("STIRLING_PDF_URL is not set in environment");
					}
					const formData = new FormData();
					formData.append("fileInput", originalBlob, "document.pdf");
					formData.append("imageFormat", "webp");
					formData.append("singleOrMultiple", "single");
					formData.append("pageNumbers", "1");
					formData.append("dpi", "72");

					const stirlingUrl = `${process.env.STIRLING_PDF_URL.replace(/\/$/, '')}/api/v1/convert/pdf/img`;
					const response = await fetch(stirlingUrl, {
						method: "POST",
						body: formData
					});

					if (response.status !== 200) {
						throw new Error(`Stirling PDF API returned status ${response.status}`);
					}
					previewBlob = await response.blob();
				}
				break; // Success! Break retry loop.
			} catch (previewErr) {
				console.error(`Thumbnail generation attempt ${previewAttempt} failed:`, previewErr);
				if (previewAttempt >= 3) {
					console.error("Failed to generate thumbnail after 3 attempts.");
				} else {
					const delay = previewAttempt * 500;
					await new Promise(resolve => setTimeout(resolve, delay));
				}
				previewAttempt++;
			}
		}
	}

	if (previewBlob && originalFilename) {
		const originalParsed = pathParse(originalFilename);
		const isPngFallback = previewBlob.type === "image/png";
		const previewExt = isPngFallback ? ".png" : ".webp";
		const previewFilename = `${originalParsed.name}-preview${previewExt}`;
		const originalOrigParsed = pathParse(originalOrigFilename ?? originalFilename);
		const previewOrigFilename = `${originalOrigParsed.name}-preview${previewExt}`;

		if (process.env.FILESTORE_PATH) {
			await Bun.write(
				`${(process.env.FILESTORE_PATH as string).replace(/\/$/, '')}/${previewFilename}`,
				previewBlob
			);
		}

		// Upload to Directus
		const formData = new FormData();
		formData.append('file', previewBlob, sanitizeFilename(previewOrigFilename));
		const uploadRes = await directus.request(uploadFiles(formData));
		const fileId = Array.isArray(uploadRes) ? uploadRes[0]?.id : uploadRes?.id;

		directusPreviewId = fileId;
		filenameOk.push([previewFilename, previewOrigFilename]);
	}

	store.outgoing_msg.push({
		event: msg,
		message: `
			File store:
			${filenameOk.map(([filenameOk, originalName]) =>
			`  - ${filenameOk} (Original name: ${originalName})`).join('\n')}
		`,
		directus_file_id: directusFileId,
		directus_preview_id: directusPreviewId,
		directus_files_ids: directusFilesIds
	});
}

export const plugin = new Elysia({ name: 'worker-downloading' })
	.use(statePlugin)
	.use(cron({
		name: 'downloading',
		pattern: Patterns.everySecond(),
		async run() {
			if ((plugin.store?.downloading?.length ?? 0) < 1) return;

			const msg = plugin.store.downloading.shift();

			if (!msg) return;
			if (!msg?.attempt) msg.attempt = 1;

			try {
				await processDownload(msg, plugin.store);
			} catch (e) {
				console.error('# downloading | Error: ', e);
				msg.attempt += 1;

				if (msg.attempt > 3) {
					plugin.store.outgoing_msg.push({
						event: msg,
						message: `Unable to download files`,
					});
					return;
				}

				// Try again later between 3 - 10 seconds
				setTimeout(
					function () { plugin.store.downloading.push(msg); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}));
