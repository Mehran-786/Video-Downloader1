# ==========================================
# GEVENT MONKEY PATCHING (MANDATORY TO BE AT THE VERY TOP)
# This fixes the MonkeyPatchWarning and prevents RecursionError with Gunicorn
# ==========================================
from gevent import monkey
monkey.patch_all()

import os
import re
import time
import socket
import logging
import shutil
import subprocess
import threading
import ipaddress
from urllib.parse import urlparse, urljoin
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from flask_compress import Compress
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
import yt_dlp
import requests

def get_ffmpeg_path():
    """Locates ffmpeg executable from PATH or bundled imageio-ffmpeg."""
    path = shutil.which('ffmpeg')
    if path:
        return path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    return 'ffmpeg'

# Initialize Flask & Middleware
app = Flask(__name__)

# Apply ProxyFix to correctly get client IP behind reverse proxies (like Render load balancers)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

# ==========================================
# 🛡️ 1. STRICT CORS POLICY (SECURITY) 🛡️
# ==========================================
CORS(app, resources={r"/api/*": {"origins": ["https://video-downloader-xi-two.vercel.app/"]}})

compress = Compress()
compress.init_app(app)

# ==========================================
# 🛑 2. RATE LIMITING (ANTI-DDoS & SPAM PROTECTION) 🛑
# Supports distributed Redis backend when available (Gunicorn multi-worker)
# ==========================================
storage_uri = os.environ.get("REDIS_URL") or os.environ.get("REDIS_TLS_URL") or "memory://"
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["5000 per day", "100 per minute"],
    storage_uri=storage_uri
)

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ==========================================
# 🔒 3. ANTI-SSRF & SAFE URL VALIDATION 🔒
# ==========================================
BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("::ffff:0:0/96"),
]

ALLOWED_HOST_SUFFIXES = (
    # Meta / Facebook / Instagram / Threads
    "fbcdn.net", "facebook.com", "fb.watch", "fb.gg",
    "cdninstagram.com", "instagram.com", "instagram.net", "instagr.am",
    "threads.net",
    # TikTok / ByteDance
    "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktok.com",
    "byteoversea.com", "ibyteimg.com", "musical.ly",
    # Google / YouTube
    "googlevideo.com", "ytimg.com", "youtube.com", "youtu.be",
    "googleusercontent.com",
    # Snapchat
    "sc-cdn.net", "snapchat.com",
    # Standard Media CDNs used by verified platforms
    "akamaihd.net", "akamaized.net", "cloudfront.net", "fastly.net"
)

def is_ip_blocked(ip_obj) -> bool:
    """Checks if an IP address falls in private, loopback, link-local or reserved ranges."""
    return (
        ip_obj.is_private or 
        ip_obj.is_loopback or 
        ip_obj.is_link_local or 
        ip_obj.is_multicast or 
        ip_obj.is_reserved or 
        any(ip_obj in net for net in BLOCKED_NETWORKS)
    )

def is_safe_web_url(url: str) -> bool:
    """Validates public HTTP/HTTPS URLs (used for user input /api/download & unshortener hops)."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        hostname = parsed.hostname.lower()
        if hostname in ("localhost", "127.0.0.1", "::1") or hostname.endswith(".local") or hostname.endswith(".internal"):
            return False

        # Verify DNS resolution points to a public IP
        try:
            addr_info = socket.getaddrinfo(hostname, None)
            for res in addr_info:
                ip = ipaddress.ip_address(res[4][0])
                if is_ip_blocked(ip):
                    return False
        except socket.gaierror:
            return False

        return True
    except Exception:
        return False

def is_safe_media_url(url: str) -> bool:
    """Validates that a URL is a safe media streaming URL from an authorized CDN/platform (used for /api/direct)."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        hostname = parsed.hostname.lower()

        # Reject local/internal hostnames
        if hostname in ("localhost", "127.0.0.1", "::1") or hostname.endswith(".local") or hostname.endswith(".internal"):
            return False

        # Enforce authorized media CDN domain allow-list
        is_allowed = any(hostname == domain or hostname.endswith("." + domain) for domain in ALLOWED_HOST_SUFFIXES)
        if not is_allowed:
            return False

        # Verify resolved IP addresses are not private/reserved
        try:
            addr_info = socket.getaddrinfo(hostname, None)
            for res in addr_info:
                ip = ipaddress.ip_address(res[4][0])
                if is_ip_blocked(ip):
                    return False
        except socket.gaierror:
            pass

        return True
    except Exception:
        return False

