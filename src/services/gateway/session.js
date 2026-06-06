/**
 * 统一 JWT 会话管理
 * 合并 services/relay/jwt-session.js 和 services/codebuddy/jwt-session.js
 * @module services/gateway/session
 */

import jwt from 'jsonwebtoken';

const COOKIE_NAME = 'cap_session';

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(pair => {
        const [key, ...rest] = pair.trim().split('=');
        if (key) cookies[key] = rest.join('=');
    });
    return cookies;
}

export function createSessionToken(username, role) {
    return jwt.sign(
        {sub: username, role: role || 'user'},
        process.env.JWT_SECRET,
        {expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256'}
    );
}

export function verifySessionToken(token) {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, {algorithms: ['HS256']});
        return {valid: true, username: decoded.sub, role: decoded.role};
    } catch {
        return {valid: false};
    }
}

export function setSessionCookie(res, token) {
    const maxAge = 7 * 24 * 60 * 60;
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

export function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0`);
}

export function getSessionUser(req) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (!token) return {authenticated: false};
    const result = verifySessionToken(token);
    if (result.valid) {
        return {authenticated: true, username: result.username, role: result.role};
    }
    return {authenticated: false};
}
