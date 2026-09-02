#!/usr/bin/env python3
import os
import sys
import json
import csv
import urllib.parse
from datetime import datetime, timezone
import mimetypes

# We use standard urllib to avoid requiring external dependencies like 'requests'
# to ensure the script runs smoothly on any remote server with standard Python 3.
import urllib.request
import urllib.error

def load_env(env_path):
    """Parses .env file manually to stay zero-dependency."""
    config = {}
    if not os.path.exists(env_path):
        return config
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, val = line.split('=', 1)
                key = key.strip()
                val = val.strip()
                if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                config[key] = val
    return config

def directus_request(url, method='GET', data=None, headers=None):
    """Helper to perform HTTP requests to Directus API."""
    if headers is None:
        headers = {}
    
    req_data = None
    if data is not None and not isinstance(data, bytes):
        req_data = json.dumps(data).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    elif isinstance(data, bytes):
        req_data = data

    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8')
        try:
            err_json = json.loads(err_body)
            err_msg = json.dumps(err_json)
        except Exception:
            err_msg = err_body
        raise Exception(f"HTTP Error {e.code}: {err_msg}")
    except Exception as e:
        raise Exception(f"Connection Error: {str(e)}")

def upload_file_to_directus(host, token, file_path, filename):
    """Uploads a local file to Directus files store using multipart/form-data."""
    boundary = '----DirectusMigrationBoundary'
    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type is None:
        mime_type = 'application/octet-stream'

    with open(file_path, 'rb') as f:
        file_bytes = f.read()

    body = []
    # Build multipart boundary
    body.append(f'--{boundary}'.encode('utf-8'))
    body.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode('utf-8'))
    body.append(f'Content-Type: {mime_type}\r\n'.encode('utf-8'))
    body.append(file_bytes)
    body.append(f'\r\n--{boundary}--'.encode('utf-8'))
    
    payload = b'\r\n'.join(body)
    
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Content-Length': str(len(payload))
    }
    
    url = f"{host.rstrip('/')}/files"
    status, res = directus_request(url, method='POST', data=payload, headers=headers)
    return res['data']['id']

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    
    # Load env configuration
    env_config = load_env(os.path.join(project_dir, '.env'))
    
    filestore_path = env_config.get('FILESTORE_PATH')
    directus_host = env_config.get('DIRECTUS_HOST')
    directus_token = env_config.get('DIRECTUS_TOKEN')
    
    if not filestore_path:
        print("Error: FILESTORE_PATH not defined in .env", file=sys.stderr)
        sys.exit(1)
    if not directus_host:
        print("Error: DIRECTUS_HOST not defined in .env", file=sys.stderr)
        sys.exit(1)
    if not directus_token:
        print("Error: DIRECTUS_TOKEN not defined in .env", file=sys.stderr)
        sys.exit(1)
        
    print(f"Project path: {project_dir}")
    print(f"Filestore path: {filestore_path}")
    print(f"Directus host: {directus_host}")
    
    # Create CSV log file in project dir or current directory
    csv_log_path = os.path.join(project_dir, 'migration_log.csv')
    migrated_msg_ids = set()
    
    # Read existing migration log if present to skip already migrated messages
    if os.path.exists(csv_log_path):
        with open(csv_log_path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.reader(f)
            # Skip header
            try:
                next(reader)
                for row in reader:
                    if row and row[5] == 'success':
                        migrated_msg_ids.add(row[0])
            except StopIteration:
                pass
    else:
        # Write CSV header
        with open(csv_log_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['message_id', 'meta_file', 'directus_id', 'file_id', 'preview_file_id', 'status', 'error'])
            
    print(f"Loaded {len(migrated_msg_ids)} already migrated messages from log.")
    
    # Scan for metadata files
    if not os.path.exists(filestore_path):
        print(f"Error: Filestore path does not exist: {filestore_path}", file=sys.stderr)
        sys.exit(1)
        
    meta_files = [f for f in os.listdir(filestore_path) if f.startswith('msg-') and f.endswith('.meta.json')]
    print(f"Found {len(meta_files)} metadata files to process.")
    
    migrated_count = 0
    skipped_count = 0
    error_count = 0
    
    for idx, meta_file in enumerate(meta_files, 1):
        file_path = os.path.join(filestore_path, meta_file)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                body = json.load(f)
        except Exception as e:
            print(f"[{idx}/{len(meta_files)}] Error parsing {meta_file}: {e}")
            error_count += 1
            continue
            
        # Parse fields
        try:
            event_obj = body['event']
            destination = event_obj.get('destination')
            inner_event = event_obj.get('event', {})
            msg_obj = inner_event.get('message', {})
            message_id = msg_obj.get('id')
            message_type = msg_obj.get('type')
            timestamp_raw = inner_event.get('timestamp')
            
            source = inner_event.get('source', {})
            sender_id = source.get('userId')
        except KeyError as e:
            print(f"[{idx}/{len(meta_files)}] Invalid metadata format in {meta_file}: missing key {e}")
            error_count += 1
            continue
            
        if not message_id:
            print(f"[{idx}/{len(meta_files)}] Skipping {meta_file}: No message ID found.")
            skipped_count += 1
            continue
            
        if message_id in migrated_msg_ids:
            skipped_count += 1
            continue
            
        print(f"[{idx}/{len(meta_files)}] Migrating message: {message_id} ({message_type})...")
        
        # Verify if message already exists in Directus to avoid double upload
        headers = {'Authorization': f'Bearer {directus_token}'}
        query_url = f"{directus_host.rstrip('/')}/items/line_messages?filter[message_id][_eq]={message_id}"
        try:
            _, check_res = directus_request(query_url, method='GET', headers=headers)
            if check_res.get('data') and len(check_res['data']) > 0:
                existing_item_id = check_res['data'][0]['id']
                print(f"  -> Message already exists in Directus with ID: {existing_item_id}")
                # Save to CSV log as success
                with open(csv_log_path, 'a', newline='', encoding='utf-8') as lf:
                    writer = csv.writer(lf)
                    writer.writerow([message_id, meta_file, existing_item_id, '', '', 'success', 'Already exists in Directus'])
                migrated_msg_ids.add(message_id)
                skipped_count += 1
                continue
        except Exception as e:
            print(f"  -> Warning checking Directus state: {e}")
            
        # Determine text content
        if message_type == 'text':
            text_content = msg_obj.get('text', '')
        else:
            text_content = body.get('message', '').strip()
            
        # Parse timestamp
        try:
            timestamp = datetime.fromtimestamp(timestamp_raw / 1000.0, tz=timezone.utc).isoformat()
        except Exception:
            timestamp = datetime.now(timezone.utc).isoformat()
            
        # Parse media files from "message" field if applicable
        filenames = []
        message_field = body.get('message', '')
        for line in message_field.splitlines():
            line = line.strip()
            if line and line != 'File store:':
                filenames.append(line)
                
        main_file_id = None
        preview_file_id = None
        upload_error = None
        
        # Upload associated files if present
        for fn in filenames:
            media_file_path = os.path.join(filestore_path, fn)
            if not os.path.exists(media_file_path):
                print(f"  -> Warning: media file '{fn}' not found in directory.")
                continue
                
            try:
                print(f"  -> Uploading media: {fn}...")
                fid = upload_file_to_directus(directus_host, directus_token, media_file_path, fn)
                if '-preview' in fn:
                    preview_file_id = fid
                else:
                    main_file_id = fid
                print(f"  -> Uploaded: {fn} (Directus File ID: {fid})")
            except Exception as e:
                print(f"  -> Error uploading media {fn}: {e}")
                upload_error = str(e)
                
        if upload_error and not main_file_id:
            # If we had upload errors and couldn't even upload the main file, log failure and retry later
            with open(csv_log_path, 'a', newline='', encoding='utf-8') as lf:
                writer = csv.writer(lf)
                writer.writerow([message_id, meta_file, '', '', '', 'failed', f"Media upload error: {upload_error}"])
            error_count += 1
            continue
            
        # Insert metadata record into Directus
        directus_payload = {
            "message_id": message_id,
            "destination": destination,
            "sender_id": sender_id,
            "message_type": [message_type] if isinstance(message_type, str) else message_type,
            "text_content": text_content,
            "timestamp": timestamp,
            "timestamp_raw": timestamp_raw,
            "file": main_file_id,
            "file_preview": preview_file_id,
            "payload": body
        }
        
        insert_url = f"{directus_host.rstrip('/')}/items/line_messages"
        try:
            _, insert_res = directus_request(insert_url, method='POST', data=directus_payload, headers=headers)
            directus_item_id = insert_res['data']['id']
            print(f"  -> Created Directus record: {directus_item_id}")
            
            # Log successful migration to CSV
            with open(csv_log_path, 'a', newline='', encoding='utf-8') as lf:
                writer = csv.writer(lf)
                writer.writerow([message_id, meta_file, directus_item_id, main_file_id or '', preview_file_id or '', 'success', ''])
            
            migrated_count += 1
            migrated_msg_ids.add(message_id)
        except Exception as e:
            print(f"  -> Error creating Directus record: {e}")
            with open(csv_log_path, 'a', newline='', encoding='utf-8') as lf:
                writer = csv.writer(lf)
                writer.writerow([message_id, meta_file, '', main_file_id or '', preview_file_id or '', 'failed', f"Directus insert error: {str(e)}"])
            error_count += 1
            
    print("\nMigration Completed.")
    print(f"Total processed: {len(meta_files)}")
    print(f"Migrated successfully: {migrated_count}")
    print(f"Skipped (already migrated): {skipped_count}")
    print(f"Failed: {error_count}")
    print(f"Log updated at: {csv_log_path}")

if __name__ == '__main__':
    main()
