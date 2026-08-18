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

	test("Sanitizes filename correctly with sanitizeFilename", () => {
		const { sanitizeFilename } = require("./downloading");
		expect(sanitizeFilename("hello/world?.pdf")).toBe("hello_world_.pdf");
		expect(sanitizeFilename("report:2026<test>|file.docx")).toBe("report_2026_test_file.docx");
		expect(sanitizeFilename("aux.txt")).toBe("_");
	});

	test("Directus upload uses sanitized originalName for files", async () => {
		const uploadedFilenames: string[] = [];

		// Intercept directus request to capture uploaded filenames
		const { directus } = require("../directus");
		const origRequest = directus.request;
		directus.request = mock(async (action: any) => {
			const options = typeof action === "function" ? action({ request: () => {} }) : action;
			const bodyFormData = options?.body ?? action?.body;
			if (bodyFormData && typeof bodyFormData.get === "function") {
				const fileObj = bodyFormData.get("file");
				if (fileObj && fileObj.name) {
					uploadedFilenames.push(fileObj.name);
				}
			}
			return { id: "mock-directus-id-123" };
		});

		globalThis.fetch = mock(async (url: string) => {
			return {
				status: 200,
				blob: async () => new Blob(["doc-content"], { type: "application/pdf" })
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
				webhookEventId: "evt_orig_123",
				replyToken: "reply_orig_123",
				message: {
					type: "file",
					id: "msg_orig_123",
					fileName: "my/original?document.pdf",
					fileSize: 54321,
					contentProvider: {
						type: "external",
						originalContentUrl: "https://example.com/doc.pdf"
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

		directus.request = origRequest;

		// Stored in local path remains the same (truncated file id filename), but uploaded to Directus with sanitized originalName
		expect(uploadedFilenames[0]).toBe("my_original_document.pdf");
		expect(uploadedFilenames[1]).toBe("original_document-preview.webp");
	});

	test("Processes Google Drive links in text messages", async () => {
		const { resetGDriveClientCache } = require("../gdrive");
		resetGDriveClientCache();
		const uploadedFilenames: string[] = [];
		const { directus } = require("../directus");
		const origRequest = directus.request;
		directus.request = mock(async (action: any) => {
			const options = typeof action === "function" ? action({ request: () => {} }) : action;
			const bodyFormData = options?.body ?? action?.body;
			if (bodyFormData && typeof bodyFormData.get === "function") {
				const fileObj = bodyFormData.get("file");
				if (fileObj && fileObj.name) {
					uploadedFilenames.push(fileObj.name);
				}
			}
			return { id: "mock-gdrive-directus-id" };
		});

		const { google } = require("googleapis");
		const origDrive = google.drive;
		google.drive = mock(() => ({
			files: {
				get: async (params: any) => {
					if (params?.alt === "media") {
						return { data: new TextEncoder().encode("gdrive-pdf-bytes").buffer };
					}
					return {
						data: {
							id: "gdrive_doc_id",
							name: "gdrive_report?.pdf",
							mimeType: "application/pdf",
							size: "1000"
						}
					};
				}
			}
		}));

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
				webhookEventId: "evt_gdrive_123",
				replyToken: "reply_gdrive_123",
				message: {
					type: "text",
					id: "msg_gdrive_123",
					quoteToken: "quote_gdrive_123",
					text: "Here is the link: https://drive.google.com/file/d/gdrive_doc_id/view"
				},
				timestamp: Date.now(),
				source: {
					type: "user",
					userId: "user_abc"
				}
			}
		};

		await processDownload(msg, store);

		directus.request = origRequest;
		google.drive = origDrive;

		expect(store.outgoing_msg.length).toBe(1);
		expect(uploadedFilenames[0]).toBe("gdrive_report_.pdf");
	});
});

