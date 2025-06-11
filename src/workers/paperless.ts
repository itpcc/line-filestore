import { Elysia, ParseError } from 'elysia';
import { cron, Patterns } from '@elysiajs/cron';
import { type PaperlessTaskRespType } from '../types';
import { plugin as statePlugin } from '../state';

export const plugin = new Elysia({ name: 'worker-paperless' })
	.use(statePlugin)
	.use(cron({
		name: 'paperless',
		pattern: Patterns.everySecond(),
		async run() {
			if (! plugin.store?.paperless?.length) return;

			const body = plugin.store.paperless.shift();

			if (! body) return;
			if (! body?.attempt) body.attempt = 1;

			const userId = body.event.destination;
			const messageId = body.event.event.message.id;
			const filename = body.filename;

			console.info('paperless | Uploading #', body.attempt, userId, messageId, filename);

			try{
				let uploadForm = new FormData();
				uploadForm.append('document', body.response, filename);
				uploadForm.append('title', body.origFilename);
				uploadForm.append('correspondent', process.env.PAPERLESS_CORRESPONDENT as string);
				uploadForm.append('storage_path', process.env.PAPERLESS_STORAGE_PATH as string);
				uploadForm.append('tags', process.env.PAPERLESS_TAGS as string);

				const upldRes = await fetch(
					`${process.env.PAPERLESS_URL as string}/api/documents/post_document/`, {
						method: 'POST',
						headers: {
							'Authorization': `Token ${process.env.PAPERLESS_API_AUTH_TOKEN as string}`
						},
						body: uploadForm
					}
				);

				if (upldRes.status !== 200) {
					let err = new ParseError(new Error('Unable to upload file'));
					err.cause = upldRes;
					throw err;
				}

				const taskId = await upldRes.json() as string;

				let docId: string | null = null;
				let isDone = false;

				while (! isDone) {
					const taskRes = await fetch(
						`${process.env.PAPERLESS_URL as string}/api/tasks/?task_id=${encodeURIComponent(taskId)}`, {
							method: 'GET',
							headers: {
								'Authorization': `Token ${process.env.PAPERLESS_API_AUTH_TOKEN as string}`
							}
						}
					);

					if (taskRes.status !== 200) {
						let err = new ParseError(new Error('Unable to check file task'));
						err.cause = taskRes;
						throw err;
					}

					const taskInfo = await taskRes.json() as PaperlessTaskRespType[];

					switch (taskInfo[0].status) {
						case 'FAILURE':
							isDone = true;
							break;
						case 'STARTED':
						case 'PARSE':
							await new Promise(r => setTimeout(r, 5000));
							break;
						case 'SUCCESS':
							docId = taskInfo[0].related_document;
							isDone = true;
							break;
					}
				}

				if (docId !== null) {
					await fetch(
						`${process.env.PAPERLESS_URL as string}/api/documents/${docId}/`, {
							method: 'PATCH',
							headers: {
								'Authorization': `Token ${process.env.PAPERLESS_API_AUTH_TOKEN as string}`
							},
							body: JSON.stringify({
								"custom_fields": [
									{
										"field": 1,
										"value": userId
									},
									{
										"field": 2,
										"value": messageId
									}
								]
							})
						}
					);
				}

				return;
			} catch (e) {
				console.error('# paperless | Error: ', e);
				body.attempt += 1;

				if (body.attempt > 3) {
					return;
				}

				// Try again later between 3 - 10 seconds
				setTimeout(
					function() { plugin.store.paperless.push(body); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))