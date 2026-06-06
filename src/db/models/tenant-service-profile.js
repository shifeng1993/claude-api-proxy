import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const TenantServiceProfile = sequelize.define('tenant_service_profiles', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    service_type: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            isIn: [['relay', 'codebuddy', 'copilot']]
        }
    },
    enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    total_api_calls: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_input_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_output_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_cache_hit_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    total_credit: {
        type: DataTypes.REAL,
        defaultValue: 0
    }
}, {
    indexes: [
        {
            unique: true,
            fields: ['tenant_id', 'service_type']
        }
    ]
});
