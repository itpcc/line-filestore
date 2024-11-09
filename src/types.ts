import { t, type Static } from 'elysia';

export const destinationModel = t.Union(
	[
		'',
		...(process.env.ALLOW_USER_IDS as string).split(',')
	].map(u => t.Literal(u.trim()))
);
export const contentProviderModel = t.Union([
	t.Object({
		type: t.Literal('line')
	}),
	t.Object({
		type: t.Literal('external'),
		originalContentUrl: t.String({
			format: 'uri'
		}),
		previewImageUrl: t.Optional(t.String({
			format: 'uri'
		}))
	})
]);
export const eventModel = t.Union([
	t.Object({
		type: t.Literal('message'),
		message: t.Union([
			t.Object({
				type: t.Literal('text'),
				id: t.String(),
				quoteToken: t.String(),
				text: t.String(),
			}),
			t.Object({
				type: t.Literal('image'),
				id: t.String(),
				quoteToken: t.String(),
				imageSet: t.Optional(t.Object({
					id: t.String(),
					index: t.Number(),
					total: t.Number(),
				})),
				contentProvider: contentProviderModel,
			}, { additionalProperties: true }),
			t.Object({
				type: t.Literal('video'),
				id: t.String(),
				quoteToken: t.String(),
				duration: t.Number(),
				contentProvider: contentProviderModel,
			}, { additionalProperties: true }),
			t.Object({
				type: t.Literal('file'),
				id: t.String(),
				fileName: t.String(),
				fileSize: t.Number(),
				contentProvider: contentProviderModel,
			}, { additionalProperties: true }),
			t.Object({
				type: t.Literal('audio'),
				id: t.String(),
				duration: t.Number(),
				contentProvider: contentProviderModel,
			}, { additionalProperties: true })
		]),
		webhookEventId: t.String(),
		timestamp: t.Numeric(),
		source: t.Object({
			type: t.String(),
			userId: t.String(),
		}),
		replyToken: t.String(),
	}, { additionalProperties: true }),
]);
export const bodyModel = t.Object({
	destination: destinationModel,
	events: t.Array(eventModel),
}, { additionalProperties: true });

export type MsgEventType = {
	destination: Static<typeof destinationModel>,
	event: Static<typeof eventModel>,
	attempt?: number
};
export type FileMeta = {
	type: 'line' | 'external',
	url: string,
	filename: string,
	origFilename: string | null
};
export type ReplayRespType = {
	sentMessages: [
		{
			id: string,
			quoteToken: string,
		}
	]
};
export type PaperlessMsgType = {
	event: MsgEventType,
	attempt?: number,
	filename: string,
	origFilename: string,
	response: Blob
};
export type PaperlessTaskRespType = {
	id: number,
	task_id: string
	task_file_name: string
	date_created: string,
	date_done: string | null,
	type: "file",
	status: "STARTED" | "FAILURE" | "SUCCESS" | "PARSE",
	result: string | null,
	acknowledged: boolean
	related_document: string | null
};
export type OutgoingMsgType = {
	event: MsgEventType,
	message: String,
	filename?: String | null,
	attempt?: number,
	response?: ReplayRespType,
	error?: any
};
