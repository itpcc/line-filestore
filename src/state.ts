import { Elysia } from 'elysia';
import {
	type MsgEventType,
	type OutgoingMsgType,
} from './types';

export const plugin = new Elysia({ name: 'plugin-state' })
	.state('downloading', [] as MsgEventType[])
	.state('loading', [] as MsgEventType[])
	.state('outgoing_msg', [] as OutgoingMsgType[])
	.state('transcoding', [] as MsgEventType[]);
