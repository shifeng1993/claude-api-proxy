/**
 * Local account CRUD for the unified tenant account system.
 * One local account maps to one Tenant record and shared service profiles.
 * @module services/gateway/local-user-manager
 */

import {createHash, randomBytes} from 'crypto';
import {Op} from 'sequelize';
import logger from '../../utils/logger.js';
import {models} from '../../db/models/index.js';
import {hashPassword, verifyPassword} from '../shared/local-auth.js';
import {getAuthMode} from '../shared/auth-mode.js';
import {unifiedTenantManager} from './tenant-manager.js';

const MIN_PASSWORD_LENGTH = 8;
const USERNAME_REGEX = /^[a-zA-Z0-9._-]{2,32}$/;
const ROLE_SUPERADMIN = 'superadmin';
const ROLE_ADMIN = 'admin';
const ROLE_USER = 'user';
const MANAGED_ROLES = new Set([ROLE_ADMIN, ROLE_USER]);

function canManageTarget(actorRole, targetRole) {
    if (targetRole === ROLE_SUPERADMIN) return false;
    if (actorRole === ROLE_SUPERADMIN) return targetRole === ROLE_ADMIN || targetRole === ROLE_USER;
    if (actorRole === ROLE_ADMIN) return targetRole === ROLE_USER;
    return false;
}

function canViewTarget(actorRole, targetRole) {
    if (targetRole === ROLE_SUPERADMIN) return false;
    if (actorRole === ROLE_SUPERADMIN || actorRole === ROLE_ADMIN) {
        return targetRole === ROLE_ADMIN || targetRole === ROLE_USER;
    }
    return false;
}

async function findLocalUser(username) {
    return models.Tenant.findOne({where: {username, password_hash: {[Op.ne]: null}}});
}

async function findLdapUser(username) {
    return models.Tenant.findOne({where: {username, password_hash: null}});
}

function syncLocalUserCache(username, updates) {
    const tenantId = unifiedTenantManager.findTenantByUsername(username);
    if (!tenantId) return;
    const tenant = unifiedTenantManager.getTenant(tenantId);
    if (!tenant) return;
    Object.assign(tenant, updates);
}

export async function listLocalUsers(actorRole = ROLE_ADMIN) {
    const tenants = await models.Tenant.findAll({
        where: {password_hash: {[Op.ne]: null}},
        order: [['id', 'ASC']]
    });
    return tenants
        .filter(t => canViewTarget(actorRole, t.role || ROLE_USER))
        .map(t => ({
            username: t.username,
            displayName: t.name,
            role: t.role || ROLE_USER,
            createdAt: t.created_at ? Math.floor(new Date(t.created_at).getTime() / 1000) : 0
        }));
}

export async function listLdapUsers(actorRole = ROLE_ADMIN) {
    const tenants = await models.Tenant.findAll({
        where: {password_hash: null},
        order: [['id', 'ASC']]
    });
    return tenants
        .filter(t => canViewTarget(actorRole, t.role || ROLE_USER))
        .map(t => ({
            username: t.username,
            displayName: t.name,
            role: t.role || ROLE_USER,
            source: 'ldap',
            createdAt: t.created_at ? Math.floor(new Date(t.created_at).getTime() / 1000) : 0
        }));
}

export async function listManagedUsers(actorRole = ROLE_ADMIN, authMode = getAuthMode()) {
    if (authMode === 'ldap') return listLdapUsers(actorRole);
    return listLocalUsers(actorRole);
}