# ==========================================
# 🚀 4. TTL CACHE 🚀
# ==========================================
class SimpleTTLCache:
    def __init__(self, ttl_seconds=1800):
        self.cache = {}
        self.ttl = ttl_seconds

    def get(self, key):
        if key in self.cache:
            entry = self.cache[key]
            if time.time() - entry['timestamp'] < self.ttl:
                logging.info(f"[CACHE HIT] Serving from memory: {key}")
                return entry['data']
            else:
                del self.cache[key]
        return None

    def set(self, key, value):
        self.cache[key] = {'data': value, 'timestamp': time.time()}

video_cache = SimpleTTLCache(ttl_seconds=1800)

http_session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=200, pool_maxsize=500)
http_session.mount("http://", adapter)
http_session.mount("https://", adapter)

def resolve_short_url(url):
    """
    Manually resolves redirects for shortened URLs across all platforms
    (Facebook, TikTok, YouTube Shorts, Instagram, Snapchat, Threads, bit.ly, etc.)
    with strict SSRF redirect hop validation.
    """
    if not url or not is_safe_web_url(url):
        return url

    short_patterns = [
        "/share/", "fb.watch", "fb.gg", "facebook.com/share",
        "vm.tiktok.com", "vt.tiktok.com", "tiktok.com/t/",
        "youtu.be", "youtube.com/shorts",
        "instagr.am", "instagram.com/share", "instagram.com/reel",
        "snapchat.com/t/", "t.co", "bit.ly", "tinyurl.com"
    ]

    is_short = any(pattern in url.lower() for pattern in short_patterns)

    if is_short:
        try:
            logging.info(f"[UNSHORTENER] Resolving shortened URL: {url}")
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
            
            current_url = url
            # Follow redirects up to 6 hops with SSRF checking
            for _ in range(6):
                res = http_session.head(current_url, headers=headers, allow_redirects=False, timeout=6)
                if res.status_code in [301, 302, 303, 307, 308] and 'Location' in res.headers:
                    next_url = res.headers['Location']
                    if next_url.startswith('/'):
                        next_url = urljoin(current_url, next_url)
                    if not is_safe_web_url(next_url):
                        logging.warning(f"[UNSHORTENER BLOCKED] Suspicious redirect target: {next_url}")
                        break
                    current_url = next_url
                else:
                    break
                    
            logging.info(f"[UNSHORTENER] Successfully un-shortened: {url} -> {current_url}")
            return current_url
        except Exception as e:
            logging.error(f"[UNSHORTENER ERROR] Failed to un-shorten URL: {str(e)}")
            
    return url

def get_platform_prefix(url):
    url_low = (url or '').lower()
    if 'youtube' in url_low or 'youtu.be' in url_low:
        return 'YT'
    elif 'instagram' in url_low or 'instagr.am' in url_low:
        return 'Insta'
    elif 'tiktok' in url_low:
        return 'TikTok'
    elif 'snapchat' in url_low:
        return 'Snap'
    elif 'threads' in url_low:
        return 'Threads'
    elif 'facebook' in url_low or 'fb.' in url_low:
        return 'FB'
    return 'Downsocial'

