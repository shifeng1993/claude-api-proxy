import {fn, col} from 'sequelize';
import {models} from '../../db/models/index.js';

export async function getGatewayStatsTenantEntries(tenantManager) {
    if (tenantManager.registry?.tenants) {
        return Object.entries(tenantManager.registry.tenants);
    }

    const tenants = tenantManager.tenantsCache instanceof Map
        ? Array.from(tenantManager.tenantsCache.values())
        : [];

    const credentialCounts = new Map();
    if (tenants.length > 0) {
        const rows = await models.TenantCredential.findAll({
            attributes: ['tenant_id', [fn('COUNT', col('id')), 'credentialCount']],
            group: ['tenant_id'],
            raw: true
        });
        for (const row of rows) {
            credentialCounts.set(Number(row.tenant_id), parseInt(row.credentialCount, 10) || 0);
        }
    }

    return tenants.map((tenant) => {
        const codebuddyProfile = (tenant.serviceProfiles || []).find((profile) => profile.service_type === 'codebuddy') || {};
        return [
            `tenant_${tenant.id}`,
            {
                ...tenant,
                credential_count: credentialCounts.get(Number(tenant.id)) || 0,
                total_api_calls: codebuddyProfile.total_api_calls || tenant.total_api_calls || 0,
                total_input_tokens: codebuddyProfile.total_input_tokens || tenant.total_input_tokens || 0,
                total_output_tokens: codebuddyProfile.total_output_tokens || tenant.total_output_tokens || 0,
                total_cache_hit_tokens: codebuddyProfile.total_cache_hit_tokens || tenant.total_cache_hit_tokens || 0,
                total_credit: codebuddyProfile.total_credit || tenant.total_credit || 0
            }
        ];
    });
}
