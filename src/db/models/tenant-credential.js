import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const TenantCredential = sequelize.define('tenant_credentials', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    bearer_token: {
        type: DataTypes.TEXT
    },
    refresh_token: {
        type: DataTypes.TEXT
    },
    token_type: {
        type: DataTypes.STRING
    },
    user_id: {
        type: DataTypes.STRING
    },
    user_email: {
        type: DataTypes.STRING
    },
    user_name: {
        type: DataTypes.STRING
    },
    base_url: {
        type: DataTypes.STRING
    },
    enterprise_id: {
        type: DataTypes.STRING
    },
    enterprise_name: {
        type: DataTypes.STRING
    },
    department_info: {
        type: DataTypes.TEXT
    },
    domain: {
        type: DataTypes.STRING
    },
    scope: {
        type: DataTypes.STRING
    },
    expires_in: {
        type: DataTypes.INTEGER
    },
    credential_created_at: {
        type: DataTypes.INTEGER
    },
    disabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    sort_order: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    }
}, {
    indexes: [
        {fields: ['tenant_id']}
    ]
});
