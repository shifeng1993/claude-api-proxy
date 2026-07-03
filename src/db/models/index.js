import {Tenant} from './tenant.js';
import {TenantCredential} from './tenant-credential.js';
import {TenantUpstream} from './tenant-upstream.js';
import {TenantDailyUsage} from './tenant-daily-usage.js';
import {TenantState} from './tenant-state.js';
import {TenantServiceProfile} from './tenant-service-profile.js';
import {Feedback} from './feedback.js';

// Existing associations
Tenant.hasMany(TenantCredential, {foreignKey: 'tenant_id', as: 'credentials', onDelete: 'CASCADE'});
TenantCredential.belongsTo(Tenant, {foreignKey: 'tenant_id', as: 'tenant'});

Tenant.hasMany(TenantUpstream, {foreignKey: 'tenant_id', as: 'upstreams', onDelete: 'CASCADE'});
TenantUpstream.belongsTo(Tenant, {foreignKey: 'tenant_id', as: 'tenant'});

Tenant.hasMany(TenantDailyUsage, {foreignKey: 'tenant_id', as: 'dailyUsages', onDelete: 'CASCADE'});
TenantDailyUsage.belongsTo(Tenant, {foreignKey: 'tenant_id', as: 'tenant'});

Tenant.hasOne(TenantState, {foreignKey: 'tenant_id', as: 'state', onDelete: 'CASCADE'});
TenantState.belongsTo(Tenant, {foreignKey: 'tenant_id', as: 'tenant'});

// New associations for unified auth
Tenant.hasMany(TenantServiceProfile, {foreignKey: 'tenant_id', as: 'serviceProfiles', onDelete: 'CASCADE'});
TenantServiceProfile.belongsTo(Tenant, {foreignKey: 'tenant_id', as: 'tenant'});

export const models = {
    Tenant, TenantCredential, TenantUpstream, TenantDailyUsage, TenantState,
    TenantServiceProfile,
    Feedback
};

export {Feedback};
