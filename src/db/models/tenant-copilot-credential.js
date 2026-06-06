import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const TenantCopilotCredential = sequelize.define('tenant_copilot_credentials', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    github_token: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    copilot_token: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    copilot_token_expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    github_user: {
        type: DataTypes.STRING,
        allowNull: true
    },
    avatar_url: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    proxy: {
        type: DataTypes.STRING,
        allowNull: true
    },
    skip_tls_verify: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    account_type: {
        type: DataTypes.STRING,
        defaultValue: 'individual',
        validate: {
            isIn: [['individual', 'business', 'enterprise']]
        }
    },
    vscode_version: {
        type: DataTypes.STRING,
        defaultValue: '1.109.2'
    },
    enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    sort_order: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    }
}, {
    indexes: [
        {fields: ['tenant_id']},
        {fields: ['tenant_id', 'enabled']},
        {fields: ['tenant_id', 'is_active']}
    ]
});
