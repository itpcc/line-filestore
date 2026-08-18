import { google, drive_v3 } from 'googleapis';
import { existsSync, readFileSync, statSync } from 'fs';

let cachedDriveClient: drive_v3.Drive | null = null;
let cachedAuth: any = null;
let cachedCredKey: string | null = null;

export function resetGDriveClientCache(): void {
	cachedDriveClient = null;
	cachedAuth = null;
	cachedCredKey = null;
}

export function extractGDriveFileId(text: string): string | null {
	if (!text) return null;

	// Matches /file/d/{fileId}
	const fileDMatch = text.match(/(?:drive|docs)\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
	if (fileDMatch && fileDMatch[1]) {
		return fileDMatch[1];
	}

	// Matches uc?id={fileId} or open?id={fileId}
	const idParamMatch = text.match(/drive\.google\.com\/(?:uc|open)\?[^#]*\bid=([a-zA-Z0-9_-]+)/i);
	if (idParamMatch && idParamMatch[1]) {
		return idParamMatch[1];
	}

	return null;
}

export function getGDriveClient(): drive_v3.Drive {
	const oauthClientId = process.env.GDRIVE_OAUTH_CLIENT_ID || '';
	const oauthClientSecret = process.env.GDRIVE_OAUTH_CLIENT_SECRET || '';
	const oauthRefreshToken = process.env.GDRIVE_OAUTH_REFRESH_TOKEN || '';
	const serviceAccountConfig = process.env.GDRIVE_SERVICE_ACCOUNT_JSON || '';
	const apiKey = process.env.GDRIVE_API_KEY || '';

	let currentMtime = 0;
	if (serviceAccountConfig && existsSync(serviceAccountConfig)) {
		try {
			currentMtime = statSync(serviceAccountConfig).mtimeMs;
		} catch (_) {}
	}

	const currentCredKey = `${oauthClientId}:${oauthClientSecret}:${oauthRefreshToken}:${serviceAccountConfig}:${currentMtime}:${apiKey}`;

	if (cachedDriveClient && cachedCredKey === currentCredKey) {
		return cachedDriveClient;
	}

	let driveClient: drive_v3.Drive;
	let authClient: any = null;

	if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
		authClient = new google.auth.OAuth2(
			oauthClientId,
			oauthClientSecret
		);
		authClient.setCredentials({
			refresh_token: oauthRefreshToken
		});
		driveClient = google.drive({ version: 'v3', auth: authClient });
	} else if (serviceAccountConfig) {
		let credentials: any = null;
		if (existsSync(serviceAccountConfig)) {
			const fileContent = readFileSync(serviceAccountConfig, 'utf-8');
			credentials = JSON.parse(fileContent);
		} else if (serviceAccountConfig.trim().startsWith('{')) {
			credentials = JSON.parse(serviceAccountConfig);
		}

		if (credentials) {
			authClient = new google.auth.GoogleAuth({
				credentials,
				scopes: ['https://www.googleapis.com/auth/drive.readonly']
			});
			driveClient = google.drive({ version: 'v3', auth: authClient });
		} else if (apiKey) {
			driveClient = google.drive({ version: 'v3', auth: apiKey });
		} else {
			driveClient = google.drive({ version: 'v3' });
		}
	} else if (apiKey) {
		driveClient = google.drive({ version: 'v3', auth: apiKey });
	} else {
		driveClient = google.drive({ version: 'v3' });
	}

	cachedDriveClient = driveClient;
	cachedAuth = authClient;
	cachedCredKey = currentCredKey;

	return cachedDriveClient;
}

export type GDriveFileMeta = {
	id: string;
	name: string;
	mimeType: string;
	size?: number;
};

export async function fetchGDriveFileMeta(fileId: string): Promise<GDriveFileMeta> {
	const drive = getGDriveClient();
	const res = await drive.files.get({
		fileId,
		fields: 'id, name, mimeType, size'
	});

	const file = res.data;
	if (!file || !file.id || !file.name) {
		throw new Error(`Google Drive file ${fileId} not found or inaccessible`);
	}

	const fileSize = file.size ? parseInt(file.size, 10) : undefined;
	const maxSizeMbStr = process.env.GDRIVE_FILE_SIZE_MAX_MB;
	if (maxSizeMbStr && fileSize !== undefined) {
		const maxSizeMb = parseFloat(maxSizeMbStr);
		if (!isNaN(maxSizeMb)) {
			const maxSizeBytes = maxSizeMb * 1024 * 1024;
			if (fileSize > maxSizeBytes) {
				throw new Error(
					`File size (${(fileSize / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed limit of ${maxSizeMb} MB`
				);
			}
		}
	}

	return {
		id: file.id,
		name: file.name,
		mimeType: file.mimeType || 'application/octet-stream',
		size: fileSize
	};
}

export async function downloadGDriveFile(fileId: string): Promise<Blob> {
	const drive = getGDriveClient();
	const res = await drive.files.get(
		{ fileId, alt: 'media' },
		{ responseType: 'arraybuffer' }
	);

	const buffer = Buffer.from(res.data as ArrayBuffer);
	return new Blob([buffer]);
}
