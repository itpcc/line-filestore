#!/usr/bin/env python3
import os
import sys
import json
import subprocess
import tempfile
import io

try:
    from PIL import Image
except ImportError:
    print("Error: The 'Pillow' library is required to run this script. Please install it using:")
    print("       pip install Pillow")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Error: The 'requests' library is required to run this script. Please install it using:")
    print("       pip install requests")
    sys.exit(1)

def load_env(env_path):
    """Parses .env file manually."""
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
    """Helper to perform HTTP requests to Directus API using requests."""
    if headers is None:
        headers = {}
    
    try:
        if data is not None and not isinstance(data, (bytes, str)):
            response = requests.request(method, url, json=data, headers=headers)
        else:
            response = requests.request(method, url, data=data, headers=headers)
        
        response.raise_for_status()
        return response.status_code, response.json()
    except requests.exceptions.HTTPError as e:
        try:
            err_json = response.json()
            err_msg = json.dumps(err_json)
        except Exception:
            err_msg = response.text
        raise Exception(f"HTTP Error {response.status_code}: {err_msg}")
    except Exception as e:
        raise Exception(f"Connection Error: {str(e)}")

def download_file_bytes(host, token, file_id):
    """Downloads file bytes from Directus."""
    url = f"{host.rstrip('/')}/assets/{file_id}"
    headers = {'Authorization': f'Bearer {token}'}
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        return response.content
    except Exception as e:
        raise Exception(f"Download error: {e}")

def upload_preview_to_directus(host, token, preview_bytes, filename):
    """Uploads preview bytes to Directus file store."""
    url = f"{host.rstrip('/')}/files"
    headers = {'Authorization': f'Bearer {token}'}
    files = {
        'file': (filename, preview_bytes, 'image/webp')
    }
    try:
        response = requests.post(url, headers=headers, files=files)
        response.raise_for_status()
        res = response.json()
        return res['data']['id']
    except Exception as e:
        raise Exception(f"Upload error: {e}")

def process_image(file_bytes):
    """Resizes image to max 400x400 and converts to WebP using Pillow."""
    img = Image.open(io.BytesIO(file_bytes))
    img.thumbnail((400, 400))
    out_io = io.BytesIO()
    img.save(out_io, format='WEBP', quality=80)
    return out_io.getvalue()