export async function createLocalUser(input, actorRole = ROLE_ADMIN) {
    const {username, password, displayName} = input || {};
    const role = MANAGED_ROLES.has(input?.role) ? input.role : ROLE_USER;

    if (!username || !USERNAME_REGEX.test(username)) {
        return {ok: false, status: 400, error: '用户名必须为 2-32 字符，仅包含字母、数字、._-'};
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return {ok: false, status: 400, error: `密码至少 ${MIN_PASSWORD_LENGTH} 字符`};
    }
    if (role === ROLE_ADMIN && actorRole !== ROLE_SUPERADMIN) {
        return {ok: false, status: 403, error: '只有超级管理员可以创建管理员账号'};
    }

    const existing = await models.Tenant.findOne({where: {username}});
    if (existing) {
        return {ok: false, status: 409, error: '用户名已存在'};
    }

    const {hash, salt} = hashPassword(password);
    const {TenantServiceProfile} = await import('../../db/models/tenant-service-profile.js');

    const apiKey = 'sk-' + randomBytes(16).toString('hex');
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const body = apiKey.slice(3);
    const apiKeyPrefix = 'sk-' + body.slice(0, 8) + '****' + body.slice(-4);

    const tenant = await models.Tenant.create({
        name: displayName || username,
        username,
        api_key_hash: apiKeyHash,
        api_key_prefix: apiKeyPrefix,
        api_key_plain: apiKey,
        password_hash: hash,
        password_salt: salt,
        role
    });

    await TenantServiceProfile.bulkCreate([
        {tenant_id: tenant.id, service_type: 'relay', enabled: true},
        {tenant_id: tenant.id, service_type: 'codebuddy', enabled: true}
    ]);

    logger.info(`Created local user '${username}' role=${role} (unified tenant id=${tenant.id})`);
    return {ok: true, username, apiKey};
}

export async function resetLocalUserPassword(username, newPassword, actorRole = ROLE_ADMIN) {
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        return {ok: false, status: 400, error: `密码至少 ${MIN_PASSWORD_LENGTH} 字符`};
    }
    const target = await findLocalUser(username);
    if (!target) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }
    if (!canManageTarget(actorRole, target.role || ROLE_USER)) {
        return {ok: false, status: 403, error: '无权修改该账号'};
    }
    const {hash, salt} = hashPassword(newPassword);
    const [count] = await models.Tenant.update(
        {password_hash: hash, password_salt: salt},
        {where: {username, password_hash: {[Op.ne]: null}}}
    );
    if (count === 0) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }
    logger.info(`Reset password for local user '${username}'`);
    return {ok: true};
}

export async function changeOwnLocalUserPassword(username, currentPassword, newPassword) {
    if (username && username === process.env.LOCAL_ADMIN_USER) {
        return {ok: false, status: 403, error: 'Env configured superadmin password is managed by environment variables'};
    }
    if (!currentPassword) {
        return {ok: false, status: 400, error: '当前密码不能为空'};
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        return {ok: false, status: 400, error: `密码至少 ${MIN_PASSWORD_LENGTH} 字符`};
    }
    const target = await findLocalUser(username);
    if (!target) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }
    if (!verifyPassword(currentPassword, target.password_hash, target.password_salt)) {
        return {ok: false, status: 403, error: '当前密码不正确'};
    }
    const {hash, salt} = hashPassword(newPassword);
    const [count] = await models.Tenant.update(
        {password_hash: hash, password_salt: salt},
        {where: {username, password_hash: {[Op.ne]: null}}}
    );
    if (count === 0) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }
    logger.info(`Changed own password for local user '${username}'`);
    return {ok: true};
}

export async function updateLocalUser(username, input = {}, actorRole = ROLE_ADMIN) {
    const target = await findLocalUser(username);
    if (!target) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }

    const currentRole = target.role || ROLE_USER;
    if (!canManageTarget(actorRole, currentRole)) {
        return {ok: false, status: 403, error: '无权修改该账号'};
    }

    const requestedRole = input.role === undefined || input.role === '' ? currentRole : input.role;
    if (!MANAGED_ROLES.has(requestedRole)) {
        return {ok: false, status: 400, error: '无效的角色'};
    }
    if (requestedRole === ROLE_ADMIN && actorRole !== ROLE_SUPERADMIN) {
        return {ok: false, status: 403, error: '只有超级管理员可以授予管理员角色'};
    }

    const displayName = String(input.displayName ?? target.name ?? username).trim() || username;
    const updates = {name: displayName, role: requestedRole};
    const [count] = await models.Tenant.update(
        updates,
        {where: {username, password_hash: {[Op.ne]: null}}}
    );
    if (count === 0) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }

    syncLocalUserCache(username, updates);
    logger.info(`Updated local user '${username}' role=${requestedRole}`);
    return {ok: true};
}

