import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const TenantDailyUsage = sequelize.define('tenant_daily_usage', {
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
        allowNull: false
    },
    model: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'unknown'
    },
    date: {
        type: DataTypes.STRING,
        allowNull: false
    },
    api_calls: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    input_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    input_cache_hit: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    input_cache_miss: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    output_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    credit: {
        type: DataTypes.REAL,
        defaultValue: 0
    }
}, {
    indexes: [
        {
            unique: true,
            fields: ['tenant_id', 'service_type', 'model', 'date']
        },
        {fields: ['tenant_id', 'date']},
        {fields: ['date']}
    ]
});
