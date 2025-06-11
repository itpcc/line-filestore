import { Elysia, ParseError } from 'elysia';
import { cron, Patterns } from '@elysiajs/cron';
import {
	type ReplayRespType,
} from '../types';
import { plugin as statePlugin } from '../state';

export const plugin = new Elysia({ name: 'worker-downloading' })
	.use(statePlugin)
	.use(cron({
		name: 'outgoing_msg',
		pattern: Patterns.everySecond(),
		async run() {
			if (! plugin.store?.outgoing_msg?.length) return;

			const body = plugin.store.outgoing_msg.shift();

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

				if (response.status !== 200) {
					let err = new ParseError(new Error('Reply message cant be sent'));
					err.cause = response;
					throw err;
				}

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
					function() { plugin.store.outgoing_msg.push(body); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))