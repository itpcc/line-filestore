import { describe, expect, test, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import { extractGDriveFileId, extractGDriveFileIds, fetchGDriveFileMeta, getGDriveClient, resetGDriveClientCache } from "./gdrive";

describe("Google Drive Link Extractor", () => {
	test("Extracts file ID from standard /file/d/{id} links", () => {
		expect(extractGDriveFileId("https://drive.google.com/file/d/1A2B3C4D5E6F/view?usp=sharing")).toBe("1A2B3C4D5E6F");
		expect(extractGDriveFileId("Check out this file: https://docs.google.com/file/d/XYZ_123-abc/view")).toBe("XYZ_123-abc");
	});

	test("Extracts file ID from uc?id={id} and open?id={id} links", () => {
		expect(extractGDriveFileId("https://drive.google.com/uc?id=abc123DEF456&export=download")).toBe("abc123DEF456");
		expect(extractGDriveFileId("https://drive.google.com/open?id=MY_FILE_ID_99")).toBe("MY_FILE_ID_99");
	});

	test("Extracts multiple file IDs from text with multiple links", () => {
		const text = "Link 1: https://drive.google.com/file/d/ID_ONE/view and Link 2: https://drive.google.com/file/d/ID_TWO/view";
		expect(extractGDriveFileIds(text)).toEqual(["ID_ONE", "ID_TWO"]);
	});

	test("Returns null for non-Google Drive links or regular text", () => {
		expect(extractGDriveFileId("Hello world")).toBeNull();
		expect(extractGDriveFileId("https://example.com/file.pdf")).toBeNull();
		expect(extractGDriveFileId("")).toBeNull();
	});
});

describe("Google Drive Metadata & Size Enforcement", () => {
	let origEnvSize: string | undefined;

	beforeAll(() => {
		origEnvSize = process.env.GDRIVE_FILE_SIZE_MAX_MB;
	});

	beforeEach(() => {
		resetGDriveClientCache();
	});

	afterAll(() => {
		if (origEnvSize !== undefined) {
			process.env.GDRIVE_FILE_SIZE_MAX_MB = origEnvSize;
		} else {
			delete process.env.GDRIVE_FILE_SIZE_MAX_MB;
		}
		resetGDriveClientCache();
	});

	test("Throws error if file size exceeds GDRIVE_FILE_SIZE_MAX_MB", async () => {
		process.env.GDRIVE_FILE_SIZE_MAX_MB = "10"; // 10 MB limit

		// Mock googleapis
		const { google } = require("googleapis");
		const origDrive = google.drive;
		google.drive = mock(() => ({
			files: {
				get: async () => ({
					data: {
						id: "large_file_id",
						name: "large_document.iso",
						mimeType: "application/x-iso9660-image",
						size: (15 * 1024 * 1024).toString() // 15 MB
					}
				})
			}
		}));

		try {
			await expect(fetchGDriveFileMeta("large_file_id")).rejects.toThrow("exceeds maximum allowed limit of 10 MB");
		} finally {
			google.drive = origDrive;
		}
	});

	test("Fetches metadata successfully if within size limit", async () => {
		process.env.GDRIVE_FILE_SIZE_MAX_MB = "50"; // 50 MB limit

		const { google } = require("googleapis");
		const origDrive = google.drive;
		google.drive = mock(() => ({
			files: {
				get: async () => ({
					data: {
						id: "valid_file_id",
						name: "sample_report.pdf",
						mimeType: "application/pdf",
						size: (5 * 1024 * 1024).toString() // 5 MB
					}
				})
			}
		}));

		try {
			const meta = await fetchGDriveFileMeta("valid_file_id");
			expect(meta.id).toBe("valid_file_id");
			expect(meta.name).toBe("sample_report.pdf");
			expect(meta.mimeType).toBe("application/pdf");
			expect(meta.size).toBe(5 * 1024 * 1024);
		} finally {
			google.drive = origDrive;
		}
	});
});

describe("Google Drive Client Caching", () => {
	test("Caches client instance and returns same instance for same config", () => {
		resetGDriveClientCache();
		process.env.GDRIVE_API_KEY = "key_1";
		const client1 = getGDriveClient();
		const client2 = getGDriveClient();
		expect(client1).toBe(client2);

		// Renew when API key changes
		process.env.GDRIVE_API_KEY = "key_2";
		const client3 = getGDriveClient();
		expect(client3).not.toBe(client1);

		delete process.env.GDRIVE_API_KEY;
		resetGDriveClientCache();
	});

	test("Initializes client using OAuth2 user credentials when provided", () => {
		resetGDriveClientCache();
		process.env.GDRIVE_OAUTH_CLIENT_ID = "mock_client_id";
		process.env.GDRIVE_OAUTH_CLIENT_SECRET = "mock_client_secret";
		process.env.GDRIVE_OAUTH_REFRESH_TOKEN = "mock_refresh_token";

		const client = getGDriveClient();
		expect(client).toBeDefined();

		delete process.env.GDRIVE_OAUTH_CLIENT_ID;
		delete process.env.GDRIVE_OAUTH_CLIENT_SECRET;
		delete process.env.GDRIVE_OAUTH_REFRESH_TOKEN;
		resetGDriveClientCache();
	});
});
