import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { processDownload, imageResizer } from "./downloading";
import type { MsgEventType } from "../types";

// Mock the directus sdk module
mock.module("../directus", () => {
	return {
		directus: {
			request: async (action: any) => {
				// Mock file upload response
				return { id: "mock-uploaded-file-id" };
			}
		}
	};
});

describe("Downloading Worker Thumbnail Generation", () => {
	let originalBunSpawn: any;
	let originalFetch: any;
	let originalResize: any;
	let originalFilestorePath: string | undefined;
	let originalAllowUserIds: string | undefined;

	beforeAll(() => {
		originalBunSpawn = Bun.spawn;
		originalFetch = globalThis.fetch;
		originalResize = imageResizer.resize;
		originalFilestorePath = process.env.FILESTORE_PATH;
		originalAllowUserIds = process.env.ALLOW_USER_IDS;

		// Configure environment variables for test execution
		process.env.ALLOW_USER_IDS = "dest123";
		// Temporarily clear FILESTORE_PATH to avoid ENOENT errors when running tests locally
		delete process.env.FILESTORE_PATH;

		// Mock the image resizer helper
		imageResizer.resize = mock(async (blob: any, w: number, h: number, format?: string) => {
			return new Blob(["mock-webp-content"], { type: format === "png" ? "image/png" : "image/webp" });
		});
	});

	afterAll(() => {
		Bun.spawn = originalBunSpawn;
		globalThis.fetch = originalFetch;
		imageResizer.resize = originalResize;
		if (originalFilestorePath !== undefined) {
			process.env.FILESTORE_PATH = originalFilestorePath;
		}
		if (originalAllowUserIds !== undefined) {
			process.env.ALLOW_USER_IDS = originalAllowUserIds;
		}
	});

	test("Happy path: Image message thumbnail generation", async () => {
		// Mock global fetch to return original image
		globalThis.fetch = mock(async (url: string, init?: any) => {
			return {
				status: 200,
				blob: async () => new Blob(["original-image-content"], { type: "image/jpeg" })
			} as any;
		}) as any;

		const store = {
			downloading: [],
			outgoing_msg: [],
			paperless: [],
			loading: [],
			transcoding: []
		} as any;

		const msg: MsgEventType = {
			destination: "dest123",
			event: {
				type: "message",
				webhookEventId: "evt_img_123",
				replyToken: "reply_img_123",
				message: {
					type: "image",
					id: "msg_img_123",
					quoteToken: "quote_img_123",
					contentProvider: {
						type: "external",
						originalContentUrl: "https://example.com/image.jpg"
					}
				},
				timestamp: Date.now(),
				source: {
					type: "user",
					userId: "user_abc"
				}
			}
		};

		await processDownload(msg, store);

		expect(store.outgoing_msg.length).toBe(1);
		expect(store.outgoing_msg[0].directus_file_id).toBe("mock-uploaded-file-id");
		expect(store.outgoing_msg[0].directus_preview_id).toBe("mock-uploaded-file-id");
		expect(store.outgoing_msg[0].message).toContain("img-dest123_msg_img_123.jpg");
		expect(store.outgoing_msg[0].message).toContain("img-dest123_msg_img_123-preview.webp");
	});

	test("Happy path: Video message thumbnail generation", async () => {
		let spawnCalls: string[][] = [];

		// Mock Bun.spawn for ffmpeg
		Bun.spawn = ((args: string[], options?: any) => {
			spawnCalls.push(args);
			return {
				stdout: {
					arrayBuffer: async () => new TextEncoder().encode("mock-frame-bytes").buffer
				},
				exited: Promise.resolve(0)
			} as any;
		}) as any;

		// Mock global fetch for downloading video
		globalThis.fetch = mock(async (url: string, init?: any) => {
			return {
				status: 200,
				blob: async () => new Blob(["video-content"], { type: "video/mp4" })
			} as any;
		}) as any;

		const store = {
			downloading: [],
			outgoing_msg: [],
			paperless: [],
			loading: [],
			transcoding: []
		} as any;

		const msg: MsgEventType = {
			destination: "dest123",
			event: {
				type: "message",
				webhookEventId: "evt_vid_123",
				replyToken: "reply_vid_123",
				message: {
					type: "video",
					id: "msg_vid_123",
					quoteToken: "quote_vid_123",
					duration: 120,
					contentProvider: {
						type: "external",
						originalContentUrl: "https://example.com/video.mp4"
					}
				},
				timestamp: Date.now(),
				source: {
					type: "user",
					userId: "user_abc"
				}
			}
		};

		await processDownload(msg, store);

		expect(spawnCalls.length).toBeGreaterThan(0);
		expect(spawnCalls[0]).toContain("ffmpeg");
		expect(spawnCalls[0]).toContain("-vframes");
		expect(store.outgoing_msg.length).toBe(1);
		expect(store.outgoing_msg[0].directus_preview_id).toBe("mock-uploaded-file-id");
		expect(store.outgoing_msg[0].message).toContain("video-dest123_msg_vid_123-preview.webp");
	});

	test("Happy path: PDF Document thumbnail generation (Stirling PDF API)", async () => {
		let stirlingPayloadReceived: FormData | null = null;
		let stirlingUrlCalled: string = "";

		// Mock global fetch to intercept both download and Stirling PDF POST
		globalThis.fetch = mock(async (url: string, init?: any) => {
			if (url.includes("/api/v1/convert/pdf/img")) {
				stirlingUrlCalled = url;
				stirlingPayloadReceived = init?.body as FormData;
				return {
					status: 200,
					blob: async () => new Blob(["pdf-page-image-webp"], { type: "image/webp" })
				} as any;
			}
			// Original download
			return {
				status: 200,
				blob: async () => new Blob(["pdf-document-bytes"], { type: "application/pdf" })
			} as any;
		}) as any;

		process.env.STIRLING_PDF_URL = "http://stirling-mock:25080";

		const store = {
			downloading: [],
			outgoing_msg: [],
			paperless: [],
			loading: [],
			transcoding: []
		} as any;

		const msg: MsgEventType = {
			destination: "dest123",
			event: {
				type: "message",
				webhookEventId: "evt_doc_123",
				replyToken: "reply_doc_123",
				message: {
					type: "file",
					id: "msg_doc_123",
					fileName: "my_manual.pdf",
					fileSize: 12345,
					contentProvider: {
						type: "external",
						originalContentUrl: "https://example.com/document.pdf"
					}
				},
				timestamp: Date.now(),
				source: {
					type: "user",
					userId: "user_abc"
				}
			}
		};

		await processDownload(msg, store);

		expect(stirlingUrlCalled).toBe("http://stirling-mock:25080/api/v1/convert/pdf/img");
		expect(stirlingPayloadReceived).not.toBeNull();
		expect(store.outgoing_msg.length).toBe(1);
		expect(store.outgoing_msg[0].directus_preview_id).toBe("mock-uploaded-file-id");
		expect(store.outgoing_msg[0].message).toContain("my_manual-preview.webp");
	});

	test("Resilience / Integrity: Fallback on thumbnail generation failure", async () => {
		// Mock imageResizer to throw an error
		imageResizer.resize = mock(async () => {
			throw new Error("Simulated imageResizer error");
		});

		// Mock global fetch for download
		globalThis.fetch = mock(async (url: string, init?: any) => {
			return {
				status: 200,
				blob: async () => new Blob(["original-image-content"], { type: "image/jpeg" })
			} as any;
		}) as any;

		const store = {
			downloading: [],
			outgoing_msg: [],
			paperless: [],
			loading: [],
			transcoding: []
		} as any;

		const msg: MsgEventType = {
			destination: "dest123",
			event: {
				type: "message",
				webhookEventId: "evt_faulty_123",
				replyToken: "reply_faulty_123",
				message: {
					type: "image",
					id: "msg_faulty_123",
					quoteToken: "quote_faulty_123",
					contentProvider: {
						type: "external",
						originalContentUrl: "https://example.com/image.jpg"
					}
				},
				timestamp: Date.now(),
				source: {
					type: "user",
					userId: "user_abc"
				}
			}
		};

		// Should not crash the process; download succeeds without a preview
		await processDownload(msg, store);

		expect(store.outgoing_msg.length).toBe(1);
		expect(store.outgoing_msg[0].directus_file_id).toBe("mock-uploaded-file-id");
		expect(store.outgoing_msg[0].directus_preview_id).toBeNull(); // No preview ID
	});
});
