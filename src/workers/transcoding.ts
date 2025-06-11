import { Elysia, ParseError } from 'elysia';
import { cron, Patterns } from '@elysiajs/cron';
import { plugin as statePlugin } from '../state';

export const plugin = new Elysia({ name: 'worker-downloading' })
	.use(statePlugin)
	.use(cron({
		name: 'transcoding',
		pattern: Patterns.everySecond(),
		async run() {
			if ((plugin.store?.transcoding?.length ?? 0) < 1) return;

			const msg = plugin.store.transcoding.shift();

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
					plugin.store.downloading.push(msg);
					return;
				} else if (body?.status === 'processing') {
					// Try again later between 10 - 60 seconds
					setTimeout(
						function() { plugin.store.transcoding.push(msg); },
						Math.floor(Math.random() * (60000 - 10000 + 1)) + 10000
					);
					return;
				}

				console.error('# transcoding | error checking ', url, body);
				let err = new ParseError(new Error('Transcoding error'));
				err.cause = body;
				throw err;
			} catch (e) {
				console.error('# transcoding | Error: ', e);
				msg.attempt += 1;

				if (msg.attempt > 3) {
					plugin.store.outgoing_msg.push({
						event: msg,
						message: `Unable to check transcoding status`,
					});
					return;
				}

				// Try again later between 3 - 10 seconds
				setTimeout(
					function() { plugin.store.transcoding.push(msg); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}))