def get_ydl_options():
    cookies_file = os.path.join(os.path.dirname(__file__), 'cookies.txt')
    opts = {
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'nocheckcertificate': False,
        'extract_flat': False,
        'geo_bypass': True,
        'extractor_args': {
            'youtube': {
                'player_client': ['android', 'ios', 'web', 'mweb'],
                'player_skip': ['configs', 'webpage']
            },
            'tiktok': {
                'app_version': ['34.1.2'],
                'manifest_app_version': ['34.1.2']
            }
        },
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Mode': 'navigate'
        }
    }
    if os.path.exists(cookies_file):
        opts['cookiefile'] = cookies_file
        logging.info(f"[COOKIES] Auto-loaded cookies from: {cookies_file}")
    return opts

# ==========================================
# 🎯 ROUTE 1: UNIVERSAL EXTRACTION ENGINE 🎯
# ==========================================
@app.route('/api/download', methods=['GET'])
@limiter.limit("20 per minute")
def download_video():
    url = request.args.get('url')
    
    if not url:
        return jsonify({"success": False, "error": "URL is required!"}), 400

    if not is_safe_web_url(url):
        return jsonify({"success": False, "error": "Invalid or prohibited URL."}), 400

    resolved_url = resolve_short_url(url)
    if not is_safe_web_url(resolved_url):
        return jsonify({"success": False, "error": "Invalid or prohibited redirect destination."}), 400

    cached_data = video_cache.get(resolved_url)
    if cached_data:
        return jsonify(cached_data)

    ydl_opts = get_ydl_options()

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            logging.info(f"[EXTRACTION START] Fetching metadata for: {resolved_url}")
            info = ydl.extract_info(resolved_url, download=False)
            
            if not info:
                raise Exception("Empty metadata received from yt-dlp")

            media_type = "image" if info.get('_type') == 'url_transparent' and not info.get('formats') else "video"
            
            video_high = None
            video_normal = None
            audio_high = None
            audio_normal = None

            formats = info.get('formats', [])

            if formats:
                # 1. Pre-merged formats (contain both video and audio)
                merged_formats = [
                    f for f in formats 
                    if f.get('vcodec') and f.get('vcodec') != 'none' 
                    and f.get('acodec') and f.get('acodec') != 'none'
                    and f.get('url')
                ]
                
                # 2. All video streams (progressive, DASH, or container formats)
                all_video_formats = [
                    f for f in formats 
                    if (f.get('vcodec') and f.get('vcodec') != 'none')
                    or (f.get('ext') in ['mp4', 'webm', 'mkv', 'mov'] and not (f.get('vcodec') == 'none' and f.get('acodec') != 'none'))
                    and f.get('url')
                ]
                
                # 3. Audio-only formats
                audio_only_formats = [
                    f for f in formats 
                    if (not f.get('vcodec') or f.get('vcodec') == 'none') 
                    and f.get('acodec') and f.get('acodec') != 'none'
                    and f.get('url')
                ]
                
                # 4. Any format with audio
                any_audio_formats = [
                    f for f in formats 
                    if f.get('acodec') and f.get('acodec') != 'none'
                    and f.get('url')
                ]

                # Map Video High & Normal
                if merged_formats:
                    sorted_merged = sorted(merged_formats, key=lambda x: (x.get('height') or 0, x.get('tbr') or 0), reverse=True)
                    video_high = sorted_merged[0].get('url')
                    video_normal = sorted_merged[-1].get('url') if len(sorted_merged) > 1 else video_high
                elif all_video_formats:
                    sorted_videos = sorted(all_video_formats, key=lambda x: (x.get('height') or 0, x.get('tbr') or 0), reverse=True)
                    video_high = sorted_videos[0].get('url')
                    video_normal = sorted_videos[-1].get('url') if len(sorted_videos) > 1 else video_high
                else:
                    video_high = info.get('url')
                    video_normal = info.get('url')

                # Map Audio High & Normal
                if audio_only_formats:
                    sorted_audios = sorted(audio_only_formats, key=lambda x: (x.get('abr') or 0, x.get('filesize') or 0), reverse=True)
                    audio_high = sorted_audios[0].get('url')
                    audio_normal = sorted_audios[-1].get('url') if len(sorted_audios) > 1 else audio_high
                elif any_audio_formats:
                    sorted_audios = sorted(any_audio_formats, key=lambda x: (x.get('abr') or 0, x.get('tbr') or 0), reverse=True)
                    audio_high = sorted_audios[0].get('url')
                    audio_normal = sorted_audios[-1].get('url') if len(sorted_audios) > 1 else audio_high
                else:
                    audio_high = video_high
                    audio_normal = video_normal
            else:
                # Direct single media URL fallback
                direct_url = info.get('url')
                video_high = direct_url
                video_normal = direct_url
                audio_high = direct_url
                audio_normal = direct_url

            # Ensure fallbacks if any field is still None
            video_high = video_high or video_normal or info.get('url')
            video_normal = video_normal or video_high or info.get('url')
            audio_high = audio_high or video_high
            audio_normal = audio_normal or audio_high

            response_data = {
                "success": True,
                "type": media_type,
                "title": info.get('title', 'Social Media Video'),
                "thumbnail": info.get('thumbnail', ''),
                "duration": info.get('duration', 0),
                "video_high": video_high,
                "video_normal": video_normal,
                "audio_high": audio_high,
                "audio_normal": audio_normal
            }

            video_cache.set(resolved_url, response_data)
            logging.info(f"[EXTRACTION SUCCESS] '{response_data['title'][:40]}' successfully mapped.")
            return jsonify(response_data)

    except yt_dlp.utils.DownloadError as de:
        logging.error(f"[EXTRACTION ERROR] yt-dlp error: {str(de)}")
        return jsonify({"success": False, "error": "Could not extract video. It might be private, deleted, or require login."}), 400
    except Exception as e:
        error_msg = str(e)
        logging.error(f"[SERVER ERROR] Unexpected error: {error_msg}")
        return jsonify({"success": False, "error": "Could not process this video link. Please verify the URL and try again."}), 500

