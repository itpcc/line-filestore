import { Elysia, ParseError } from 'elysia';
import { cron, Patterns } from '@elysiajs/cron';
import { plugin as statePlugin } from '../state';

export const plugin = new Elysia({ name: 'worker-loading' })
	.use(statePlugin)
	.use(cron({
		name: 'loading',
		pattern: Patterns.everySecond(),
		async run() {
			if (! plugin.store?.loading?.length) return;

			const body = plugin.store.loading.shift();

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

				if (response.status !== 202) {
					let err = new ParseError(new Error('Loading cant be sent'));
					err.cause = response;
					throw err;
				}
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
					function() { plugin.store.loading.push(body); },
					Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000
				);
			}
		}
	}));
