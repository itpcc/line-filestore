import { Elysia, t } from 'elysia';
import { Logestic } from 'logestic';
import { createHmac } from 'crypto';
import { bodyModel } from './types';

import {
	loading     as loadingWorker,
	transcoding as transcodingWorker,
	downloading as downloadingWorker,
	outgoing    as outgoingWorker,
	paperless   as paperlessWorker
} from './workers';

const app = new Elysia({
		normalize: true
	})
	.use(loadingWorker)
	.use(transcodingWorker)
	.use(downloadingWorker)
	.use(outgoingWorker)
	.use(paperlessWorker)
	.use(Logestic.preset('fancy'))
	.get("/", () => "Hello Elysia")
	.post(
		'/webhook',
		({ body, store }) => {
			console.log('body', body);

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
				console.log('body | ', body);
				hash.value = createHmac(
					'sha256',
					(process.env.CHANNEL_SECRET as string)
				)
					.update(body)
					.digest('base64');

				return JSON.parse(body);
			},
			async beforeHandle({ request: req, error, cookie: { hash } }) {
				console.log('hash?.value', hash?.value, req.headers.get('x-line-signature'))
				if (hash?.value !== req.headers.get('x-line-signature')) {
					return error('Forbidden', {
						"name": "Forbidden",
						"message": "Invalid signature"
					});
				}
			}
		}
	)
	.listen(process.env?.PORT ?? 3000);

console.log(
	`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
