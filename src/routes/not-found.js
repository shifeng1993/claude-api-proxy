import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOT_FOUND_PAGE = readFileSync(join(__dirname, '..', 'templates', '404.html'), 'utf8');

export function wantsHtml(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const accept = String(req.headers.accept || '');
    return accept.includes('text/html') || accept === '' || accept === '*/*';
}

export function sendNotFoundPage(req, res) {
    res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : NOT_FOUND_PAGE);
}
