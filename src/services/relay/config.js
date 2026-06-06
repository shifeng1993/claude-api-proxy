/**
 * Relay 配置
 * @module services/relay/config
 */

// API Key 前缀
export const API_KEY_PREFIX = 'sk-relay-';

// LDAP 是否启用（复用 LDAP 环境变量，单独控制 relay 的 LDAP 开关）
export const RELAY_LDAP_ENABLED = process.env.LDAP_RELAY_ENABLED !== 'false';
