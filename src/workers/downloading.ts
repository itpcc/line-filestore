import { Elysia, ParseError } from 'elysia';
import { parse as pathParse } from 'path';
import {
	type FileMeta,
} from '../types';
import { cron, Patterns } from '@elysiajs/cron';
import { plugin as statePlugin } from '../state';

export const plugin = new Elysia({ name: 'worker-downloading' })
	.use(statePlugin)
	.use(cron({
		name: 'downloading',
		pattern: Patterns.everySecond(),
		async run() {
			if ((plugin.store?.downloading?.length ?? 0) < 1) return;

			const msg = plugin.store.downloading.shift();

			if (! msg) return;
			if (! msg?.attempt) msg.attempt = 1;

			try {
				const urls: FileMeta[] = [];
				const message = msg.event.message;
				const fileId = `${msg.destination}_${message.id}`

				if (message.type === 'audio') {
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
					// const fnSv = `file-${fileId}`; 
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
					`img-${fileId}${
						message?.imageSet?.id ?
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
					}
				}

				if (! urls.length) {
					let err = new ParseError(new Error('No suitable files to download'));
					err.cause = message;
					throw err;
				}

				console.info(
					'downloading | Getting file',
					msg.destination,
					'->',
					urls.map(url => url.filename)
				);

				const filenameOk = await Promise.all(urls.map(async (url) => {
					// @see https://gist.github.com/barbietunnie/7bc6d48a424446c44ff4#file-sanitize-filename-js-L34
					const illegalRe = /[\/\?<>\\:\*\|":]/g;
					const controlRe = /[\x00-\x1f\x80-\x9f]/g;
					const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
					const sntFilename = url.filename.replace(illegalRe, '_')
						.replace(controlRe, '_')
						.replace(windowsReservedRe, '_')
						.replace(/\_{2,}/g, '_');
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

					let resBlob = await response.blob();

					await Bun.write(
						`${(process.env.FILESTORE_PATH as string).replace(/\/$/, '')}/${sntFilename}`,
						resBlob
					);

					if (sntFilename.match(/\.pdf$/gi) !== null) {
						plugin.store.paperless.push({
							event: msg,
							filename: url.filename,
							origFilename: url.origFilename ?? url.filename,
							response: resBlob
						});
					}

					return sntFilename;
				}));

				plugin.store.outgoing_msg.push({
					event: msg,
					message: `
						File store:
						${filenameOk.join('\n')}
					`,
				});
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
					function() { plugin.store.downloading.push(msg); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))
