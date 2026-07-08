import { createDirectus, staticToken, rest } from '@directus/sdk';

const host = process.env.DIRECTUS_HOST || 'http://localhost:8055';
const token = process.env.DIRECTUS_TOKEN || '';

export const directus = createDirectus(host)
	.with(staticToken(token))
	.with(rest());
