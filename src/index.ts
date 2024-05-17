import { Elysia, ParseError, t, type Static } from 'elysia';
import { Logestic } from 'logestic';
import { createHmac } from 'crypto';
import { cron, Patterns } from '@elysiajs/cron';
import {
	bodyModel,
	type MsgEventType,
	type FileMeta,
	type ReplayRespType,
	type OutgoingMsgType,
} from './types';

const app = new Elysia({
		normalize: true
	})
	.state('loading', [] as MsgEventType[])
	.state('transcoding', [] as MsgEventType[])
	.state('downloading', [] as MsgEventType[])
	.state('outgoing_msg', [] as OutgoingMsgType[])
	.use(Logestic.preset('fancy'))
	.use(cron({
		name: 'loading',
		pattern: Patterns.everySecond(),
		async run() {
			if (! app.store.loading.length) return;

			const body = app.store.loading.shift();

			if (! body) return;
			if (! body?.attempt) body.attempt = 1;

			const chatId = body.event.source.userId;
			console.info('loading | sending ', chatId);

			try{
				const response = await fetch(
					'https://api.line.me/v2/bot/chat/loading/start', {
						method: "POST",
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${process.env.ACCESS_TOKEN as string}`
						},
						body: JSON.stringify({
							chatId
						})
					}
				);

				if (response.status !== 202) throw new ParseError(
					'Loading cant be sent',
					response
				);
				console.info('loading | sent ', chatId);

				return;
			} catch (e) {
				console.error('# loading | Error: ', e);
				body.attempt += 1;

				if (body.attempt > 3) {
					return;
				}

				// Try again later between 3 - 10 seconds
				setTimeout(
					function() { app.store.loading.push(body); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))
	.use(cron({
		name: 'transcoding',
		pattern: Patterns.everySecond(),
		async run() {
			if (app.store.transcoding.length < 1) return;

			const msg = app.store.transcoding.shift();

			if (! msg) return;
			if (! msg?.attempt) msg.attempt = 1;

			try {
				const url = `https://api-data.line.me/v2/bot/message/${msg.event.message.id}/content/transcoding`;

				console.info('transcoding | checking ', url);

				const response = await fetch(
					url, {
						method: "GET",
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${process.env.ACCESS_TOKEN as string}`
						},
					}
				);
				const body = await response.json();

				if (body?.status === 'succeeded') {
					app.store.downloading.push(msg);
					return;
				} else if (body?.status === 'processing') {
					// Try again later between 10 - 60 seconds
					setTimeout(
						function() { app.store.transcoding.push(msg); },
						Math.floor(Math.random() * (60000 - 10000 + 1)) + 10000
					);
					return;
				}

				console.error('# transcoding | error checking ', url, body);
				throw new ParseError('Transcoding error', body);
			} catch (e) {
				console.error('# transcoding | Error: ', e);
				msg.attempt += 1;

				if (msg.attempt > 3) {
					app.store.outgoing_msg.push({
						event: msg,
						message: `Unable to check transcoding status`,
					});
					return;
				}

				// Try again later between 3 - 10 seconds
				setTimeout(
					function() { app.store.transcoding.push(msg); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))
	.use(cron({
		name: 'downloading',
		pattern: Patterns.everySecond(),
		async run() {
			if (app.store.downloading.length < 1) return;

			const msg = app.store.downloading.shift();

			if (! msg) return;
			if (! msg?.attempt) msg.attempt = 1;

			try {
				const urls: FileMeta[] = [];
				const message = msg.event.message;
				const fileId = `${msg.destination}_${message.id}`

				if (message.type === 'audio' || message.type === 'file') {
					urls.push({
						type: message.contentProvider.type,
						url: (message.contentProvider.type === 'line') ?
							`https://api-data.line.me/v2/bot/message/${message.id}/content` :
							message.contentProvider.originalContentUrl,
						filename: (message.type === 'audio') ?
							`audio-${fileId}.ogg` :
							`file-${fileId}-${message.fileName}`
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
							`${filenamePfx}.mp4`
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
								`${filenamePfx}-preview.mp4`
						});
					}
				}

				if (! urls.length) throw new ParseError(
					'No suitable files to download',
					message
				);

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

					if (response.status !== 200) throw new ParseError(
						'File not ready to be downloaded',
						response
					);

					await Bun.write(
						`${(process.env.FILESTORE_PATH as string).replace(/\/$/, '')}/${sntFilename}`,
						response
					);

					return sntFilename;
				}));

				app.store.outgoing_msg.push({
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
					app.store.outgoing_msg.push({
						event: msg,
						message: `Unable to download files`,
					});
					return;
				}

				// Try again later between 3 - 10 seconds
				setTimeout(
					function() { app.store.downloading.push(msg); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))
	.use(cron({
		name: 'outgoing_msg',
		pattern: Patterns.everySecond(),
		async run() {
			if (! app.store.outgoing_msg.length) return;

			const body = app.store.outgoing_msg.shift();

			if (! body) return;
			if (! body?.attempt) body.attempt = 1;

			const userId = body.event.destination;
			const replyToken = body.event.event.replyToken;
			const msgSnt = body.message.split('\n').map(t => t.trim()).join('\n').trim();
			const message = msgSnt + `
---------------------
Received: ${(new Date(body.event.event.timestamp)).toISOString()}
			`;
			const messagePayload: {
				type: 'text',
				text: string,
				quoteToken?: string
			} = {
				type: 'text',
				text: message
			};

			if(
				body.event.event.message.type === 'text' ||
				body.event.event.message.type === 'image' ||
				body.event.event.message.type === 'video'
			) {
				messagePayload.quoteToken = body.event.event.message.quoteToken;
			}

			console.info('outgoing_msg | sending message #', body.attempt, userId, messagePayload);

			try{
				const response = await fetch(
					'https://api.line.me/v2/bot/message/reply', {
						method: "POST",
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${process.env.ACCESS_TOKEN as string}`
						},
						body: JSON.stringify({
							replyToken,
							messages: [
								messagePayload
							]
						})
					}
				);

				if (response.status !== 200) throw new ParseError(
					'Reply message cant be sent',
					response
				);

				const responseJsn = await response.json() as ReplayRespType;
				body.response = responseJsn;
				await Bun.write(
					`${
						(process.env.FILESTORE_PATH as string).replace(/\/$/, '')
					}/msg-${userId}-${body.event.event.message.id}.meta.json`,
					JSON.stringify(body)
				);
				console.info('outgoing_msg | sent message #', responseJsn);

				return;
			} catch (e) {
				console.error('# message | Error: ', e);
				body.attempt += 1;

				if (body.attempt > 3) {
					body.error = e;
					await Bun.write(
						`${
							(process.env.FILESTORE_PATH as string).replace(/\/$/, '')
						}/msg-${userId}-${body.event.event.message.id}.meta.json`,
						JSON.stringify(body)
					);
					return;
				}

				// Try again later between 3 - 10 seconds
				setTimeout(
					function() { app.store.outgoing_msg.push(body); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))
	.get("/", () => "Hello Elysia")
	.post(
		'/webhook',
		({ body, store }) => {
			for (const event of body.events) {
				const eventPayload = {
					destination: body.destination,
					event
				}

				if (event?.type === 'message') {
					if (event?.message?.type === 'text') {
						store.outgoing_msg.push({
							event: eventPayload,
							message: `
								Message store:
								${event?.message.text}
							`,
						});

						continue;
					} else if (event?.message?.type === 'image' || event?.message?.type === 'file') {
						store.loading.push(eventPayload);
						store.downloading.push(eventPayload);

						continue;
					} else if (event?.message?.type === 'video' || event?.message?.type === 'audio') {
						store.loading.push(eventPayload);

						if (event.message?.contentProvider?.type === 'line') {
							store.transcoding.push(eventPayload);
						} else {
							store.downloading.push(eventPayload);
						}

						continue;
					}
				}

				store.outgoing_msg.push({
					event: eventPayload,
					message: 'Unable to send: Unsupport message type',
				});
			}

			return {
				ok: 200
			};
		},
		{
			headers: t.Object({
				'x-line-signature': t.String()
			}),
			body: bodyModel,
			async parse({request: req, cookie: { hash }, error, params }, contentType) {
				if (contentType !== 'application/json') {
					return error(400, 'Only JSON allowed');
				}

				const body = await req.text();

				hash.value = createHmac(
					'sha256',
					(process.env.CHANNEL_SECRET as string)
				)
					.update(body)
					.digest('base64');

				return JSON.parse(body);
			},
			async beforeHandle({ request: req, error, cookie: { hash } }) {
				if (hash?.value !== req.headers.get('x-line-signature')) {
					return error('Forbidden', {
						"name": "Forbidden",
						"message": "Invalid signature"
					});
				}
			}
		}
	)
	.listen(3000);

console.log(
	`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
