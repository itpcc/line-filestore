import { Elysia } from 'elysia';
import {
	type PaperlessMsgType,
	type MsgEventType,
	type OutgoingMsgType,
} from './types';

export const plugin = new Elysia({ name: 'plugin-state' })
	.state('downloading', [] as MsgEventType[])
	.state('loading', [] as MsgEventType[])
	.state('outgoing_msg', [] as OutgoingMsgType[])
	.state('paperless', [] as PaperlessMsgType[])
	.state('transcoding', [] as MsgEventType[]);