# ==========================================
# ⚡ ROUTE 2: ADVANCED STREAMING PROXY & MP3 CONVERTER ⚡
# ==========================================
ALLOWED_FILE_TYPES = {'mp4', 'mp3', 'audio', 'jpg', 'jpeg', 'png', 'webp'}

@app.route('/api/direct', methods=['GET'])
@limiter.limit("25 per minute")
def direct_download():
    file_url = request.args.get('url')
    file_type = (request.args.get('type', 'mp4') or 'mp4').lower().strip()
    quality = (request.args.get('q', 'hq') or 'hq').lower().strip()
    raw_timestamp = request.args.get('t', str(int(time.time())))
    timestamp_id = re.sub(r'[^0-9]', '', str(raw_timestamp)) or str(int(time.time()))

    # 1. Parameter allow-list validation
    if file_type not in ALLOWED_FILE_TYPES:
        return jsonify({"error": "Unsupported file type requested."}), 400

    # 2. Strict Anti-SSRF Media URL validation
    if not file_url or not is_safe_media_url(file_url):
        return jsonify({"error": "Invalid or unauthorized media stream URL."}), 400

    raw_prefix = get_platform_prefix(file_url)
    prefix = re.sub(r'[^a-zA-Z0-9_-]', '', raw_prefix) or 'Downsocial'

    # --- MP3 AUDIO EXTRACTION & CONVERSION ---
    if file_type in ['mp3', 'audio']:
        try:
            ffmpeg_bin = get_ffmpeg_path()
            bitrate = '192k' if quality == 'hq' else '128k'
            
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }

            cmd = [
                ffmpeg_bin,
                '-y',
                '-loglevel', 'error',
                '-i', 'pipe:0',
                '-vn',
                '-acodec', 'libmp3lame',
                '-b:a', bitrate,
                '-f', 'mp3',
                'pipe:1'
            ]

            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=1024 * 1024
            )

            def feed_ffmpeg():
                try:
                    upstream_req = http_session.get(file_url, stream=True, headers=headers, timeout=(5, 30))
                    for chunk in upstream_req.iter_content(chunk_size=64 * 1024):
                        if chunk:
                            try:
                                proc.stdin.write(chunk)
                                proc.stdin.flush()
                            except (BrokenPipeError, OSError):
                                break
                    upstream_req.close()
                except Exception as feed_err:
                    logging.error(f"[FFMPEG FEED ERROR] {str(feed_err)}")
                finally:
                    try:
                        proc.stdin.close()
                    except Exception:
                        pass

            feeder_thread = threading.Thread(target=feed_ffmpeg, daemon=True)
            feeder_thread.start()

            def generate_mp3_chunks():
                try:
                    while True:
                        chunk = proc.stdout.read(64 * 1024)
                        if not chunk:
                            break
                        yield chunk
                except Exception as stream_err:
                    logging.error(f"[MP3 STREAM ERROR] {str(stream_err)}")
                finally:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    try:
                        proc.stdout.close()
                        proc.stderr.close()
                    except Exception:
                        pass
                    feeder_thread.join(timeout=2)
                    logging.info("[MP3 STREAM] Finished and cleaned up FFmpeg process")

            resp_headers = {
                'Content-Disposition': f'attachment; filename="{prefix}_Audio_{timestamp_id}.mp3"',
                'Cache-Control': 'no-cache',
                'Accept-Ranges': 'none'
            }

            return Response(
                stream_with_context(generate_mp3_chunks()),
                status=200,
                content_type='audio/mpeg',
                headers=resp_headers
            )

        except Exception as e:
            logging.error(f"[MP3 CONVERSION ERROR] {str(e)}")
            return jsonify({"error": "Failed to convert audio to MP3."}), 500

    # --- STANDARD VIDEO/IMAGE STREAMING PROXY ---
    try:
        range_header = request.headers.get('Range', None)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept-Encoding': 'identity'
        }
        
        if range_header:
            headers['Range'] = range_header

        req = http_session.get(file_url, stream=True, headers=headers, timeout=(5, 30))
        
        type_tag = 'Image' if file_type in ['jpg', 'jpeg', 'png', 'webp'] else 'Video'
        resp_headers = {
            'Content-Disposition': f'attachment; filename="{prefix}_{type_tag}_{timestamp_id}.{file_type}"',
            'Accept-Ranges': 'bytes'
        }

        if 'Content-Length' in req.headers:
            resp_headers['Content-Length'] = req.headers['Content-Length']
            
        if 'Content-Range' in req.headers:
            resp_headers['Content-Range'] = req.headers['Content-Range']

        status_code = req.status_code if req.status_code in [200, 206] else 200

        def generate_chunks():
            try:
                for chunk in req.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        yield chunk
            except Exception as stream_err:
                logging.error(f"[STREAM ERROR] Connection dropped: {str(stream_err)}")
            finally:
                req.close()
                logging.info("[PROXY STREAM] Closed downstream connection")

        fallback_mime = 'image/jpeg' if file_type in ['jpg', 'jpeg'] else f'video/{file_type}'
        return Response(
            stream_with_context(generate_chunks()), 
            status=status_code,
            content_type=req.headers.get('content-type', fallback_mime),
            headers=resp_headers
        )
        
    except requests.exceptions.Timeout:
        logging.warning("[PROXY TIMEOUT] Target server took too long.")
        return jsonify({"error": "Request timed out. Target server is too slow."}), 504
    except requests.exceptions.RequestException as req_err:
        logging.error(f"[PROXY ERROR] Request failed: {str(req_err)}")
        return jsonify({"error": "Failed to connect to media server."}), 502
    except Exception as e:
        logging.error(f"[PROXY UNKNOWN ERROR] {str(e)}")
        return jsonify({"error": "An unexpected error occurred during stream."}), 500

@app.route('/', methods=['GET'])
def health_check():
    return jsonify({"status": "active", "service": "downsocial - All-in-One Video Downloader API v3.0"}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, threaded=True)