def process_video(file_bytes, ext):
    """Extracts first frame from video using ffmpeg and converts to WebP using Pillow."""
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        raise Exception("ffmpeg is not installed or not in PATH. Cannot process video files.")

    # Write video to temporary file
    temp_dir = './tmp'
    os.makedirs(temp_dir, exist_ok=True)
    
    with tempfile.NamedTemporaryFile(suffix=f'.{ext}', dir=temp_dir, delete=False) as temp_video:
        temp_video.write(file_bytes)
        temp_video_path = temp_video.name

    try:
        # Extract frame at 00:00:01
        cmd = [
            "ffmpeg", "-y", "-loglevel", "quiet", "-i", temp_video_path,
            "-ss", "00:00:01", "-vframes", "1",
            "-f", "image2", "-c:v", "png", "-"
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout_data = proc.stdout
        
        # Fallback to no seek
        if proc.returncode != 0 or not stdout_data:
            cmd_fallback = [
                "ffmpeg", "-y", "-loglevel", "quiet", "-i", temp_video_path,
                "-vframes", "1",
                "-f", "image2", "-c:v", "png", "-"
            ]
            proc = subprocess.run(cmd_fallback, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout_data = proc.stdout

        if not stdout_data:
            raise Exception(f"ffmpeg extraction failed: {proc.stderr.decode('utf-8', errors='ignore')}")

        # Resize with Pillow
        img = Image.open(io.BytesIO(stdout_data))
        img.thumbnail((400, 400))
        out_io = io.BytesIO()
        img.save(out_io, format='WEBP', quality=80)
        return out_io.getvalue()
    finally:
        if os.path.exists(temp_video_path):
            os.remove(temp_video_path)

def process_pdf(file_bytes, stirling_url):
    """Converts first page of PDF to WebP using Stirling PDF API."""
    url = f"{stirling_url.rstrip('/')}/api/v1/convert/pdf/img"
    files = {
        'fileInput': ('document.pdf', file_bytes, 'application/pdf')
    }
    data = {
        'imageFormat': 'webp',
        'singleOrMultiple': 'single',
        'pageNumbers': '1',
        'dpi': '72'
    }
    try:
        response = requests.post(url, files=files, data=data)
        response.raise_for_status()
        return response.content
    except requests.exceptions.HTTPError as e:
        raise Exception(f"Stirling PDF HTTP Error {response.status_code}: {response.text}")
    except Exception as e:
        raise Exception(f"Stirling PDF request error: {e}")

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    
    env_config = load_env(os.path.join(project_dir, '.env'))
    directus_host = env_config.get('DIRECTUS_HOST')
    directus_token = env_config.get('DIRECTUS_TOKEN')
    stirling_pdf_url = env_config.get('STIRLING_PDF_URL')
    filestore_path = env_config.get('FILESTORE_PATH')
    
    if not directus_host or not directus_token:
        print("Error: DIRECTUS_HOST and DIRECTUS_TOKEN must be defined in .env", file=sys.stderr)
        sys.exit(1)
        
    print(f"Directus host: {directus_host}")
    print(f"Stirling PDF API URL: {stirling_pdf_url or 'Not configured'}")
    
    # Query for records missing previews but having a file
    headers = {'Authorization': f'Bearer {directus_token}'}
    query_url = f"{directus_host.rstrip('/')}/items/line_messages?limit=1000&filter[file_preview][_null]=true&filter[file][_nnull]=true&fields=id,message_type,file.*"
    
    print("\nFetching records from Directus missing previews...")
    try:
        status, res = directus_request(query_url, method='GET', headers=headers)
        records = res.get('data', [])
    except Exception as e:
        print(f"Error querying Directus: {e}", file=sys.stderr)
        sys.exit(1)
        
    if not records:
        print("No records found missing thumbnails.")
        sys.exit(0)
        
    print(f"Found {len(records)} records to process.")
    
    success_count = 0
    fail_count = 0
    
    for idx, rec in enumerate(records, 1):
        rec_id = rec['id']
        msg_type = rec.get('message_type')
        file_obj = rec.get('file')
        
        if not file_obj or not isinstance(file_obj, dict):
            # Safe boundary check
            continue
            
        file_id = file_obj['id']
        filename = file_obj.get('filename_download') or f"file-{file_id}"
        
        name, ext = os.path.splitext(filename.lower())
        ext = ext.lstrip('.')
        
        is_img = msg_type == 'image' or ext in ['jpg', 'jpeg', 'png', 'gif', 'apng', 'webp']
        is_vid = msg_type == 'video' or ext in ['mp4', 'wmv', 'webm']
        is_pdf = ext == 'pdf'
        
        if not (is_img or is_vid or is_pdf):
            continue
            
        print(f"[{idx}/{len(records)}] Processing {filename} ({msg_type or ext}) for record {rec_id}...")
        
        # 1. Obtain file bytes (check local path first if configured, else download)
        file_bytes = None
        if filestore_path and os.path.exists(filestore_path):
            local_path = os.path.join(filestore_path, filename)
            if os.path.exists(local_path):
                try:
                    with open(local_path, 'rb') as lf:
                        file_bytes = lf.read()
                    print("  -> Loaded file from local filestore.")
                except Exception as e:
                    print(f"  -> Warning: failed to read local file: {e}")
                    
        if file_bytes is None:
            try:
                print("  -> Downloading original file from Directus...")
                file_bytes = download_file_bytes(directus_host, directus_token, file_id)
            except Exception as e:
                print(f"  -> Error: failed to download original file: {e}")
                fail_count += 1
                continue
                
        # 2. Generate preview bytes
        preview_bytes = None
        preview_filename = f"{name}-preview.webp"
        
        # Implement 3 retries for the generator loop
        for attempt in range(1, 4):
            try:
                if is_img:
                    preview_bytes = process_image(file_bytes)
                elif is_vid:
                    preview_bytes = process_video(file_bytes, ext)
                elif is_pdf:
                    if not stirling_pdf_url:
                        raise Exception("STIRLING_PDF_URL is not set in .env. Cannot process PDF file.")
                    preview_bytes = process_pdf(file_bytes, stirling_pdf_url)
                break
            except Exception as e:
                print(f"  -> Generation attempt {attempt} failed: {e}")
                if attempt == 3:
                    print(f"  -> Error: failed to generate thumbnail for record {rec_id}.")
                
        if not preview_bytes:
            fail_count += 1
            continue
            
        # 3. Save preview locally if FILESTORE_PATH is set
        if filestore_path and os.path.exists(filestore_path):
            local_preview_path = os.path.join(filestore_path, preview_filename)
            try:
                with open(local_preview_path, 'wb') as pf:
                    pf.write(preview_bytes)
                print(f"  -> Saved preview locally: {preview_filename}")
            except Exception as e:
                print(f"  -> Warning: failed to write preview locally: {e}")
                
        # 4. Upload preview to Directus and Update Message Record
        try:
            print("  -> Uploading preview to Directus...")
            preview_id = upload_preview_to_directus(directus_host, directus_token, preview_bytes, preview_filename)
            
            print(f"  -> Linking preview file ID {preview_id} to record...")
            update_url = f"{directus_host.rstrip('/')}/items/line_messages/{rec_id}"
            update_headers = {
                'Authorization': f'Bearer {directus_token}',
                'Content-Type': 'application/json'
            }
            directus_request(update_url, method='PATCH', data={"file_preview": preview_id}, headers=update_headers)
            print(f"  -> Success: Thumbnail generated and linked for record {rec_id}!")
            success_count += 1
        except Exception as e:
            print(f"  -> Error updating Directus with preview: {e}")
            fail_count += 1
            
    print(f"\nRegeneration Finished.")
    print(f"Successfully processed: {success_count}")
    print(f"Failed to process: {fail_count}")

if __name__ == '__main__':
    main()