export async function updateLdapUser(username, input = {}, actorRole = ROLE_ADMIN) {
    const target = await findLdapUser(username);
    if (!target) {
        return {ok: false, status: 404, error: 'LDAP user not found'};
    }

    const currentRole = target.role || ROLE_USER;
    if (!canManageTarget(actorRole, currentRole)) {
        return {ok: false, status: 403, error: 'Permission denied'};
    }

    const requestedRole = input.role === undefined || input.role === '' ? currentRole : input.role;
    if (!MANAGED_ROLES.has(requestedRole)) {
        return {ok: false, status: 400, error: 'Invalid role'};
    }
    if (requestedRole === ROLE_ADMIN && actorRole !== ROLE_SUPERADMIN) {
        return {ok: false, status: 403, error: 'Only superadmin can grant admin role'};
    }

    const displayName = String(input.displayName ?? target.name ?? username).trim() || username;
    const updates = {name: displayName, role: requestedRole};
    const [count] = await models.Tenant.update(
        updates,
        {where: {username, password_hash: null}}
    );
    if (count === 0) {
        return {ok: false, status: 404, error: 'LDAP user not found'};
    }

    syncLocalUserCache(username, updates);
    logger.info(`Updated LDAP user '${username}' role=${requestedRole}`);
    return {ok: true};
}

export async function updateManagedUser(username, input = {}, actorRole = ROLE_ADMIN, authMode = getAuthMode()) {
    if (authMode === 'ldap') return updateLdapUser(username, input, actorRole);
    return updateLocalUser(username, input, actorRole);
}

export async function deleteLocalUser(username, currentUsername, actorRole = ROLE_ADMIN) {
    if (username === currentUsername) {
        return {ok: false, status: 400, error: '不能删除自己'};
    }
    const target = await findLocalUser(username);
    if (!target) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }
    if (!canManageTarget(actorRole, target.role || ROLE_USER)) {
        return {ok: false, status: 403, error: '无权删除该账号'};
    }
    const deleted = await models.Tenant.destroy({
        where: {username, password_hash: {[Op.ne]: null}}
    });
    if (!deleted) {
        return {ok: false, status: 404, error: '本地账号不存在'};
    }
    logger.info(`Deleted local user '${username}'`);
    return {ok: true};
}

export async function deleteLdapUser(username, currentUsername, actorRole = ROLE_ADMIN) {
    if (username === currentUsername) {
        return {ok: false, status: 400, error: 'Cannot delete yourself'};
    }
    const target = await findLdapUser(username);
    if (!target) {
        return {ok: false, status: 404, error: 'LDAP user not found'};
    }
    if (!canManageTarget(actorRole, target.role || ROLE_USER)) {
        return {ok: false, status: 403, error: 'Permission denied'};
    }
    const deleted = await models.Tenant.destroy({
        where: {username, password_hash: null}
    });
    if (!deleted) {
        return {ok: false, status: 404, error: 'LDAP user not found'};
    }
    logger.info(`Deleted LDAP user '${username}'`);
    return {ok: true};
}

export async function deleteManagedUser(username, currentUsername, actorRole = ROLE_ADMIN, authMode = getAuthMode()) {
    if (authMode === 'ldap') return deleteLdapUser(username, currentUsername, actorRole);
    return deleteLocalUser(username, currentUsername, actorRole);
}
